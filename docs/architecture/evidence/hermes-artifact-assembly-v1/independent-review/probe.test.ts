import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactPublicationIdentity } from "@atlas/core/artifact-publication";
import { getProfileSoulDir } from "@atlas/core/soul/resolve";
import { runWithUserConfigDir } from "@atlas/core/user-config";
import {
  createInMemoryDatabaseAdapter,
  createSqliteDatabase,
  type DatabaseAdapter,
  type StoredArtifactPublicationRecord,
} from "@atlas/db";
import { ArtifactPublicationService } from "/private/tmp/atlas-artifact-assembly-c5/source/apps/server/src/services/artifact-publication-service.ts";
import { ArtifactPublicationStore } from "/private/tmp/atlas-artifact-assembly-c5/source/apps/server/src/services/artifact-publication-store.ts";
import { createSelectedArtifactCapture } from "/private/tmp/atlas-artifact-assembly-c5/source/apps/server/src/services/selected-artifact-capture.ts";

const now = "2026-01-01T00:00:00.000Z";
const sourcePath = "artifacts/selected.txt";
const identity = (): ArtifactPublicationIdentity => ({
  actorId: "actor",
  executionId: randomUUID(),
  orgId: "org",
  profileId: "profile",
  runId: "run",
  sessionId: "session",
  toolCallId: "call",
});

async function fixture(
  kind: "memory" | "sqlite",
  run: (f: {
    db: DatabaseAdapter;
    service: ArtifactPublicationService;
    store: ArtifactPublicationStore;
    workspace: string;
    owner: ArtifactPublicationIdentity;
    deny(): void;
    onAuthorize(callback: () => void | Promise<void>): void;
  }) => Promise<void>
) {
  const config = await realpath(
    await mkdtemp("/private/tmp/selected-publication-")
  );
  const sql =
    kind === "sqlite"
      ? await createSqliteDatabase(join(config, "state.sqlite"))
      : null;
  const adapter = sql?.adapter ?? createInMemoryDatabaseAdapter();
  const overrides = new Map<PropertyKey, unknown>();
  const db = new Proxy(adapter, {
    get(target, key) {
      return overrides.has(key) ? overrides.get(key) : Reflect.get(target, key);
    },
    set(_target, key, value) {
      overrides.set(key, value);
      return true;
    },
  });
  try {
    await runWithUserConfigDir(config, async () => {
      const owner = identity();
      const workspace = getProfileSoulDir(owner.orgId, owner.profileId);
      await mkdir(join(workspace, "artifacts"), { recursive: true });
      await writeFile(join(workspace, sourcePath), "selected original");
      await db.upsertOrganization({
        createdAt: now,
        id: owner.orgId,
        name: "Org",
        slug: "org",
        updatedAt: now,
      });
      await db.upsertProfile({
        createdAt: now,
        id: owner.profileId,
        isSuper: false,
        model: null,
        name: "Profile",
        orgId: owner.orgId,
        systemPrompt: "",
        updatedAt: now,
      });
      await db.createUser({
        createdAt: now,
        email: "actor@example.invalid",
        id: owner.actorId,
        isPlatformAdmin: false,
        passwordHash: "fixture",
        updatedAt: now,
      });
      await db.upsertSession({
        agentQuestionnaire: null,
        agentTodos: [],
        channel: "web",
        createdAt: now,
        id: owner.sessionId,
        modelOverride: null,
        orgId: owner.orgId,
        profileId: owner.profileId,
        title: null,
        userId: owner.actorId,
      });
      const store = await ArtifactPublicationStore.create(config);
      let allowed = true;
      let barrier: (() => void | Promise<void>) | undefined;
      const service = new ArtifactPublicationService(
        db,
        store,
        async (scope) => {
          await barrier?.();
          if (!allowed || scope.actorId !== owner.actorId) {
            throw new Error("Denied");
          }
        }
      );
      await run({
        db,
        deny: () => {
          allowed = false;
        },
        onAuthorize: (callback) => {
          barrier = callback;
        },
        owner,
        service,
        store,
        workspace,
      });
    });
  } finally {
    sql?.close();
    await rm(config, { force: true, recursive: true });
  }
}

async function selectedRecord(f: {
  workspace: string;
  owner: ArtifactPublicationIdentity;
}): Promise<StoredArtifactPublicationRecord> {
  const capture = await createSelectedArtifactCapture(f.workspace);
  const result = await capture.capture(sourcePath);
  return {
    ...f.owner,
    captureEvidence: result.evidence,
    createdAt: now,
    filename: "selected.txt",
    id: `publication_${randomUUID()}`,
    mimeType: "text/plain",
    outputOrdinal: 0,
    revokedAt: null,
    sha256: result.evidence.sha256,
    sizeBytes: result.evidence.sizeBytes,
    snapshotId: `snapshot_${randomUUID()}`,
    sourceEvidence: "selected_workspace_capture",
    sourcePath,
  };
}

for (const kind of ["memory", "sqlite"] as const) {
  test(`${kind}: pending duplicate selection reserves once, concurrent finalize is one complete set`, async () =>
    fixture(kind, async (f) => {
      const e = await f.service.beginExecution(f.owner, [f.workspace]);
      const original = f.store.stage.bind(f.store);
      let stageCalls = 0;
      f.store.stage = async (bytes) => {
        stageCalls++;
        return await original(bytes);
      };
      await e.producer.stageBytes({
        bytes: Buffer.from("generated"),
        outputOrdinal: 0,
        sourcePath: "artifacts/generated.txt",
      });
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      let authCalls = 0;
      f.onAuthorize(async () => {
        if (++authCalls === 1) {
          entered.resolve();
          await release.promise;
        }
      });
      const a = e.stageSelectedFile({ outputOrdinal: 1, sourcePath });
      const b = e.stageSelectedFile({ outputOrdinal: 1, sourcePath });
      await entered.promise;
      const c = e.finalize({ data: {}, success: true }),
        d = e.finalize({ data: {}, success: true });
      release.resolve();
      await Promise.all([a, b]);
      const [first, second] = await Promise.all([c, d]);
      expect(first).toEqual(second);
      expect(first.status).toBe("committed");
      expect(first.publications.map((p) => p.sourceEvidence)).toEqual([
        "tool_output_bytes",
        "selected_workspace_capture",
      ]);
      expect(stageCalls).toBe(2);
      expect(
        (await f.db.listArtifactPublications(f.owner, { limit: 10 })).length
      ).toBe(2);
    }));
  test(`${kind}: failed capture during reentrant finalize never commits an empty or partial set`, async () =>
    fixture(kind, async (f) => {
      const e = await f.service.beginExecution(f.owner, [f.workspace]);
      await e.producer.stageBytes({
        bytes: Buffer.from("generated"),
        outputOrdinal: 0,
        sourcePath: "artifacts/generated.txt",
      });
      let finalizing: ReturnType<typeof e.finalize> | undefined;
      f.onAuthorize(() => {
        finalizing ??= e.finalize({ data: {}, success: true });
      });
      await e.stageSelectedFile({
        outputOrdinal: 1,
        sourcePath: "artifacts/missing.txt",
      });
      expect((await finalizing!).status).toBe("failed");
      expect((await e.retryPublication()).status).toBe("failed");
      expect(
        await f.db.listArtifactPublications(f.owner, { limit: 10 })
      ).toEqual([]);
      // A genuinely new explicit execution controller may use this identity, proving no empty execution was committed.
      f.onAuthorize(() => {});
      const replacement = await f.service.beginExecution(f.owner, [
        f.workspace,
      ]);
      await replacement.producer.stageBytes({
        bytes: Buffer.from("replacement"),
        outputOrdinal: 0,
        sourcePath,
      });
      expect(
        (await replacement.finalize({ data: {}, success: true })).status
      ).toBe("committed");
    }));
  test(`${kind}: an actual committed receipt survives lost acknowledgment and retry after source deletion`, async () =>
    fixture(kind, async (f) => {
      const e = await f.service.beginExecution(f.owner, [f.workspace]);
      await e.stageSelectedFile({ outputOrdinal: 0, sourcePath });
      const commit = f.db.commitArtifactPublications;
      let attempts = 0;
      f.db.commitArtifactPublications = async (...args) => {
        const r = await commit(...args);
        if (++attempts === 1) {
          throw new Error("lost acknowledgment after actual commit");
        }
        return r;
      };
      expect((await e.finalize({ data: {}, success: true })).status).toBe(
        "failed"
      );
      const original = (
        await f.db.listArtifactPublications(f.owner, { limit: 10 })
      )[0]!;
      await rm(join(f.workspace, sourcePath));
      const recovered = await e.retryPublication();
      expect(recovered.status).toBe("committed");
      expect(recovered.publications[0]!.id).toBe(original.id);
      expect(
        (await f.service.read(f.owner, original.id))?.bytes.toString()
      ).toBe("selected original");
      expect(attempts).toBe(2);
    }));
  test(`${kind}: evidence rejects nested extra keys, wrong versions and nonfinite sizes atomically`, async () =>
    fixture(kind, async (f) => {
      const r = await selectedRecord(f),
        ev = r.captureEvidence!;
      for (const bad of [
        { ...ev, version: 2 },
        { ...ev, observedMetadataStable: false },
        { ...ev, reader: "realpath" },
        { ...ev, rootIdentity: { ...ev.rootIdentity, extra: "hidden" } },
        { ...ev, file: { ...ev.file, extra: "hidden" } },
        { ...ev, file: { ...ev.file, ctimeNs: "9".repeat(65) } },
        { ...ev, sizeBytes: Number.NaN },
        { ...ev, sizeBytes: Number.POSITIVE_INFINITY },
      ]) {
        await expect(
          f.db.commitArtifactPublications(f.owner, [
            { ...r, captureEvidence: bad } as StoredArtifactPublicationRecord,
          ])
        ).rejects.toThrow();
      }
      expect(
        await f.db.listArtifactPublications(f.owner, { limit: 10 })
      ).toEqual([]);
      expect(await f.db.commitArtifactPublications(f.owner, [r])).toEqual([r]);
    }));
}
test("SQLite second connection preserves selected private JSON, public redaction and original bytes", async () =>
  fixture("sqlite", async (f) => {
    const e = await f.service.beginExecution(f.owner, [f.workspace]);
    await e.stageSelectedFile({ outputOrdinal: 0, sourcePath });
    const committed = await e.finalize({ data: {}, success: true });
    const id = committed.publications[0]!.id;
    const config = f.workspace.split("/orgs/")[0]!;
    const second = await createSqliteDatabase(join(config, "state.sqlite"));
    try {
      const privateRow = await second.adapter.getArtifactPublication(
        f.owner,
        id
      );
      expect(privateRow?.captureEvidence?.kind).toBe(
        "selected_workspace_capture"
      );
      expect(privateRow?.captureEvidence?.sha256).toBe(privateRow?.sha256);
      const reader = new ArtifactPublicationService(
        second.adapter,
        f.store,
        async () => {}
      );
      await writeFile(join(f.workspace, sourcePath), "changed workspace");
      const result = await reader.read(f.owner, id);
      expect(result?.bytes.toString()).toBe("selected original");
      expect("captureEvidence" in result!.publication).toBe(false);
      expect("snapshotId" in result!.publication).toBe(false);
      expect((await reader.list(f.owner, { limit: 10 }))[0]).toEqual(
        committed.publications[0]!
      );
    } finally {
      second.close();
    }
  }));
