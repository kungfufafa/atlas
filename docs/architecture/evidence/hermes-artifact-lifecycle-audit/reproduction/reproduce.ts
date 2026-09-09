import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { extractSessionArtifacts } from "/Users/apriansyahrs/Documents/Code/atlas/packages/core/src/channel-artifacts.ts";
import type {
  ChatMessage,
  ToolContext,
  ToolDefinition,
} from "/Users/apriansyahrs/Documents/Code/atlas/packages/core/src/contract.ts";
import { buildToolExecutionContext } from "/Users/apriansyahrs/Documents/Code/atlas/packages/core/src/tools/context.ts";
import { executeProtectedTool } from "/Users/apriansyahrs/Documents/Code/atlas/packages/core/src/tools/execution.ts";

const evidenceRoot = "/private/tmp/atlas-artifact-attribution-audit";
const repository = "/Users/apriansyahrs/Documents/Code/atlas";
const sourcePaths = [
  "packages/core/src/tools/context.ts",
  "packages/core/src/tools/execution.ts",
  "packages/core/src/tools/execution-contract.ts",
  "packages/core/src/channel-artifacts.ts",
  "packages/agent/src/tool-loop.ts",
  "packages/agent/src/chat.ts",
  "apps/server/src/http/workspace-worker-artifacts.ts",
  "apps/server/src/tools/python-execute-tool.ts",
  "apps/server/src/services/agent-service.ts",
  "apps/server/src/services/task-runner.ts",
];

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sourceHashes() {
  return await Promise.all(
    sourcePaths.map(async (relativePath) => {
      const path = join(repository, relativePath);
      return { path, sha256: sha256(await readFile(path)) };
    })
  );
}

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Mode = "serial" | "concurrent_two_writers" | "concurrent_no_write_a";
type Effect = {
  sequence: number;
  event: string;
  sessionId: string;
  userId: string;
  path?: string;
  bytes?: number;
  sha256?: string;
};
const payloads = {
  A: "Report A: apples = 3.\n",
  B: "Report B: oranges = 7.\n",
};
const startedAt = new Date().toISOString();
const startedClock = performance.now();
const sourceBefore = await sourceHashes();
const executionRoot = await mkdtemp(join(evidenceRoot, "run-"));
const scenarios: unknown[] = [];

try {
  for (const mode of [
    "serial",
    "concurrent_two_writers",
    "concurrent_no_write_a",
  ] as const) {
    const workspaceRoot = join(executionRoot, mode, "profile-workspace");
    await mkdir(join(workspaceRoot, "artifacts"), { recursive: true });
    const effects: Effect[] = [];
    const enteredA = barrier();
    const releaseA = barrier();
    const calls = { A: 0, B: 0 };
    const contexts = Object.fromEntries(
      (["A", "B"] as const).map((actor) => [
        actor,
        buildToolExecutionContext({
          orgId: "audit-organization",
          orgRole: "member",
          profileId: "audit-shared-profile",
          sessionId: `audit-session-${actor}`,
          userId: `audit-user-${actor}`,
          workspaceRoot,
        }),
      ])
    ) as Record<"A" | "B", ToolContext>;
    const record = (
      event: string,
      context: ToolContext,
      detail: Partial<Effect> = {}
    ) => {
      effects.push({
        event,
        sequence: effects.length + 1,
        sessionId: context.sessionId!,
        userId: context.userId!,
        ...detail,
      });
    };
    const tool: ToolDefinition<
      { actor: "A" | "B" },
      {
        producerSessionId: string;
        producerUserId: string;
        writtenPath: string | null;
      }
    > = {
      description:
        "Controlled local document operation; all effects are recorded by the fixture.",
      name: "audit_document_operation",
      parameters: {
        additionalProperties: false,
        properties: { actor: { enum: ["A", "B"], type: "string" } },
        required: ["actor"],
        type: "object",
      },
      async run({ actor }, context) {
        calls[actor] += 1;
        assert.equal(context.sessionId, contexts[actor].sessionId);
        record("tool_entered_after_protected_before_snapshot", context);
        if (actor === "A" && mode !== "serial") {
          enteredA.resolve();
          await releaseA.promise;
        }
        const writes = !(actor === "A" && mode === "concurrent_no_write_a");
        const writtenPath = writes
          ? `artifacts/${actor.toLowerCase()}.txt`
          : null;
        if (writtenPath) {
          await writeFile(join(workspaceRoot, writtenPath), payloads[actor], {
            flag: "wx",
          });
          record("file_written", context, {
            bytes: Buffer.byteLength(payloads[actor]),
            path: writtenPath,
            sha256: sha256(payloads[actor]),
          });
        }
        record("tool_returned_no_declared_artifact_references", context);
        return {
          producerSessionId: context.sessionId!,
          producerUserId: context.userId!,
          writtenPath,
        };
      },
    };

    async function invoke(actor: "A" | "B") {
      record("protected_call_started", contexts[actor]);
      const execution = await executeProtectedTool(
        tool,
        { actor },
        contexts[actor]
      );
      record("protected_call_resolved", contexts[actor]);
      assert.equal(execution.success, true);
      assert.equal(execution.metadata?.retries, 0);
      assert.equal(
        execution.data?.producerSessionId,
        contexts[actor].sessionId
      );
      return execution;
    }

    const resultA = invoke("A");
    let executionA: Awaited<ReturnType<typeof invoke>>;
    let executionB: Awaited<ReturnType<typeof invoke>>;
    if (mode === "serial") {
      executionA = await resultA;
      executionB = await invoke("B");
    } else {
      await enteredA.promise;
      executionB = await invoke("B");
      releaseA.resolve();
      executionA = await resultA;
    }
    assert.deepEqual(calls, { A: 1, B: 1 });
    const artifactsA = executionA.artifacts ?? [];
    const artifactsB = executionB.artifacts ?? [];
    const pathsA = artifactsA.map((artifact) => artifact.path).sort();
    const pathsB = artifactsB.map((artifact) => artifact.path).sort();
    const expectedPathsA =
      mode === "serial"
        ? ["artifacts/a.txt"]
        : mode === "concurrent_two_writers"
          ? ["artifacts/a.txt", "artifacts/b.txt"]
          : ["artifacts/b.txt"];
    // These assertions establish the current counterexample, not the desired product invariant.
    assert.deepEqual(pathsA, expectedPathsA);
    assert.deepEqual(pathsB, ["artifacts/b.txt"]);
    for (const artifact of artifactsA) {
      assert.equal(artifact.sessionId, "audit-session-A");
    }
    for (const artifact of artifactsB) {
      assert.equal(artifact.sessionId, "audit-session-B");
    }

    // Reconstruct exactly the object merge performed by tool-loop.ts:87–105.
    // This is extractor-level evidence, not a claim that an HTTP worker route or DB persistence ran.
    const historyA: ChatMessage[] = [
      {
        content: JSON.stringify({
          ...executionA.data,
          ...(artifactsA.length ? { artifacts: artifactsA } : {}),
        }),
        name: tool.name,
        role: "tool",
        toolCallId: "audit-call-A",
      },
    ];
    const historyB: ChatMessage[] = [
      {
        content: JSON.stringify({
          ...executionB.data,
          ...(artifactsB.length ? { artifacts: artifactsB } : {}),
        }),
        name: tool.name,
        role: "tool",
        toolCallId: "audit-call-B",
      },
    ];
    const sessionArtifactsA = extractSessionArtifacts(historyA);
    const sessionArtifactsB = extractSessionArtifacts(historyB);
    assert.deepEqual(
      sessionArtifactsA.map((artifact) => artifact.path).sort(),
      expectedPathsA.map((path) => path.replace("artifacts/", ""))
    );
    assert.deepEqual(
      sessionArtifactsB.map((artifact) => artifact.path),
      ["b.txt"]
    );

    const files = await Promise.all(
      (await readdir(join(workspaceRoot, "artifacts")))
        .sort()
        .map(async (filename) => {
          const path = `artifacts/${filename}`;
          const bytes = await readFile(join(workspaceRoot, path));
          const writer = filename === "a.txt" ? "A" : "B";
          assert.equal(bytes.toString("utf8"), payloads[writer]);
          assert.equal(
            effects.filter(
              (effect) =>
                effect.event === "file_written" && effect.path === path
            ).length,
            1
          );
          return {
            actualProducerSessionId: contexts[writer].sessionId,
            bytes: bytes.byteLength,
            content: bytes.toString("utf8"),
            filename,
            path,
            sha256: sha256(bytes),
          };
        })
    );
    const misplaced = artifactsA.filter(
      (artifact) => artifact.path === "artifacts/b.txt"
    );
    scenarios.push({
      calls,
      contexts,
      crossSessionAttributionObserved: misplaced.length > 0,
      effects,
      executionA,
      executionB,
      files,
      historyA,
      historyB,
      mode,
      sessionArtifactsA,
      sessionArtifactsB,
      workspaceRoot,
    });
  }

  const sourceAfter = await sourceHashes();
  assert.deepEqual(sourceAfter, sourceBefore);
  const evidence = {
    completedAt: new Date().toISOString(),
    declaredCandidateSourceSha256:
      "538c98b4f872e57e6c47d08fde1cd45cb3e591aa8462abde93fb3ec57e38bc74",
    elapsedMs: performance.now() - startedClock,
    executionRoot,
    limitations: [
      "Synthetic trusted contexts are distinct sessions/users of one shared profile, not full authenticated HTTP sessions.",
      "Actual protected executor and session artifact extractor ran; reconstructed history follows the production tool-result merge. No database/worker delivery route was exercised.",
      "The fixture serially controls two overlapping async calls in one process. Multiprocess behavior and real tool scheduling were not measured.",
      "No production fix, performance comparison, or benchmark score change is included.",
    ],
    nativeModelCalls: 0,
    productionCandidate: "candidate3",
    providerCalls: 0,
    repository,
    result: "counterexample_confirmed",
    scenarios,
    schemaVersion: 1,
    selectedSourceUnchanged: true,
    sourceAfter,
    sourceBefore,
    startedAt,
    toolCalls: 6,
    toolRetries: 0,
  };
  const output = join(executionRoot, "evidence.json");
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, {
    flag: "wx",
  });
  await writeFile(
    join(evidenceRoot, "latest.json"),
    `${JSON.stringify({ elapsedMs: evidence.elapsedMs, evidenceSha256: sha256(await readFile(output)), executionRoot, output, result: evidence.result }, null, 2)}\n`
  );
  process.stdout.write(
    `${JSON.stringify({ elapsedMs: evidence.elapsedMs, output, providerCalls: 0, result: evidence.result, scenarios: 3, sourceUnchanged: true, toolCalls: 6 })}\n`
  );
} catch (error) {
  await writeFile(
    join(executionRoot, "failure.json"),
    `${JSON.stringify({ message: error instanceof Error ? error.message : String(error), scenarios, stack: error instanceof Error ? error.stack : null }, null, 2)}\n`
  );
  throw error;
}
