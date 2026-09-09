import type { Database } from "bun:sqlite";
import type { ArtifactPublicationScope } from "@atlas/core/artifact-publication";
import { publicationCommitFingerprint } from "./artifact-publication-identity";
import { validateArtifactPublicationPage } from "./artifact-publication-page";
import type { DatabaseAdapter, StoredArtifactPublicationRecord } from "./types";

type PublicationMethods = Pick<
  DatabaseAdapter,
  | "commitArtifactPublications"
  | "getArtifactPublication"
  | "listArtifactPublications"
  | "isArtifactPublicationSnapshotReferenced"
  | "revokeArtifactPublication"
>;
interface Row {
  payload: string;
  revoked_at: string | null;
}
export function sqliteArtifactPublications(db: Database): PublicationMethods {
  const scopeExists = db.prepare(
    "SELECT 1 FROM sessions s JOIN profiles p ON p.id=s.profile_id JOIN organizations o ON o.id=s.org_id WHERE s.org_id=? AND s.profile_id=? AND s.id=? AND p.org_id=s.org_id AND p.is_importing=0 AND o.archived_at IS NULL"
  );
  const activeScope = (scope: ArtifactPublicationScope) =>
    Boolean(scopeExists.get(scope.orgId, scope.profileId, scope.sessionId));
  const existing = db.prepare(
    "SELECT fingerprint FROM artifact_publication_executions WHERE org_id=? AND execution_id=?"
  );
  const outputs = db.prepare(
    "SELECT payload, revoked_at FROM artifact_publications WHERE org_id=? AND execution_id=? ORDER BY output_ordinal"
  );
  const insertExecution = db.prepare(
    "INSERT INTO artifact_publication_executions (org_id, execution_id, profile_id, session_id, fingerprint) VALUES (?, ?, ?, ?, ?)"
  );
  const insert = db.prepare(
    "INSERT INTO artifact_publications (id, org_id, profile_id, session_id, execution_id, output_ordinal, snapshot_id, payload, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)"
  );
  const byId = db.prepare(
    "SELECT payload, revoked_at FROM artifact_publications WHERE org_id=? AND profile_id=? AND session_id=? AND id=? AND revoked_at IS NULL"
  );
  const firstPage = db.prepare(
    "SELECT payload, revoked_at FROM artifact_publications WHERE org_id=? AND profile_id=? AND session_id=? AND revoked_at IS NULL ORDER BY json_extract(payload, '$.createdAt') DESC, id DESC LIMIT ?"
  );
  const nextPage = db.prepare(
    "SELECT payload, revoked_at FROM artifact_publications WHERE org_id=? AND profile_id=? AND session_id=? AND revoked_at IS NULL AND (json_extract(payload, '$.createdAt') < ? OR (json_extract(payload, '$.createdAt') = ? AND id < ?)) ORDER BY json_extract(payload, '$.createdAt') DESC, id DESC LIMIT ?"
  );
  const referenced = db.prepare(
    "SELECT 1 FROM artifact_publications WHERE snapshot_id=? LIMIT 1"
  );
  const revoke = db.prepare(
    "UPDATE artifact_publications SET revoked_at=? WHERE org_id=? AND profile_id=? AND session_id=? AND id=? AND revoked_at IS NULL"
  );
  const decode = (row: Row): StoredArtifactPublicationRecord => ({
    ...JSON.parse(row.payload),
    revokedAt: row.revoked_at,
  });
  return {
    async commitArtifactPublications(identity, records) {
      const fingerprint = publicationCommitFingerprint(identity, records);
      return db
        .transaction(() => {
          if (!activeScope(identity)) {
            throw new Error("Publication scope is unavailable.");
          }
          const previous = existing.get(
            identity.orgId,
            identity.executionId
          ) as { fingerprint: string } | null;
          if (previous) {
            if (previous.fingerprint !== fingerprint) {
              throw new Error(
                "Publication execution conflicts with its committed output set."
              );
            }
            return (
              outputs.all(identity.orgId, identity.executionId) as Row[]
            ).map(decode);
          }
          insertExecution.run(
            identity.orgId,
            identity.executionId,
            identity.profileId,
            identity.sessionId,
            fingerprint
          );
          for (const record of records) {
            insert.run(
              record.id,
              record.orgId,
              record.profileId,
              record.sessionId,
              record.executionId,
              record.outputOrdinal,
              record.snapshotId,
              JSON.stringify(record)
            );
          }
          return structuredClone(
            [...records].sort((a, b) => a.outputOrdinal - b.outputOrdinal)
          );
        })
        .immediate();
    },
    async getArtifactPublication(scope, id) {
      if (!activeScope(scope)) {
        return null;
      }
      const row = byId.get(
        scope.orgId,
        scope.profileId,
        scope.sessionId,
        id
      ) as Row | null;
      return row ? decode(row) : null;
    },
    async isArtifactPublicationSnapshotReferenced(snapshotId) {
      return Boolean(referenced.get(snapshotId));
    },
    async listArtifactPublications(scope, options) {
      validateArtifactPublicationPage(options);
      if (!activeScope(scope)) {
        return [];
      }
      const rows = options.after
        ? nextPage.all(
            scope.orgId,
            scope.profileId,
            scope.sessionId,
            options.after.createdAt,
            options.after.createdAt,
            options.after.id,
            options.limit
          )
        : firstPage.all(
            scope.orgId,
            scope.profileId,
            scope.sessionId,
            options.limit
          );
      return (rows as Row[]).map(decode);
    },
    async revokeArtifactPublication(scope, id, revokedAt) {
      if (!Number.isFinite(Date.parse(revokedAt))) {
        throw new Error("Invalid revocation time.");
      }
      if (!activeScope(scope)) {
        return false;
      }
      return (
        revoke.run(revokedAt, scope.orgId, scope.profileId, scope.sessionId, id)
          .changes > 0
      );
    },
  };
}
