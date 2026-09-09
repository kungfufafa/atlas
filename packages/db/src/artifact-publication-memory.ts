import type { ArtifactPublicationScope } from "@atlas/core/artifact-publication";
import { publicationCommitFingerprint } from "./artifact-publication-identity";
import {
  comparePublicationKeys,
  validateArtifactPublicationPage,
} from "./artifact-publication-page";
import type { DatabaseAdapter, StoredArtifactPublicationRecord } from "./types";
export function memoryArtifactPublications(
  activeScope: (scope: ArtifactPublicationScope) => boolean
): Pick<
  DatabaseAdapter,
  | "commitArtifactPublications"
  | "getArtifactPublication"
  | "listArtifactPublications"
  | "isArtifactPublicationSnapshotReferenced"
  | "revokeArtifactPublication"
> & {
  removeScope(predicate: (scope: ArtifactPublicationScope) => boolean): void;
} {
  const executions = new Map<
    string,
    {
      fingerprint: string;
      scope: ArtifactPublicationScope;
      records: StoredArtifactPublicationRecord[];
    }
  >();
  const publications = new Map<string, StoredArtifactPublicationRecord>();
  return {
    async commitArtifactPublications(identity, records) {
      const fingerprint = publicationCommitFingerprint(identity, records);
      if (!activeScope(identity)) {
        throw new Error("Publication scope is unavailable.");
      }
      const key = JSON.stringify([identity.orgId, identity.executionId]);
      const old = executions.get(key);
      if (old) {
        if (old.fingerprint !== fingerprint) {
          throw new Error(
            "Publication execution conflicts with its committed output set."
          );
        }
        return structuredClone(old.records);
      }
      if (
        records.some((record) => publications.has(record.id)) ||
        new Set(records.map((record) => record.id)).size !== records.length ||
        new Set(records.map((record) => record.snapshotId)).size !==
          records.length ||
        records.some((record) =>
          [...publications.values()].some(
            (item) => item.snapshotId === record.snapshotId
          )
        )
      ) {
        throw new Error("Duplicate publication identity.");
      }
      const stored = structuredClone(
        [...records].sort((a, b) => a.outputOrdinal - b.outputOrdinal)
      );
      executions.set(key, {
        fingerprint,
        records: stored,
        scope: {
          orgId: identity.orgId,
          profileId: identity.profileId,
          sessionId: identity.sessionId,
        },
      });
      for (const record of stored) {
        publications.set(record.id, record);
      }
      return structuredClone(stored);
    },
    async getArtifactPublication(scope, id) {
      const record = publications.get(id);
      return activeScope(scope) &&
        record &&
        record.orgId === scope.orgId &&
        record.profileId === scope.profileId &&
        record.sessionId === scope.sessionId &&
        !record.revokedAt
        ? structuredClone(record)
        : null;
    },
    async isArtifactPublicationSnapshotReferenced(snapshotId) {
      return [...publications.values()].some(
        (record) => record.snapshotId === snapshotId
      );
    },
    async listArtifactPublications(scope, options) {
      validateArtifactPublicationPage(options);
      if (!activeScope(scope)) {
        return [];
      }
      const after = options.after;
      const records = [...publications.values()]
        .filter(
          (record) =>
            record.orgId === scope.orgId &&
            record.profileId === scope.profileId &&
            record.sessionId === scope.sessionId &&
            !record.revokedAt &&
            (!after || comparePublicationKeys(record, after) < 0)
        )
        .sort((left, right) => comparePublicationKeys(right, left))
        .slice(0, options.limit);
      return structuredClone(records);
    },
    removeScope(predicate) {
      for (const [key, execution] of executions) {
        if (!predicate(execution.scope)) {
          continue;
        }
        for (const record of execution.records) {
          publications.delete(record.id);
        }
        executions.delete(key);
      }
    },
    async revokeArtifactPublication(scope, id, revokedAt) {
      if (!Number.isFinite(Date.parse(revokedAt))) {
        throw new Error("Invalid revocation time.");
      }
      const record = publications.get(id);
      if (
        !(activeScope(scope) && record) ||
        record.orgId !== scope.orgId ||
        record.profileId !== scope.profileId ||
        record.sessionId !== scope.sessionId ||
        record.revokedAt
      ) {
        return false;
      }
      record.revokedAt = revokedAt;
      return true;
    },
  };
}
