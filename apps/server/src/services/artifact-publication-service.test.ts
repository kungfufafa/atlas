import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactPublicationIdentity } from "@atlas/core/artifact-publication";
import {
  createInMemoryDatabaseAdapter,
  createSqliteDatabase,
  type DatabaseAdapter,
} from "@atlas/db";
import { ArtifactPublicationService } from "./artifact-publication-service";
import { ArtifactPublicationStore } from "./artifact-publication-store";

const now = "2026-01-01T00:00:00.000Z";
function identity(
  sessionId = "s1",
  executionId = randomUUID()
): ArtifactPublicationIdentity {
  return {
    actorId: "actor",
    executionId,
    orgId: "org",
    profileId: "profile",
    runId: "run",
    sessionId,
    toolCallId: "call",
  };
}
async function seed(db: DatabaseAdapter): Promise<void> {
  await db.upsertOrganization({
    createdAt: now,
    id: "org",
    name: "Org",
    slug: "org",
    updatedAt: now,
  });
  await db.upsertProfile({
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
    await db.upsertSession({
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
}
async function fixture(
  kind: "sqlite" | "memory",
  run: (context: {
    db: DatabaseAdapter;
    service: ArtifactPublicationService;
    store: ArtifactPublicationStore;
    root: string;
    workspace: string;
    authorize: () => void;
    deny: () => void;
  }) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "publication-foundation-"));
  const workspace = join(root, "workspace");
  const config = join(root, "config");
  await mkdir(workspace);
  await mkdir(config);
  await mkdir(join(workspace, "artifacts"));
  const sql =
    kind === "sqlite"
      ? await createSqliteDatabase(join(root, "state.sqlite"))
      : null;
  const db = sql?.adapter ?? createInMemoryDatabaseAdapter();
  await seed(db);
  const store = await ArtifactPublicationStore.create(config);
  let authorized = true;
  const service = new ArtifactPublicationService(db, store, async (scope) => {
    if (!authorized || scope.actorId !== "actor") {
      throw new Error("Access denied");
    }
  });
  try {
    await run({
      authorize: () => {
        authorized = true;
      },
      db,
      deny: () => {
        authorized = false;
      },
      root,
      service,
      store,
      workspace,
    });
  } finally {
    sql?.close();
    await rm(root, { force: true, recursive: true });
  }
}
async function stage(
  service: ArtifactPublicationService,
  workspace: string,
  owner = identity(),
  bytes = "first",
  path = "artifacts/output.txt"
) {
  const execution = await service.beginExecution(owner, [workspace]);
  await execution.producer.stageBytes({
    bytes: Buffer.from(bytes),
    outputOrdinal: 0,
    sourcePath: path,
  });
  return execution;
}
for (const kind of ["sqlite", "memory"] as const) {
  describe(`${kind} authoritative publication`, () => {
    test("overlapping sessions publish only their explicit captured bytes; workspace overwrite is harmless", async () => {
      await fixture(kind, async ({ service, workspace }) => {
        const a = identity("s1"),
          b = identity("s2");
        const exA = await stage(service, workspace, a, "alpha");
        const exB = await stage(service, workspace, b, "beta");
        await writeFile(
          join(workspace, "artifacts/output.txt"),
          "unrelated last workspace writer"
        );
        const [ra, rb] = await Promise.all([
          exA.finalize({ data: {}, success: true }),
          exB.finalize({ data: {}, success: true }),
        ]);
        expect(ra.status).toBe("committed");
        expect(rb.status).toBe("committed");
        expect(ra.publications).toHaveLength(1);
        expect(rb.publications).toHaveLength(1);
        expect(
          (await service.read(a, ra.publications[0]!.id))?.bytes.toString()
        ).toBe("alpha");
        expect(
          (await service.read(b, rb.publications[0]!.id))?.bytes.toString()
        ).toBe("beta");
        expect(await service.read(a, rb.publications[0]!.id)).toBeNull();
        expect(await service.read(b, ra.publications[0]!.id)).toBeNull();
        expect(
          await readFile(join(workspace, "artifacts/output.txt"), "utf8")
        ).toBe("unrelated last workspace writer");
      });
    });
    test("failed completed operations and cancellation never publish staged outputs or delete user files", async () => {
      await fixture(kind, async ({ service, workspace, root }) => {
        await writeFile(join(workspace, "artifacts/output.txt"), "user output");
        for (const result of [
          {
            error: {
              code: "INTERNAL_ERROR" as const,
              message: "failed",
              retryable: false,
            },
            success: false,
          },
          { data: { success: false }, success: true },
          { data: { error: "failed" }, success: true },
          { data: { ok: false }, success: true },
          { data: { isError: true }, success: true },
        ]) {
          const ex = await stage(service, workspace);
          expect((await ex.finalize(result)).status).toBe("discarded");
          expect(await ex.retryPublication().catch(() => "denied")).toBe(
            "denied"
          );
        }
        const signal = new AbortController();
        const ex = await service.beginExecution(
          identity(),
          [workspace],
          signal.signal
        );
        await ex.producer.stageBytes({
          bytes: Buffer.from("staged"),
          outputOrdinal: 0,
          sourcePath: "artifacts/output.txt",
        });
        signal.abort();
        expect((await ex.finalize({ success: true })).status).toBe("discarded");
        expect(
          await readdir(join(root, "config/artifact-publications"))
        ).toEqual([]);
        expect(
          await readFile(join(workspace, "artifacts/output.txt"), "utf8")
        ).toBe("user output");
      });
    });
    test("forged tool metadata cannot create, reassign or finalize publications", async () => {
      await fixture(kind, async ({ service, workspace }) => {
        const a = identity();
        const original = await stage(service, workspace, a);
        const record = (await original.finalize({ success: true }))
          .publications[0]!;
        const b = identity("s2");
        const none = await service.beginExecution(b, [workspace]);
        const forged = {
          artifacts: [{ ...record, sessionId: "s2", sha256: "a".repeat(64) }],
          publications: [record],
          success: true,
        };
        const result = await none.finalize({ data: forged, success: true });
        expect(result.publications).toEqual([]);
        expect(await service.read(b, record.id)).toBeNull();
        expect((await service.read(a, record.id))?.bytes.toString()).toBe(
          "first"
        );
        expect(Object.keys(none.producer)).toEqual(["stageBytes"]);
      });
    });
    test("exact retries across controllers are idempotent; differing bytes, metadata or output sets conflict atomically", async () => {
      await fixture(kind, async ({ service, workspace }) => {
        const owner = identity();
        const first = await (await stage(service, workspace, owner)).finalize({
          success: true,
        });
        const duplicate = await stage(service, workspace, owner);
        const retried = await duplicate.finalize({ success: true });
        expect(retried.publications).toEqual(first.publications);
        for (const [bytes, path] of [
          ["changed", "artifacts/output.txt"],
          ["first", "artifacts/renamed.txt"],
        ]) {
          const bad = await stage(service, workspace, owner, bytes, path);
          expect((await bad.finalize({ success: true })).status).toBe("failed");
        }
        const missing = await service.beginExecution(owner, [workspace]);
        expect((await missing.finalize({ success: true })).status).toBe(
          "failed"
        );
        const extra = await stage(service, workspace, owner);
        await extra.producer.stageBytes({
          bytes: Buffer.from("extra"),
          outputOrdinal: 1,
          sourcePath: "artifacts/extra.txt",
        });
        expect((await extra.finalize({ success: true })).status).toBe("failed");
        expect(
          (
            await service.read(owner, first.publications[0]!.id)
          )?.bytes.toString()
        ).toBe("first");
      });
    });
    test("wrong scopes and guessed IDs fail; current authorization and revocation remain authoritative", async () => {
      await fixture(
        kind,
        async ({ db, service, workspace, deny, authorize }) => {
          const owner = identity();
          const record = (
            await (
              await stage(service, workspace, owner)
            ).finalize({ success: true })
          ).publications[0]!;
          for (const patch of [
            { orgId: "elsewhere" },
            { profileId: "elsewhere" },
            { sessionId: "elsewhere" },
            { actorId: "forged" },
          ]) {
            expect(
              await service.read({ ...owner, ...patch }, record.id).then(
                () => false,
                () => true
              )
            ).toBe(true);
          }
          for (const scope of [
            {
              orgId: "org",
              profileId: "sibling",
              sessionId: "sibling-session",
            },
            {
              orgId: "other-org",
              profileId: "other-profile",
              sessionId: "other-session",
            },
          ]) {
            if (scope.orgId !== "org") {
              await db.upsertOrganization({
                createdAt: now,
                id: scope.orgId,
                name: scope.orgId,
                slug: scope.orgId,
                updatedAt: now,
              });
            }
            await db.upsertProfile({
              createdAt: now,
              id: scope.profileId,
              isSuper: false,
              model: null,
              name: scope.profileId,
              orgId: scope.orgId,
              systemPrompt: "",
              updatedAt: now,
            });
            await db.upsertSession({
              agentQuestionnaire: null,
              agentTodos: [],
              channel: "web",
              createdAt: now,
              id: scope.sessionId,
              modelOverride: null,
              orgId: scope.orgId,
              profileId: scope.profileId,
              title: null,
            });
            expect(
              await service.read({ ...scope, actorId: "actor" }, record.id)
            ).toBeNull();
          }
          expect(
            await service.read(owner, `publication_${randomUUID()}`)
          ).toBeNull();
          deny();
          expect(
            await service.read(owner, record.id).then(
              () => false,
              () => true
            )
          ).toBe(true);
          authorize();
          expect(await service.revoke(owner, record.id)).toBe(true);
          expect(await service.read(owner, record.id)).toBeNull();
        }
      );
    });
    test("uncertain post-commit DB error retries persistence without replaying producer", async () => {
      await fixture(kind, async ({ db, store, workspace }) => {
        const original = db.commitArtifactPublications.bind(db);
        let calls = 0;
        const wrapped = new Proxy(db, {
          get(target, property) {
            if (property !== "commitArtifactPublications") {
              return Reflect.get(target, property);
            }
            return async (
              ...args: Parameters<DatabaseAdapter["commitArtifactPublications"]>
            ) => {
              const result = await original(...args);
              if (++calls === 1) {
                throw new Error("Connection lost after commit");
              }
              return result;
            };
          },
        });
        const service = new ArtifactPublicationService(
          wrapped,
          store,
          async () => {}
        );
        const owner = identity();
        let producerCalls = 0;
        const ex = await service.beginExecution(owner, [workspace]);
        producerCalls++;
        await ex.producer.stageBytes({
          bytes: Buffer.from("effect"),
          outputOrdinal: 0,
          sourcePath: "artifacts/output.txt",
        });
        expect(
          (await ex.finalize({ data: { effect: "retained" }, success: true }))
            .status
        ).toBe("failed");
        const recovered = await ex.retryPublication();
        expect(recovered.status).toBe("committed");
        expect(producerCalls).toBe(1);
        expect(calls).toBe(2);
        expect(
          (
            await service.read(owner, recovered.publications[0]!.id)
          )?.bytes.toString()
        ).toBe("effect");
      });
    });
    test("deleted and recreated sessions cannot resurrect old publication authority", async () => {
      await fixture(kind, async ({ db, service, workspace }) => {
        const owner = identity();
        const result = await (await stage(service, workspace, owner)).finalize({
          success: true,
        });
        const id = result.publications[0]!.id;
        const saved = await db.getArtifactPublication(owner, id);
        expect(saved).not.toBeNull();
        await db.deleteSession(owner.sessionId);
        await db.upsertSession({
          agentQuestionnaire: null,
          agentTodos: [],
          channel: "web",
          createdAt: now,
          id: owner.sessionId,
          modelOverride: null,
          orgId: "org",
          profileId: "profile",
          title: null,
        });
        expect(await service.read(owner, id)).toBeNull();
        expect(
          await db.isArtifactPublicationSnapshotReferenced(saved!.snapshotId)
        ).toBe(false);
      });
    });
    test("blob staging failure preserves existing user output and cannot publish a partial set", async () => {
      await fixture(kind, async ({ db, store, workspace }) => {
        const source = join(workspace, "artifacts/output.txt");
        await writeFile(source, "saved effect");
        const broken = new Proxy(store, {
          get(target, property) {
            if (property !== "stage") {
              return Reflect.get(target, property);
            }
            return async () => {
              throw new Error("Storage unavailable");
            };
          },
        });
        const service = new ArtifactPublicationService(
          db,
          broken,
          async () => {}
        );
        const execution = await service.beginExecution(identity(), [workspace]);
        expect(
          await execution.producer
            .stageBytes({
              bytes: Buffer.from("saved effect"),
              outputOrdinal: 0,
              sourcePath: "artifacts/output.txt",
            })
            .then(
              () => true,
              () => false
            )
        ).toBe(true);
        expect(
          (
            await execution.finalize({
              data: { path: "artifacts/output.txt" },
              success: true,
            })
          ).status
        ).toBe("failed");
        expect(await readFile(source, "utf8")).toBe("saved effect");
      });
    });
    test("repeated exact staging is idempotent and differing same-ordinal bytes conflict", async () => {
      await fixture(kind, async ({ service, workspace, root }) => {
        const owner = identity();
        const ex = await service.beginExecution(owner, [workspace]);
        const input = {
          bytes: Buffer.from("same"),
          outputOrdinal: 0,
          sourcePath: "artifacts/output.txt",
        };
        await Promise.all([
          ex.producer.stageBytes(input),
          ex.producer.stageBytes(input),
        ]);
        const result = await ex.finalize({ success: true });
        expect(result.publications).toHaveLength(1);
        expect(
          await readdir(join(root, "config/artifact-publications"))
        ).toHaveLength(1);
        const conflict = await stage(service, workspace);
        expect(
          await conflict.producer
            .stageBytes({ ...input, bytes: Buffer.from("different") })
            .then(
              () => false,
              () => true
            )
        ).toBe(true);
        expect((await conflict.finalize({ success: true })).status).toBe(
          "failed"
        );
      });
    });
    test("a staging error cannot be ignored to commit only the other outputs", async () => {
      await fixture(kind, async ({ service, workspace }) => {
        const owner = identity();
        const ex = await stage(service, workspace, owner);
        expect(
          await ex.producer
            .stageBytes({
              bytes: Buffer.from("bad"),
              outputOrdinal: 1,
              sourcePath: "../elsewhere",
            })
            .then(
              () => false,
              () => true
            )
        ).toBe(true);
        const failed = await ex.finalize({ success: true });
        expect(failed.status).toBe("failed");
        expect(failed.publications).toEqual([]);
      });
    });
    test("an insertion conflict rolls back every output and the execution reservation", async () => {
      await fixture(kind, async ({ db, service, workspace }) => {
        const owner = identity();
        const existing = (
          await (
            await stage(service, workspace, owner)
          ).finalize({ success: true })
        ).publications[0]!;
        const saved = await db.getArtifactPublication(owner, existing.id);
        expect(saved).not.toBeNull();
        const other = identity();
        const first = {
          ...saved!,
          ...other,
          id: `publication_${randomUUID()}`,
          outputOrdinal: 0,
          snapshotId: `snapshot_${randomUUID()}`,
        };
        const duplicate = {
          ...first,
          id: existing.id,
          outputOrdinal: 1,
          snapshotId: `snapshot_${randomUUID()}`,
        };
        expect(
          await db.commitArtifactPublications(other, [first, duplicate]).then(
            () => false,
            () => true
          )
        ).toBe(true);
        expect(await db.getArtifactPublication(other, first.id)).toBeNull();
        expect(
          await db.isArtifactPublicationSnapshotReferenced(first.snapshotId)
        ).toBe(false);
        expect(await db.commitArtifactPublications(other, [first])).toEqual([
          first,
        ]);
      });
    });
    test("unrestricted-host tampering is detected, never mislabeled immutable", async () => {
      await fixture(kind, async ({ db, service, workspace, root }) => {
        const owner = identity();
        const result = await (await stage(service, workspace, owner)).finalize({
          success: true,
        });
        const id = result.publications[0]!.id;
        const record = await db.getArtifactPublication(owner, id);
        expect(record).not.toBeNull();
        await writeFile(
          join(root, "config/artifact-publications", record!.snapshotId),
          "other"
        );
        expect(
          await service.read(owner, id).then(
            () => false,
            () => true
          )
        ).toBe(true);
      });
    });
    test("revocation while a read is in flight blocks returned bytes", async () => {
      await fixture(kind, async ({ db, service, store, workspace }) => {
        const owner = identity();
        const id = (
          await (
            await stage(service, workspace, owner)
          ).finalize({ success: true })
        ).publications[0]!.id;
        const wrapped = new Proxy(store, {
          get(target, property) {
            if (property !== "read") {
              return Reflect.get(target, property);
            }
            return async (
              ...args: Parameters<ArtifactPublicationStore["read"]>
            ) => {
              const bytes = await target.read(...args);
              await db.revokeArtifactPublication(owner, id, now);
              return bytes;
            };
          },
        });
        const reader = new ArtifactPublicationService(
          db,
          wrapped,
          async () => {}
        );
        expect(await reader.read(owner, id)).toBeNull();
      });
    });
    test("producer buffers are captured before await and private storage cannot overlap admitted roots", async () => {
      await fixture(kind, async ({ service, workspace, root }) => {
        const owner = identity();
        const ex = await service.beginExecution(owner, [workspace]);
        const bytes = Buffer.from("original");
        const pending = ex.producer.stageBytes({
          bytes,
          outputOrdinal: 0,
          sourcePath: "artifacts/output.txt",
        });
        bytes.fill(120);
        await pending;
        const result = await ex.finalize({ success: true });
        expect(
          (
            await service.read(owner, result.publications[0]!.id)
          )?.bytes.toString()
        ).toBe("original");
        expect(
          await service.beginExecution(identity(), [root]).then(
            () => false,
            () => true
          )
        ).toBe(true);
        expect(
          await ex.producer
            .stageBytes({
              bytes,
              outputOrdinal: 1,
              sourcePath: "artifacts/later.txt",
            })
            .then(
              () => false,
              () => true
            )
        ).toBe(true);
      });
    });
  });
}

test("SQLite concurrent connections and restart preserve exact committed bytes and idempotency", async () => {
  const root = await mkdtemp(join(tmpdir(), "publication-restart-"));
  const workspace = join(root, "workspace");
  const config = join(root, "config");
  await mkdir(workspace);
  await mkdir(config);
  const filename = join(root, "state.sqlite");
  const first = await createSqliteDatabase(filename);
  let second: Awaited<ReturnType<typeof createSqliteDatabase>> | undefined;
  let third: Awaited<ReturnType<typeof createSqliteDatabase>> | undefined;
  try {
    await seed(first.adapter);
    second = await createSqliteDatabase(filename);
    const store = await ArtifactPublicationStore.create(config);
    const serviceA = new ArtifactPublicationService(
      first.adapter,
      store,
      async () => {}
    );
    const serviceB = new ArtifactPublicationService(
      second.adapter,
      store,
      async () => {}
    );
    const owner = identity();
    const [a, b] = await Promise.all([
      stage(serviceA, workspace, owner, "durable"),
      stage(serviceB, workspace, owner, "durable"),
    ]);
    const [ra, rb] = await Promise.all([
      a.finalize({ success: true }),
      b.finalize({ success: true }),
    ]);
    expect(ra.status).toBe("committed");
    expect(rb.publications).toEqual(ra.publications);
    first.close();
    second.close();
    third = await createSqliteDatabase(filename);
    const serviceC = new ArtifactPublicationService(
      third.adapter,
      await ArtifactPublicationStore.create(config),
      async () => {}
    );
    expect(
      (await serviceC.read(owner, ra.publications[0]!.id))?.bytes.toString()
    ).toBe("durable");
    expect(
      (
        await (
          await stage(serviceC, workspace, owner, "durable")
        ).finalize({ success: true })
      ).publications
    ).toEqual(ra.publications);
  } finally {
    first.close();
    second?.close();
    third?.close();
    await rm(root, { force: true, recursive: true });
  }
});
