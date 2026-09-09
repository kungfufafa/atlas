import { createHash, randomUUID } from "node:crypto";
import { inferArtifactMimeType } from "@atlas/core/artifact-mime";
import type {
  ArtifactPublication,
  ArtifactPublicationCaptureEvidence,
  ArtifactPublicationIdentity,
  ArtifactPublicationProducer,
  ArtifactPublicationScope,
} from "@atlas/core/artifact-publication";
import type { ToolExecutionResult } from "@atlas/core/contract";
import { getProfileSoulDir } from "@atlas/core/soul/resolve";
import { isFailedToolResult } from "@atlas/core/tools/result-status";
import {
  type ArtifactPublicationPageOptions,
  type DatabaseAdapter,
  MAX_PUBLICATION_BYTES,
  MAX_PUBLICATION_OUTPUTS,
  publicationIdentity,
  publicationSourceEvidenceFingerprint,
  type StoredArtifactPublicationRecord,
  validatePublicationPath,
} from "@atlas/db";
import type { ArtifactPublicationStore } from "./artifact-publication-store";
import {
  createSelectedArtifactCapture,
  type SelectedArtifactCapture,
} from "./selected-artifact-capture";

type Access = ArtifactPublicationScope & { actorId: string };
export interface PublicationFinalization {
  cleanupErrors?: unknown[];
  /** Publication failure only; the caller retains the original execution result/effects. */
  error?: unknown;
  publications: ArtifactPublication[];
  status: "committed" | "discarded" | "failed";
}
export interface ArtifactPublicationExecution {
  /** Accept only the actual completed protected-executor result, never tool-returned JSON. */
  finalize(
    result: ToolExecutionResult<unknown>
  ): Promise<PublicationFinalization>;
  producer: ArtifactPublicationProducer;
  /** Retries receipt persistence only. It never invokes the producer. */
  retryPublication(): Promise<PublicationFinalization>;
  /** Server-only explicit selection. Never expose this capability to tool code or model JSON.
   * Pending selection reserves its ordinal before awaiting capture. Capture/storage failure
   * is retained for finalization; invalid input/conflicts reject and poison the output set.
   */
  stageSelectedFile(input: {
    sourcePath: string;
    outputOrdinal: number;
  }): Promise<void>;
}
function publicRecord(
  record: StoredArtifactPublicationRecord
): ArtifactPublication {
  const { snapshotId: _, captureEvidence: _capture, ...visible } = record;
  return visible;
}

/** Durable publication authority; producers and callers must supply trusted host context. */
export class ArtifactPublicationService {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly store: ArtifactPublicationStore,
    /** Current principal authorization belongs to the host; this callback is mandatory. */
    private readonly authorize: (
      scope: Access,
      action: "publish" | "read" | "revoke"
    ) => Promise<void>
  ) {}

  async beginExecution(
    identity: ArtifactPublicationIdentity,
    admittedToolRoots: readonly string[],
    signal?: AbortSignal
  ): Promise<ArtifactPublicationExecution> {
    const owner = Object.freeze({ ...identity });
    publicationIdentity(owner);
    const selectedProfileRoot = getProfileSoulDir(owner.orgId, owner.profileId);
    const admittedRoots = [...admittedToolRoots];
    signal?.throwIfAborted();
    await this.requireAccess(owner, "publish");
    await this.store.assertOutsideToolRoots(admittedRoots);
    const staged = new Map<number, Promise<StoredArtifactPublicationRecord>>();
    const stagedInputs = new Map<number, string>();
    let closed = false;
    let eligible = false;
    let stageFailed = false;
    let failedStage: unknown;
    let settled: PublicationFinalization | undefined;
    let inFlight: Promise<PublicationFinalization> | undefined;
    let selectedCapture: Promise<SelectedArtifactCapture> | undefined;
    const selectedRecord = async (
      sourcePath: string,
      outputOrdinal: number
    ): Promise<StoredArtifactPublicationRecord> => {
      signal?.throwIfAborted();
      await this.requireAccess(owner, "publish");
      signal?.throwIfAborted();
      await this.store.assertOutsideToolRoots([
        ...admittedRoots,
        selectedProfileRoot,
      ]);
      signal?.throwIfAborted();
      selectedCapture ??= createSelectedArtifactCapture(
        selectedProfileRoot,
        signal
      );
      const capture = await selectedCapture;
      const result = await capture.capture(sourcePath, signal);
      // Capture bytes and evidence before another asynchronous authorization check.
      const bytes = Buffer.from(result.bytes);
      const captureEvidence: ArtifactPublicationCaptureEvidence =
        structuredClone(result.evidence);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      publicationSourceEvidenceFingerprint({
        captureEvidence,
        sha256,
        sizeBytes: bytes.length,
        sourceEvidence: "selected_workspace_capture",
        sourcePath,
      });
      signal?.throwIfAborted();
      await this.requireAccess(owner, "publish");
      signal?.throwIfAborted();
      const snapshot = await this.store.stage(bytes);
      return {
        ...owner,
        ...snapshot,
        captureEvidence,
        createdAt: new Date().toISOString(),
        filename: sourcePath.split("/").at(-1)!,
        id: `publication_${randomUUID()}`,
        mimeType: inferArtifactMimeType(sourcePath),
        outputOrdinal,
        revokedAt: null,
        sourceEvidence: "selected_workspace_capture",
        sourcePath,
      };
    };
    const stageSelectedFile: ArtifactPublicationExecution["stageSelectedFile"] =
      async (input) => {
        if (closed) {
          throw new Error("Publication execution is closed.");
        }
        let promise: Promise<StoredArtifactPublicationRecord>;
        try {
          signal?.throwIfAborted();
          const sourcePath = input.sourcePath;
          const outputOrdinal = input.outputOrdinal;
          validatePublicationPath(sourcePath);
          if (
            sourcePath.split("/").length > 64 ||
            sourcePath.toLowerCase().endsWith(".atlas-meta.json")
          ) {
            throw new Error("Select a canonical visible artifacts/ file.");
          }
          if (
            !Number.isSafeInteger(outputOrdinal) ||
            outputOrdinal < 0 ||
            outputOrdinal >= MAX_PUBLICATION_OUTPUTS
          ) {
            throw new Error("Invalid output ordinal.");
          }
          const fingerprint = JSON.stringify([
            sourcePath,
            "selected_workspace_capture",
          ]);
          const prior = staged.get(outputOrdinal);
          if (prior) {
            if (stagedInputs.get(outputOrdinal) !== fingerprint) {
              throw new Error(
                "Output ordinal conflicts with its selected file."
              );
            }
            promise = prior;
          } else {
            // Reserve before invoking even synchronous/reentrant authorization callbacks.
            promise = Promise.resolve().then(() =>
              selectedRecord(sourcePath, outputOrdinal)
            );
            stagedInputs.set(outputOrdinal, fingerprint);
            staged.set(outputOrdinal, promise);
          }
        } catch (error) {
          stageFailed = true;
          failedStage = error;
          throw error;
        }
        try {
          await promise;
        } catch (error) {
          stageFailed = true;
          failedStage = error;
        }
      };
    const stageBytes: ArtifactPublicationProducer["stageBytes"] = async (
      input
    ) => {
      if (closed) {
        throw new Error("Publication execution is closed.");
      }
      let promise: Promise<StoredArtifactPublicationRecord>;
      try {
        signal?.throwIfAborted();
        validatePublicationPath(input.sourcePath);
        if (
          !Number.isSafeInteger(input.outputOrdinal) ||
          input.outputOrdinal < 0 ||
          input.outputOrdinal >= MAX_PUBLICATION_OUTPUTS
        ) {
          throw new Error("Invalid output ordinal.");
        }
        if (input.bytes.byteLength > MAX_PUBLICATION_BYTES) {
          throw new Error("Publication output exceeds the byte limit.");
        }
        const captured = Buffer.from(input.bytes);
        const sourcePath = input.sourcePath;
        const outputOrdinal = input.outputOrdinal;
        const fingerprint = JSON.stringify([
          sourcePath,
          createHash("sha256").update(captured).digest("hex"),
        ]);
        const prior = staged.get(outputOrdinal);
        if (prior) {
          if (stagedInputs.get(outputOrdinal) !== fingerprint) {
            throw new Error(
              "Output ordinal conflicts with its staged bytes or path."
            );
          }
          promise = prior;
        } else {
          promise = this.store.stage(captured).then((snapshot) => ({
            ...owner,
            ...snapshot,
            createdAt: new Date().toISOString(),
            filename: sourcePath.split("/").at(-1)!,
            id: `publication_${randomUUID()}`,
            mimeType: inferArtifactMimeType(sourcePath),
            outputOrdinal,
            revokedAt: null,
            sourceEvidence: "tool_output_bytes" as const,
            sourcePath,
          }));
          stagedInputs.set(outputOrdinal, fingerprint);
          staged.set(outputOrdinal, promise);
        }
      } catch (error) {
        stageFailed = true;
        failedStage = error;
        throw error;
      }
      // Storage failure belongs to publication, not the already successful workspace effect.
      try {
        await promise;
      } catch (error) {
        stageFailed = true;
        failedStage = error;
      }
    };
    const records = async () => {
      const results = await Promise.allSettled(staged.values());
      return results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : []
      );
    };
    const cleanup = async (
      items: readonly StoredArtifactPublicationRecord[]
    ) => {
      const results = await Promise.allSettled(
        items.map((item) =>
          this.store.removeUnreferenced(item.snapshotId, () =>
            this.db.isArtifactPublicationSnapshotReferenced(item.snapshotId)
          )
        )
      );
      return results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      );
    };
    const commit = async (): Promise<PublicationFinalization> => {
      const items = await records();
      try {
        if (stageFailed) {
          throw failedStage;
        }
        signal?.throwIfAborted();
        await this.requireAccess(owner, "publish");
        signal?.throwIfAborted();
        // Atomic DB commit includes an empty successful output set, preventing later substitution.
        const committed = await this.db.commitArtifactPublications(
          owner,
          items
        );
        const cleanupErrors = await cleanup(
          items.filter(
            (item) =>
              !committed.some((record) => record.snapshotId === item.snapshotId)
          )
        );
        return {
          publications: committed.map(publicRecord),
          status: "committed",
          ...(cleanupErrors.length ? { cleanupErrors } : {}),
        };
      } catch (error) {
        // Keep staged bytes on uncertain commit: DB may have committed before reporting failure.
        return { error, publications: [], status: "failed" };
      }
    };
    return {
      finalize: async (result) => {
        if (inFlight) {
          return await inFlight;
        }
        if (settled) {
          return settled;
        }
        closed = true;
        eligible =
          result.success === true &&
          !isFailedToolResult(result.data) &&
          !signal?.aborted;
        inFlight = (async () => {
          if (!eligible) {
            const cleanupErrors = await cleanup(await records());
            return {
              publications: [],
              status: "discarded" as const,
              ...(cleanupErrors.length ? { cleanupErrors } : {}),
            };
          }
          return await commit();
        })();
        try {
          settled = await inFlight;
          return settled;
        } finally {
          inFlight = undefined;
        }
      },
      producer: Object.freeze({ stageBytes }),
      retryPublication: async () => {
        if (inFlight) {
          return await inFlight;
        }
        if (!(closed && eligible) || settled?.status !== "failed") {
          throw new Error("No failed eligible publication commit to retry.");
        }
        inFlight = commit();
        try {
          settled = await inFlight;
          return settled;
        } finally {
          inFlight = undefined;
        }
      },
      stageSelectedFile,
    };
  }

  async read(
    scope: Access,
    id: string
  ): Promise<{ publication: ArtifactPublication; bytes: Buffer } | null> {
    const access = Object.freeze({ ...scope });
    await this.requireAccess(access, "read");
    const record = await this.db.getArtifactPublication(access, id);
    if (!record) {
      return null;
    }
    const bytes = await this.store.read(record);
    await this.requireAccess(access, "read");
    const current = await this.db.getArtifactPublication(access, id);
    if (
      !current ||
      current.snapshotId !== record.snapshotId ||
      current.sha256 !== record.sha256
    ) {
      return null;
    }
    return { bytes, publication: publicRecord(current) };
  }
  async list(
    scope: Access,
    options: ArtifactPublicationPageOptions
  ): Promise<ArtifactPublication[]> {
    const access = Object.freeze({ ...scope });
    await this.requireAccess(access, "read");
    const records = await this.db.listArtifactPublications(access, options);
    await this.requireAccess(access, "read");
    return records.map(publicRecord);
  }
  async revoke(scope: Access, id: string): Promise<boolean> {
    const access = Object.freeze({ ...scope });
    await this.requireAccess(access, "revoke");
    return await this.db.revokeArtifactPublication(
      access,
      id,
      new Date().toISOString()
    );
  }
  private async requireAccess(
    scope: Access,
    action: "publish" | "read" | "revoke"
  ): Promise<void> {
    if (!scope.actorId?.trim()) {
      throw new Error("A canonical publication principal is required.");
    }
    await this.authorize(scope, action);
    const [org, profile, session] = await Promise.all([
      this.db.getOrganizationById(scope.orgId),
      this.db.getProfile(scope.profileId),
      this.db.getSession(scope.sessionId),
    ]);
    if (
      !org ||
      org.archivedAt ||
      !profile ||
      profile.isImporting ||
      profile.orgId !== scope.orgId ||
      !session ||
      session.orgId !== scope.orgId ||
      session.profileId !== scope.profileId
    ) {
      throw new Error("Publication scope is unavailable.");
    }
  }
}
