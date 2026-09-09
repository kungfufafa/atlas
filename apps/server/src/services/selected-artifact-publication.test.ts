import { expect, spyOn, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
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
import { publicationCommitFingerprint } from "../../../../packages/db/src/artifact-publication-identity";
import { ArtifactPublicationService } from "./artifact-publication-service";
import { ArtifactPublicationStore } from "./artifact-publication-store";
import * as captureModule from "./selected-artifact-capture";
import { createSelectedArtifactCapture } from "./selected-artifact-capture";

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
  test(`${kind}: selected evidence commits distinctly and conflicts with generated relabeling`, async () =>
    fixture(kind, async (f) => {
      const record = await selectedRecord(f);
      expect(await f.db.commitArtifactPublications(f.owner, [record])).toEqual([
        record,
      ]);
      expect(
        (await f.db.getArtifactPublication(f.owner, record.id))?.sourceEvidence
      ).toBe("selected_workspace_capture");
      const { captureEvidence: _, ...generated } = record;
      await expect(
        f.db.commitArtifactPublications(f.owner, [
          { ...generated, sourceEvidence: "tool_output_bytes" },
        ])
      ).rejects.toThrow();
      expect(await f.db.commitArtifactPublications(f.owner, [record])).toEqual([
        record,
      ]);
    }));

  test(`${kind}: mixed finalization awaits reserved capture and exposes only the public evidence class`, async () =>
    fixture(kind, async (f) => {
      const execution = await f.service.beginExecution(f.owner, [f.workspace]);
      await execution.producer.stageBytes({
        bytes: Buffer.from("generated"),
        outputOrdinal: 0,
        sourcePath: "artifacts/generated.txt",
      });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let calls = 0;
      f.onAuthorize(async () => {
        if (++calls === 1) {
          entered.resolve();
          await release.promise;
        }
      });
      const staging = execution.stageSelectedFile({
        outputOrdinal: 1,
        sourcePath,
      });
      await entered.promise;
      let settled = false;
      const finalizing = execution
        .finalize({ data: { ok: true }, success: true })
        .then((result) => {
          settled = true;
          return result;
        });
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(
        await f.db.listArtifactPublications(f.owner, { limit: 10 })
      ).toEqual([]);
      release.resolve();
      await staging;
      const result = await finalizing;
      expect(result.status).toBe("committed");
      expect(
        result.publications.map((record) => record.sourceEvidence)
      ).toEqual(["tool_output_bytes", "selected_workspace_capture"]);
      expect(
        result.publications.every(
          (record) => !("captureEvidence" in record || "snapshotId" in record)
        )
      ).toBe(true);
      const selected = result.publications[1]!;
      expect(
        (await f.db.getArtifactPublication(f.owner, selected.id))
          ?.captureEvidence?.reader
      ).toBe("posix_dirfd_nofollow");
      expect(
        (await f.service.list(f.owner, { limit: 10 })).every(
          (record) => !("captureEvidence" in record)
        )
      ).toBe(true);
      expect((await f.service.read(f.owner, selected.id))?.publication).toEqual(
        selected
      );
    }));

  test(`${kind}: repeated selection and persistence retry retain one snapshot without rereading the file`, async () =>
    fixture(kind, async (f) => {
      const execution = await f.service.beginExecution(f.owner, [f.workspace]);
      let stageCalls = 0;
      const originalStage = f.store.stage.bind(f.store);
      f.store.stage = async (bytes) => {
        stageCalls += 1;
        return await originalStage(bytes);
      };
      await execution.stageSelectedFile({ outputOrdinal: 0, sourcePath });
      await rm(join(f.workspace, sourcePath));
      await execution.stageSelectedFile({ outputOrdinal: 0, sourcePath });
      const commit = f.db.commitArtifactPublications;
      let attempts = 0;
      f.db.commitArtifactPublications = async (...args) => {
        if (++attempts === 1) {
          throw new Error("DB unavailable");
        }
        return await commit(...args);
      };
      expect(
        (await execution.finalize({ data: {}, success: true })).status
      ).toBe("failed");
      const result = await execution.retryPublication();
      expect(result.status).toBe("committed");
      expect(stageCalls).toBe(1);
      expect(attempts).toBe(2);
      const read = await f.service.read(f.owner, result.publications[0]!.id);
      expect(read?.bytes.toString()).toBe("selected original");
      expect(read?.publication.sourceEvidence).toBe(
        "selected_workspace_capture"
      );
      expect("captureEvidence" in read!.publication).toBe(false);
    }));

  test(`${kind}: separate explicit selection attempts deduplicate unchanged evidence and conflict after metadata change`, async () =>
    fixture(kind, async (f) => {
      const attempt = async () => {
        const execution = await f.service.beginExecution(f.owner, [
          f.workspace,
        ]);
        await execution.stageSelectedFile({ outputOrdinal: 0, sourcePath });
        return await execution.finalize({ data: {}, success: true });
      };
      const first = await attempt();
      expect(first.status).toBe("committed");
      const retry = await attempt();
      expect(retry.publications).toEqual(first.publications);
      await utimes(
        join(f.workspace, sourcePath),
        new Date("2020-01-01"),
        new Date("2020-01-01")
      );
      const changed = await attempt();
      expect(changed.status).toBe("failed");
      expect(changed.publications).toEqual([]);
      expect(
        (
          await f.service.read(f.owner, first.publications[0]!.id)
        )?.bytes.toString()
      ).toBe("selected original");
    }));

  test(`${kind}: failed selected capture poisons the mixed set and leaves original files intact`, async () =>
    fixture(kind, async (f) => {
      const execution = await f.service.beginExecution(f.owner, [f.workspace]);
      await execution.producer.stageBytes({
        bytes: Buffer.from("generated"),
        outputOrdinal: 0,
        sourcePath: "artifacts/generated.txt",
      });
      await execution.stageSelectedFile({
        outputOrdinal: 1,
        sourcePath: "artifacts/missing.txt",
      });
      const result = await execution.finalize({
        data: { ok: true },
        success: true,
      });
      expect(result.status).toBe("failed");
      expect(result.publications).toEqual([]);
      expect(
        await f.db.listArtifactPublications(f.owner, { limit: 10 })
      ).toEqual([]);
      expect(await readFile(join(f.workspace, sourcePath), "utf8")).toBe(
        "selected original"
      );
    }));

  test(`${kind}: evidence-class collision on one ordinal poisons the whole set`, async () =>
    fixture(kind, async (f) => {
      const execution = await f.service.beginExecution(f.owner, [f.workspace]);
      await execution.stageSelectedFile({ outputOrdinal: 0, sourcePath });
      await expect(
        execution.producer.stageBytes({
          bytes: Buffer.from("selected original"),
          outputOrdinal: 0,
          sourcePath,
        })
      ).rejects.toThrow();
      expect(
        (await execution.finalize({ data: {}, success: true })).status
      ).toBe("failed");
      expect(
        await f.db.listArtifactPublications(f.owner, { limit: 10 })
      ).toEqual([]);
    }));

  test(`${kind}: DB refuses missing, forged, mismatched and excessive capture evidence`, async () =>
    fixture(kind, async (f) => {
      const record = await selectedRecord(f);
      const capture = record.captureEvidence!;
      const invalid: unknown[] = [
        { ...record, captureEvidence: undefined },
        { ...record, sourceEvidence: "model_says_so" },
        { ...record, sourceEvidence: "tool_output_bytes" },
        { ...record, captureEvidence: { ...capture, sha256: "0".repeat(64) } },
        {
          ...record,
          captureEvidence: { ...capture, sourcePath: "artifacts/other.txt" },
        },
        {
          ...record,
          captureEvidence: { ...capture, sizeBytes: capture.sizeBytes + 1 },
        },
        {
          ...record,
          captureEvidence: {
            ...capture,
            file: { ...capture.file, linkCount: 2 },
          },
        },
        {
          ...record,
          captureEvidence: {
            ...capture,
            rootIdentity: { ...capture.rootIdentity, inode: "9".repeat(65) },
          },
        },
        { ...record, captureEvidence: { ...capture, extraAuthority: "owner" } },
      ];
      for (const value of invalid) {
        await expect(
          f.db.commitArtifactPublications(f.owner, [
            value as StoredArtifactPublicationRecord,
          ])
        ).rejects.toThrow();
      }
      expect(
        await f.db.listArtifactPublications(f.owner, { limit: 10 })
      ).toEqual([]);
      expect(await f.db.commitArtifactPublications(f.owner, [record])).toEqual([
        record,
      ]);
    }));

  test(`${kind}: generated byte fingerprints and producer authority remain unchanged`, async () =>
    fixture(kind, async (f) => {
      const execution = await f.service.beginExecution(f.owner, [f.workspace]);
      const input = {
        bytes: Buffer.from("generated"),
        get captureEvidence() {
          throw new Error("Tool metadata must not be read");
        },
        outputOrdinal: 0,
        get sourceEvidence() {
          throw new Error("Tool metadata must not be read");
        },
        sourcePath,
      };
      await execution.producer.stageBytes(input);
      const result = await execution.finalize({
        data: { sourceEvidence: "selected_workspace_capture" },
        success: true,
      });
      const publication = result.publications[0]!;
      expect(publication.sourceEvidence).toBe("tool_output_bytes");
      const record = (await f.db.getArtifactPublication(
        f.owner,
        publication.id
      ))!;
      expect(record.captureEvidence).toBeUndefined();
      const owner = f.owner;
      const legacyFingerprint = JSON.stringify([
        JSON.stringify([
          owner.orgId,
          owner.profileId,
          owner.sessionId,
          owner.actorId,
          owner.runId,
          owner.executionId,
          owner.toolCallId,
        ]),
        [
          [
            0,
            sourcePath,
            "selected.txt",
            "text/plain",
            9,
            createHash("sha256").update("generated").digest("hex"),
            "tool_output_bytes",
          ],
        ],
      ]);
      expect(publicationCommitFingerprint(owner, [record])).toBe(
        legacyFingerprint
      );
    }));

  test(`${kind}: current revocation during post-capture authorization denies all publication`, async () =>
    fixture(kind, async (f) => {
      const execution = await f.service.beginExecution(f.owner, [f.workspace]);
      let authorizations = 0;
      f.onAuthorize(() => {
        if (++authorizations === 2) {
          f.deny();
        }
      });
      let stageCalls = 0;
      const original = f.store.stage.bind(f.store);
      f.store.stage = async (bytes) => {
        stageCalls += 1;
        return await original(bytes);
      };
      await execution.stageSelectedFile({ outputOrdinal: 0, sourcePath });
      const result = await execution.finalize({ data: {}, success: true });
      expect(authorizations).toBe(2);
      expect(stageCalls).toBe(0);
      expect(result.status).toBe("failed");
      expect(
        await f.db.listArtifactPublications(f.owner, { limit: 10 })
      ).toEqual([]);
      expect(await readFile(join(f.workspace, sourcePath), "utf8")).toBe(
        "selected original"
      );
    }));

  test(`${kind}: selected storage failure preserves source and never automatically recaptures`, async () =>
    fixture(kind, async (f) => {
      const execution = await f.service.beginExecution(f.owner, [f.workspace]);
      let calls = 0;
      f.store.stage = async () => {
        calls += 1;
        throw new Error("Storage unavailable");
      };
      await execution.stageSelectedFile({ outputOrdinal: 0, sourcePath });
      expect(
        (await execution.finalize({ data: {}, success: true })).status
      ).toBe("failed");
      expect((await execution.retryPublication()).status).toBe("failed");
      expect(calls).toBe(1);
      expect(await readFile(join(f.workspace, sourcePath), "utf8")).toBe(
        "selected original"
      );
    }));
}

test("strict publication paths reject before capture authorization and poison prior generated output", async () =>
  fixture("memory", async (f) => {
    for (const path of [
      "artifacts/" + "x".repeat(1024),
      "artifacts/../outside.txt",
      "artifacts/.hidden/file",
      "artifacts/name.ATLAS-META.JSON",
      "artifacts/" + "dir/".repeat(64) + "file.txt",
    ]) {
      const execution = await f.service.beginExecution(
        { ...f.owner, executionId: randomUUID() },
        [f.workspace]
      );
      await execution.producer.stageBytes({
        bytes: Buffer.from("safe"),
        outputOrdinal: 0,
        sourcePath,
      });
      let calls = 0;
      f.onAuthorize(() => {
        calls += 1;
      });
      await expect(
        execution.stageSelectedFile({ outputOrdinal: 1, sourcePath: path })
      ).rejects.toThrow();
      expect(calls).toBe(0);
      expect(
        (await execution.finalize({ data: {}, success: true })).status
      ).toBe("failed");
    }
    expect(await f.db.listArtifactPublications(f.owner, { limit: 10 })).toEqual(
      []
    );
  }));

test("the current signal reaches capture after anchoring and cancellation yields no usable publication", async () =>
  fixture("memory", async (f) => {
    const abort = new AbortController();
    const create = captureModule.createSelectedArtifactCapture;
    let observed: AbortSignal | undefined;
    const spy = spyOn(
      captureModule,
      "createSelectedArtifactCapture"
    ).mockImplementation(async (...args) => {
      const capture = await create(...args);
      return {
        capture(path, signal) {
          observed = signal;
          const pending = capture.capture(path, signal);
          abort.abort();
          return pending;
        },
      };
    });
    try {
      const execution = await f.service.beginExecution(
        f.owner,
        [f.workspace],
        abort.signal
      );
      await execution.producer.stageBytes({
        bytes: Buffer.from("generated"),
        outputOrdinal: 0,
        sourcePath: "artifacts/generated.txt",
      });
      await execution.stageSelectedFile({ outputOrdinal: 1, sourcePath });
      expect(observed).toBe(abort.signal);
      const result = await execution.finalize({ data: {}, success: true });
      expect(result.status).toBe("discarded");
      expect(result.publications).toEqual([]);
      expect(
        await f.db.listArtifactPublications(f.owner, { limit: 10 })
      ).toEqual([]);
      expect(await readFile(join(f.workspace, sourcePath), "utf8")).toBe(
        "selected original"
      );
    } finally {
      spy.mockRestore();
    }
  }));

test("revocation before selection prevents capture initialization", async () =>
  fixture("memory", async (f) => {
    const execution = await f.service.beginExecution(f.owner, [f.workspace]);
    const spy = spyOn(captureModule, "createSelectedArtifactCapture");
    try {
      f.deny();
      await execution.stageSelectedFile({ outputOrdinal: 0, sourcePath });
      expect(spy).not.toHaveBeenCalled();
      expect(
        (await execution.finalize({ data: {}, success: true })).status
      ).toBe("failed");
      expect(
        await f.db.listArtifactPublications(f.owner, { limit: 10 })
      ).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  }));

test("pending mixed-set cancellation never commits an earlier generated output", async () =>
  fixture("memory", async (f) => {
    const abort = new AbortController();
    const execution = await f.service.beginExecution(
      f.owner,
      [f.workspace],
      abort.signal
    );
    await execution.producer.stageBytes({
      bytes: Buffer.from("generated"),
      outputOrdinal: 0,
      sourcePath: "artifacts/generated.txt",
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.onAuthorize(async () => {
      entered.resolve();
      await release.promise;
    });
    const staging = execution.stageSelectedFile({
      outputOrdinal: 1,
      sourcePath,
    });
    await entered.promise;
    const finalizing = execution.finalize({ data: {}, success: true });
    abort.abort();
    release.resolve();
    await staging;
    expect((await finalizing).publications).toEqual([]);
    expect(await f.db.listArtifactPublications(f.owner, { limit: 10 })).toEqual(
      []
    );
    expect(await readFile(join(f.workspace, sourcePath), "utf8")).toBe(
      "selected original"
    );
  }));

test("structured failed results discard selected outputs and preserve workspace files", async () =>
  fixture("memory", async (f) => {
    const execution = await f.service.beginExecution(f.owner, [f.workspace]);
    await execution.stageSelectedFile({ outputOrdinal: 0, sourcePath });
    const result = await execution.finalize({
      data: { ok: false, sourceEvidence: "tool_output_bytes" },
      success: true,
    });
    expect(result.status).toBe("discarded");
    expect(result.publications).toEqual([]);
    expect(await f.db.listArtifactPublications(f.owner, { limit: 10 })).toEqual(
      []
    );
    expect(await readFile(join(f.workspace, sourcePath), "utf8")).toBe(
      "selected original"
    );
  }));

test("selection binds actual profile scope and ignores additional owner/root selectors", async () =>
  fixture("memory", async (f) => {
    for (const owner of [
      { ...f.owner, orgId: "wrong" },
      { ...f.owner, profileId: "wrong" },
      { ...f.owner, sessionId: "wrong" },
      { ...f.owner, actorId: "wrong" },
    ]) {
      await expect(
        f.service.beginExecution(owner, [f.workspace])
      ).rejects.toThrow();
    }
    const foreign = getProfileSoulDir(f.owner.orgId, "foreign");
    await mkdir(join(foreign, "artifacts"), { recursive: true });
    await writeFile(join(foreign, sourcePath), "foreign bytes");
    const execution = await f.service.beginExecution(f.owner, [f.workspace]);
    const request = {
      actorId: "wrong",
      outputOrdinal: 0,
      profileId: "foreign",
      sessionId: "wrong",
      sourceEvidence: "tool_output_bytes",
      sourcePath,
      workspaceRoot: foreign,
    };
    await execution.stageSelectedFile(request);
    const result = await execution.finalize({ data: request, success: true });
    expect(result.status).toBe("committed");
    const publication = result.publications[0]!;
    expect(publication.profileId).toBe(f.owner.profileId);
    expect(publication.sessionId).toBe(f.owner.sessionId);
    expect(publication.actorId).toBe(f.owner.actorId);
    expect(publication.sourceEvidence).toBe("selected_workspace_capture");
    expect(
      (await f.service.read(f.owner, publication.id))?.bytes.toString()
    ).toBe("selected original");
    expect("stageSelectedFile" in execution.producer).toBe(false);
  }));

test("selection reserves its output before a reentrant trusted authorization callback finalizes", async () =>
  fixture("memory", async (f) => {
    const execution = await f.service.beginExecution(f.owner, [f.workspace]);
    let finalizing: ReturnType<typeof execution.finalize> | undefined;
    f.onAuthorize(() => {
      finalizing ??= execution.finalize({ data: {}, success: true });
    });
    await execution.stageSelectedFile({ outputOrdinal: 0, sourcePath });
    const result = await finalizing!;
    expect(result.status).toBe("committed");
    expect(result.publications).toHaveLength(1);
    expect(result.publications[0]!.sourceEvidence).toBe(
      "selected_workspace_capture"
    );
  }));
