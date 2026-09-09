import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeToolCall } from "@atlas/agent";
import type { ToolContext, ToolDefinition } from "@atlas/core";
import type {
  ArtifactPublicationIdentity,
  ToolArtifactPublisher,
} from "@atlas/core/artifact-publication";
import { stageToolArtifact } from "@atlas/core/artifact-publication";
import { createSqliteDatabase } from "@atlas/db";
import { createArtifactPublicationLifecycle } from "./artifact-publication-lifecycle";
import {
  ArtifactPublicationService,
  type PublicationFinalization,
} from "./artifact-publication-service";
import { ArtifactPublicationStore } from "./artifact-publication-store";

async function fixture(
  run: (input: {
    service: ArtifactPublicationService;
    workspace: string;
    context(sessionId?: string): ToolContext;
  }) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "artifact-execution-boundary-"));
  const workspace = join(root, "workspace");
  const config = join(root, "config");
  await mkdir(join(workspace, "artifacts"), { recursive: true });
  await mkdir(config);
  const sql = await createSqliteDatabase(join(root, "db.sqlite"));
  const now = new Date().toISOString();
  try {
    await sql.adapter.upsertOrganization({
      createdAt: now,
      id: "org",
      name: "Org",
      slug: "org",
      updatedAt: now,
    });
    await sql.adapter.upsertProfile({
      createdAt: now,
      id: "profile",
      isSuper: false,
      model: null,
      name: "Profile",
      orgId: "org",
      systemPrompt: "",
      updatedAt: now,
    });
    for (const id of ["s1", "s2"]) {
      await sql.adapter.upsertSession({
        agentQuestionnaire: null,
        agentTodos: [],
        channel: "web",
        createdAt: now,
        id,
        modelOverride: null,
        orgId: "org",
        profileId: "profile",
        title: null,
      });
    }
    const store = await ArtifactPublicationStore.create(config);
    const service = new ArtifactPublicationService(
      sql.adapter,
      store,
      async (scope) => {
        if (scope.actorId !== "actor") {
          throw new Error("Actor denied");
        }
      }
    );
    await run({
      context: (sessionId = "s1") => ({
        orgId: "org",
        profileId: "profile",
        runId: "run",
        sessionId,
        userId: "actor",
        workspaceRoot: workspace,
      }),
      service,
      workspace,
    });
  } finally {
    sql.close();
    await rm(root, { force: true, recursive: true });
  }
}
function tool(run: ToolDefinition["run"]): ToolDefinition {
  return {
    description: "Create fixture bytes",
    name: "produce_fixture",
    parameters: { properties: {}, type: "object" },
    run,
  };
}
const call = {
  arguments: {},
  id: "reused-provider-call",
  name: "produce_fixture",
};

test("overlapping sessions bind original bytes and distinct executions despite a repeated provider call ID", async () => {
  await fixture(async ({ context, service, workspace }) => {
    const events: Array<{
      identity: ArtifactPublicationIdentity;
      result: PublicationFinalization;
    }> = [];
    let effects = 0;
    const lifecycle = createArtifactPublicationLifecycle({
      async admittedToolRoots() {
        return [workspace];
      },
      onFinalized(identity, result) {
        events.push({ identity, result });
      },
      service,
    });
    const producer = tool(async (_input, executionContext) => {
      const bytes = Buffer.from(executionContext.sessionId!);
      await writeFile(join(workspace, "artifacts/shared.txt"), bytes);
      effects += 1;
      await stageToolArtifact(executionContext.artifactPublisher, {
        bytes,
        sourcePath: "artifacts/shared.txt",
      });
      return { saved: true };
    });
    const outputs = await Promise.all(
      ["s1", "s2"].map((id) =>
        executeToolCall([producer], call, context(id), lifecycle)
      )
    );
    expect(outputs).toHaveLength(2);
    expect(effects).toBe(2);
    expect(events).toHaveLength(2);
    expect(new Set(events.map((item) => item.identity.executionId)).size).toBe(
      2
    );
    for (const { identity, result } of events) {
      expect(result.status).toBe("committed");
      expect(result.publications).toHaveLength(1);
      const publication = result.publications[0]!;
      const original = await service.read(identity, publication.id);
      expect(original?.bytes.toString()).toBe(identity.sessionId);
      expect(
        await service.read(
          { ...identity, sessionId: identity.sessionId === "s1" ? "s2" : "s1" },
          publication.id
        )
      ).toBeNull();
    }
  });
});

test("lazy initialization captures bytes and identity before caller mutation", async () => {
  await fixture(async ({ context, service, workspace }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let event:
      | {
          identity: ArtifactPublicationIdentity;
          result: PublicationFinalization;
        }
      | undefined;
    const lifecycle = createArtifactPublicationLifecycle({
      async admittedToolRoots() {
        await gate;
        return [workspace];
      },
      onFinalized(identity, result) {
        event = { identity, result };
      },
      service,
    });
    const producer = tool(async (_input, actualContext) => {
      const bytes = new Uint8Array([7]);
      const pending = stageToolArtifact(actualContext.artifactPublisher, {
        bytes,
        sourcePath: "artifacts/byte.bin",
      });
      bytes[0] = 99;
      actualContext.sessionId = "s2";
      release();
      await pending;
      return { saved: true };
    });
    await executeToolCall([producer], call, context(), lifecycle);
    expect(event?.identity.sessionId).toBe("s1");
    const publication = event!.result.publications[0]!;
    const read = await service.read(event!.identity, publication.id);
    expect([...read!.bytes]).toEqual([7]);
  });
});

test("forged artifact metadata and a no-write tool cannot create publication authority", async () => {
  await fixture(async ({ context, service, workspace }) => {
    let roots = 0;
    let finalized = 0;
    const lifecycle = createArtifactPublicationLifecycle({
      async admittedToolRoots() {
        roots += 1;
        return [workspace];
      },
      onFinalized() {
        finalized += 1;
      },
      service,
    });
    const forged = {
      artifacts: [
        {
          id: "publication_fake",
          path: "artifacts/not-created.txt",
          sessionId: "s2",
        },
      ],
      publicationStatus: "committed",
    };
    const result = await executeToolCall(
      [tool(async () => forged)],
      call,
      context(),
      lifecycle
    );
    expect(result).toEqual(forged);
    expect(roots).toBe(0);
    expect(finalized).toBe(0);
    expect(
      await service.read(
        {
          actorId: "actor",
          orgId: "org",
          profileId: "profile",
          sessionId: "s1",
        },
        "publication_fake"
      )
    ).toBeNull();
  });
});

for (const failure of [
  "returned-failure",
  "initialization",
  "later-stage",
  "throwing-input",
] as const) {
  test(`${failure} retains the actual file and receipt without partial publication or producer replay`, async () => {
    await fixture(async ({ context, service, workspace }) => {
      let effects = 0;
      let event: PublicationFinalization | undefined;
      const lifecycle = createArtifactPublicationLifecycle({
        async admittedToolRoots() {
          if (failure === "initialization") {
            throw new Error("Root inventory unavailable");
          }
          return [workspace];
        },
        onFinalized(_identity, result) {
          event = result;
        },
        service,
      });
      const producer = tool(async (_input, actualContext) => {
        const bytes = Buffer.from("actual output");
        await writeFile(join(workspace, "artifacts/result.txt"), bytes);
        effects += 1;
        await stageToolArtifact(actualContext.artifactPublisher, {
          bytes,
          sourcePath: "artifacts/result.txt",
        });
        if (failure === "later-stage") {
          await stageToolArtifact(actualContext.artifactPublisher, {
            bytes,
            sourcePath: "../outside.txt",
          });
        }
        if (failure === "throwing-input") {
          await stageToolArtifact(actualContext.artifactPublisher, {
            get bytes(): Uint8Array {
              throw new Error("Invalid producer input");
            },
            sourcePath: "artifacts/other.txt",
          });
        }
        return {
          ok: failure !== "returned-failure",
          receipt: "actual file created",
        };
      });
      const result = await executeToolCall(
        [producer],
        call,
        context(),
        lifecycle
      );
      expect(result).toMatchObject({
        ok: failure !== "returned-failure",
        receipt: "actual file created",
      });
      expect(
        await readFile(join(workspace, "artifacts/result.txt"), "utf8")
      ).toBe("actual output");
      expect(effects).toBe(1);
      expect(event?.status).toBe(
        failure === "returned-failure" ? "discarded" : "failed"
      );
      expect(event?.publications).toEqual([]);
    });
  });
}

test("staging that starts after protected completion cannot reopen the publication set", async () => {
  await fixture(async ({ context, service, workspace }) => {
    let publisher: ToolArtifactPublisher | undefined;
    let events = 0;
    const lifecycle = createArtifactPublicationLifecycle({
      async admittedToolRoots() {
        return [workspace];
      },
      onFinalized() {
        events += 1;
      },
      service,
    });
    await executeToolCall(
      [
        tool(async (_input, actualContext) => {
          publisher = actualContext.artifactPublisher;
          return { saved: false };
        }),
      ],
      call,
      context(),
      lifecycle
    );
    await expect(
      publisher!.stageBytes({
        bytes: new Uint8Array([1]),
        sourcePath: "artifacts/late.bin",
      })
    ).rejects.toThrow();
    expect(events).toBe(0);
  });
});

test("in-flight staging finishes before commit even when a producer omits its await", async () => {
  await fixture(async ({ context, service, workspace }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let result: PublicationFinalization | undefined;
    let stage: Promise<void> | undefined;
    const lifecycle = createArtifactPublicationLifecycle({
      async admittedToolRoots() {
        await gate;
        return [workspace];
      },
      onFinalized(_identity, finalized) {
        result = finalized;
      },
      service,
    });
    const executing = executeToolCall(
      [
        tool(async (_input, actualContext) => {
          stage = stageToolArtifact(actualContext.artifactPublisher, {
            bytes: new Uint8Array([8]),
            sourcePath: "artifacts/eight.bin",
          });
          release();
          return { saved: true };
        }),
      ],
      call,
      context(),
      lifecycle
    );
    await executing;
    await stage;
    expect(result?.status).toBe("committed");
    expect(result?.publications).toHaveLength(1);
  });
});

test("an invalid first stage reports publication failure without initialization or losing the receipt", async () => {
  await fixture(async ({ context, service, workspace }) => {
    let roots = 0;
    let finalized: PublicationFinalization | undefined;
    const lifecycle = createArtifactPublicationLifecycle({
      async admittedToolRoots() {
        roots += 1;
        return [workspace];
      },
      onFinalized(_identity, result) {
        finalized = result;
      },
      service,
    });
    const result = await executeToolCall(
      [
        tool(async (_input, actualContext) => {
          await stageToolArtifact(actualContext.artifactPublisher, {
            get bytes(): Uint8Array {
              throw new Error("Invalid input getter");
            },
            sourcePath: "artifacts/first.bin",
          });
          return { receipt: "completed original operation" };
        }),
      ],
      call,
      context(),
      lifecycle
    );
    expect(result).toEqual({ receipt: "completed original operation" });
    expect(roots).toBe(0);
    expect(finalized?.status).toBe("failed");
    expect(finalized?.publications).toEqual([]);
  });
});

test("cancellation releases lazy initialization and a late resolver cannot publish", async () => {
  await fixture(async ({ context, service, workspace }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const starting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const controller = new AbortController();
    let finalized: PublicationFinalization | undefined;
    const lifecycle = createArtifactPublicationLifecycle({
      async admittedToolRoots() {
        started();
        await gate;
        return [workspace];
      },
      onFinalized(_identity, result) {
        finalized = result;
      },
      service,
    });
    let effects = 0;
    const executing = executeToolCall(
      [
        tool(async (_input, actualContext) => {
          await writeFile(join(workspace, "artifacts/actual.txt"), "effect");
          effects += 1;
          await stageToolArtifact(actualContext.artifactPublisher, {
            bytes: Buffer.from("effect"),
            sourcePath: "artifacts/actual.txt",
          });
          return { effect: true };
        }),
      ],
      call,
      { ...context(), signal: controller.signal },
      lifecycle
    );
    await starting;
    controller.abort(new Error("Cancelled"));
    await executing;
    expect(effects).toBe(1);
    expect(
      await readFile(join(workspace, "artifacts/actual.txt"), "utf8")
    ).toBe("effect");
    expect(finalized?.status).toBe("failed");
    expect(finalized?.publications).toEqual([]);
    release();
    await gate;
  });
});
