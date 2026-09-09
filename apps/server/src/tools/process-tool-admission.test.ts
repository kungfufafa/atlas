import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolContext } from "@atlas/core";
import {
  createInMemoryDatabaseAdapter,
  type StoredToolRecord,
} from "@atlas/db";
import type { ProcessToolAdmissionPolicy } from "../services/process-tool-admission";
import type { RestrictedProcessLaunchEvidence } from "../services/restricted-process";
import { resolveToolsFromStorage } from "../services/tool-resolver";
import { createBashRunner, runBash } from "./bash";
import { createPythonExecutor, runPythonExecute } from "./python-execute-tool";

type Runner = (input: unknown, context: ToolContext) => Promise<unknown>;

const cases: {
  create: (policy: ProcessToolAdmissionPolicy) => Runner;
  input: Record<string, unknown>;
  legacy: Runner;
  name: "bash" | "python_execute";
}[] = [
  {
    create: createBashRunner,
    input: { command: "printf executed > admitted.txt; printf executed" },
    legacy: runBash,
    name: "bash",
  },
  {
    create: createPythonExecutor,
    input: {
      code: "from pathlib import Path\nPath('admitted.txt').write_text('executed')\nprint('executed')",
    },
    legacy: runPythonExecute,
    name: "python_execute",
  },
];

async function withWorkspace(
  run: (
    context: ToolContext & { workspaceRoot: string },
    output: string
  ) => Promise<void>
): Promise<void> {
  const workspaceRoot = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "atlas-process-admission-caller-"))
  );
  try {
    await run(
      { orgId: "org", profileId: "profile", workspaceRoot },
      path.join(workspaceRoot, "admitted.txt")
    );
  } finally {
    await rm(workspaceRoot, { force: true, recursive: true });
  }
}

function record(name: "bash" | "python_execute"): StoredToolRecord {
  return {
    createdAt: "2026-09-07T00:00:00.000Z",
    description: name,
    handlerConfig: { processAdmission: { requireAdmission: false } },
    handlerType: name,
    id: `admission_${name}`,
    name,
    updatedAt: "2026-09-07T00:00:00.000Z",
  };
}

for (const example of cases) {
  test(`${example.name}: legacy execution is a real positive control`, async () => {
    await withWorkspace(async (context, output) => {
      const result = await example.legacy(example.input, context);
      expect(result).toMatchObject({ exitCode: 0 });
      expect(await readFile(output, "utf8")).toBe("executed");
    });
  });

  test(`${example.name}: required missing policy remains captured and prevents startup`, async () => {
    await withWorkspace(async (context, output) => {
      const policy = { requireAdmission: true };
      const run = example.create(policy);
      policy.requireAdmission = false;
      await expect(run(example.input, context)).rejects.toThrow();
      expect(existsSync(output)).toBe(false);
    });
  });

  test(`${example.name}: asynchronous denial blocks the actual child and cleans its prepared temp`, async () => {
    await withWorkspace(async (context, output) => {
      const entered = Promise.withResolvers<RestrictedProcessLaunchEvidence>();
      const decision = Promise.withResolvers<void>();
      const denied = new Error("policy denied");
      const policy = {
        async authorize(
          evidence: RestrictedProcessLaunchEvidence
        ): Promise<void> {
          entered.resolve(evidence);
          await decision.promise;
          throw denied;
        },
        requireAdmission: true,
      };
      const run = example.create(policy);
      policy.authorize = async () => {};
      const result = run(example.input, context).then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      );
      try {
        const evidence = await entered.promise;
        expect(evidence.workspaceRoot.path).toBe(context.workspaceRoot);
        expect(evidence.launchPolicy).toBe("standard");
        expect(existsSync(evidence.temporaryRoot.path)).toBe(true);
        expect(existsSync(output)).toBe(false);
        expect(Object.isFrozen(evidence)).toBe(true);
        decision.resolve();
        expect(await result).toEqual({ error: denied });
        expect(existsSync(output)).toBe(false);
        expect(existsSync(evidence.temporaryRoot.path)).toBe(false);
      } finally {
        decision.resolve();
        await result;
      }
    });
  });

  test(`${example.name}: approval releases the exact pending invocation`, async () => {
    await withWorkspace(async (context, output) => {
      const entered = Promise.withResolvers<RestrictedProcessLaunchEvidence>();
      const decision = Promise.withResolvers<void>();
      const run = example.create({
        async authorize(evidence) {
          entered.resolve(evidence);
          await decision.promise;
        },
        requireAdmission: true,
      });
      const result = run(example.input, context);
      try {
        const evidence = await entered.promise;
        expect(existsSync(output)).toBe(false);
        expect(
          evidence.grants.some(
            (grant) =>
              grant.identity.path === context.workspaceRoot &&
              grant.kind === "read_write_subtree"
          )
        ).toBe(true);
        decision.resolve();
        expect(await result).toMatchObject({ exitCode: 0 });
        expect(await readFile(output, "utf8")).toBe("executed");
        expect(existsSync(evidence.temporaryRoot.path)).toBe(false);
      } finally {
        decision.resolve();
        await result;
      }
    });
  });

  test(`${example.name}: cancellation while policy is pending cannot launch after approval`, async () => {
    await withWorkspace(async (context, output) => {
      const controller = new AbortController();
      const entered = Promise.withResolvers<RestrictedProcessLaunchEvidence>();
      const decision = Promise.withResolvers<void>();
      const run = example.create({
        async authorize(evidence) {
          entered.resolve(evidence);
          await decision.promise;
        },
        requireAdmission: true,
      });
      const result = run(example.input, {
        ...context,
        signal: controller.signal,
      }).then(
        () => "completed",
        () => "rejected"
      );
      try {
        const evidence = await entered.promise;
        controller.abort();
        decision.resolve();
        expect(await result).toBe("rejected");
        expect(existsSync(output)).toBe(false);
        expect(existsSync(evidence.temporaryRoot.path)).toBe(false);
      } finally {
        decision.resolve();
        await result;
      }
    });
  });

  for (const withDatabase of [false, true]) {
    test(`${example.name}: stored resolver ${withDatabase ? "with" : "without"} database preserves host denial`, async () => {
      await withWorkspace(async (context, output) => {
        const denied = new Error("resolver policy denied");
        let decisions = 0;
        const policy = {
          async authorize(): Promise<void> {
            decisions += 1;
            throw denied;
          },
          requireAdmission: true,
        };
        const tools = await resolveToolsFromStorage(
          [record(example.name)],
          withDatabase ? createInMemoryDatabaseAdapter() : undefined,
          [],
          { processAdmission: policy }
        );
        policy.authorize = async () => {};
        expect(tools).toHaveLength(1);
        const tool = tools[0];
        expect(tool).toBeDefined();
        await expect(tool!.run(example.input, context)).rejects.toBe(denied);
        expect(decisions).toBe(1);
        expect(existsSync(output)).toBe(false);
      });
    });
  }

  test(`${example.name}: one shared factory keeps concurrent workspaces separate`, async () => {
    await withWorkspace(async (allowed, allowedOutput) => {
      await withWorkspace(async (denied, deniedOutput) => {
        const decisions: RestrictedProcessLaunchEvidence[] = [];
        const run = example.create({
          async authorize(evidence) {
            decisions.push(evidence);
            if (evidence.workspaceRoot.path !== allowed.workspaceRoot) {
              throw new Error("wrong workspace");
            }
          },
          requireAdmission: true,
        });
        const results = await Promise.allSettled([
          run(example.input, allowed),
          run(example.input, denied),
        ]);
        expect(results[0]?.status).toBe("fulfilled");
        expect(results[1]?.status).toBe("rejected");
        expect(await readFile(allowedOutput, "utf8")).toBe("executed");
        expect(existsSync(deniedOutput)).toBe(false);
        expect(decisions).toHaveLength(2);
        expect(
          new Set(decisions.map((evidence) => evidence.launchId)).size
        ).toBe(2);
        expect(
          new Set(decisions.map((evidence) => evidence.temporaryRoot.path)).size
        ).toBe(2);
      });
    });
  });
}

for (const approve of [false, true]) {
  test(`coding-agent Bash enrichment ${approve ? "executes after approval" : "cannot bypass denial"}`, async () => {
    await withWorkspace(async (context, output) => {
      const db = createInMemoryDatabaseAdapter();
      await db.upsertWorkspaceSettings({
        codingAgentHarnesses: [
          {
            args: [],
            command: "echo",
            enabled: true,
            id: "admission-echo-harness",
            kind: "claude_code",
            name: "Synthetic echo harness",
          },
        ],
        codingAgentProviderPassthrough: true,
        id: "workspace-settings",
        imageModel: null,
        selectedCodingAgentHarness: null,
        transcriptionModel: null,
        updatedAt: "2026-09-07T00:00:00.000Z",
        visionModel: null,
      });
      const credential = "synthetic-process-admission-credential";
      const evidence: RestrictedProcessLaunchEvidence[] = [];
      const tools = await resolveToolsFromStorage([record("bash")], db, [], {
        processAdmission: {
          async authorize(prepared) {
            evidence.push(prepared);
            if (!approve) {
              throw new Error("coding-agent execution denied");
            }
          },
          requireAdmission: true,
        },
        userConfig: {
          defaultProviderId: "synthetic-provider",
          providers: [
            {
              apiKey: credential,
              createdAt: "2026-09-07T00:00:00.000Z",
              id: "synthetic-provider",
              label: "Synthetic provider",
              type: "anthropic",
            },
          ],
        },
      });
      expect(tools).toHaveLength(1);
      const result = tools[0]!.run(
        {
          command: 'echo "$ANTHROPIC_API_KEY" > admitted.txt',
          env: { ANTHROPIC_API_KEY: "caller-replacement" },
        },
        context
      );
      if (approve) {
        expect(await result).toMatchObject({ exitCode: 0 });
        expect(await readFile(output, "utf8")).toBe(`${credential}\n`);
      } else {
        await expect(result).rejects.toThrow();
        expect(existsSync(output)).toBe(false);
      }
      expect(evidence).toHaveLength(1);
      expect(JSON.stringify(evidence)).not.toContain(credential);
      expect(existsSync(evidence[0]!.temporaryRoot.path)).toBe(false);
    });
  });
}
