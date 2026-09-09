import type { ArtifactPublicationIdentity } from "@atlas/core/artifact-publication";
import { publicationSourceEvidenceFingerprint } from "./artifact-publication-evidence";
import type { StoredArtifactPublicationRecord } from "./types";

const ID = /^[^\x00-\x1f\x7f]{1,256}$/;
const HASH = /^[a-f0-9]{64}$/;
const SNAPSHOT = /^snapshot_[a-f0-9-]{36}$/;
const PUBLICATION = /^publication_[a-f0-9-]{36}$/;
const PATH = /^artifacts\/(?!\.)(?:[^\\\x00-\x1f\x7f]+)$/;
export const MAX_PUBLICATION_OUTPUTS = 32;
export const MAX_PUBLICATION_BYTES = 25 * 1024 * 1024;
export function publicationIdentity(
  identity: ArtifactPublicationIdentity
): string {
  const fields = [
    identity.orgId,
    identity.profileId,
    identity.sessionId,
    identity.actorId,
    identity.runId,
    identity.executionId,
    identity.toolCallId,
  ];
  if (
    fields.some(
      (value) =>
        typeof value !== "string" || value !== value.trim() || !ID.test(value)
    )
  ) {
    throw new Error("Invalid publication identity.");
  }
  return JSON.stringify(fields);
}
export function validatePublicationPath(sourcePath: string): void {
  if (
    typeof sourcePath !== "string" ||
    sourcePath.length > 1024 ||
    !PATH.test(sourcePath) ||
    sourcePath
      .split("/")
      .some(
        (part) => !part || part === "." || part === ".." || part.startsWith(".")
      )
  ) {
    throw new Error("A canonical visible artifacts/ path is required.");
  }
}
export function publicationCommitFingerprint(
  identity: ArtifactPublicationIdentity,
  records: readonly StoredArtifactPublicationRecord[]
): string {
  const owner = publicationIdentity(identity);
  if (records.length > MAX_PUBLICATION_OUTPUTS) {
    throw new Error("Too many publication outputs.");
  }
  const ordinals = new Set<number>();
  const rows = [...records]
    .sort((a, b) => a.outputOrdinal - b.outputOrdinal)
    .map((record) => {
      validatePublicationPath(record.sourcePath);
      if (
        publicationIdentity(record) !== owner ||
        !Number.isSafeInteger(record.outputOrdinal) ||
        record.outputOrdinal < 0 ||
        record.outputOrdinal >= MAX_PUBLICATION_OUTPUTS ||
        ordinals.has(record.outputOrdinal) ||
        !Number.isSafeInteger(record.sizeBytes) ||
        record.sizeBytes < 0 ||
        record.sizeBytes > MAX_PUBLICATION_BYTES ||
        !HASH.test(record.sha256) ||
        !SNAPSHOT.test(record.snapshotId) ||
        !PUBLICATION.test(record.id) ||
        record.filename !== record.sourcePath.split("/").at(-1) ||
        !record.mimeType ||
        record.mimeType.length > 200 ||
        !Number.isFinite(Date.parse(record.createdAt)) ||
        record.revokedAt !== null
      ) {
        throw new Error("Invalid publication record.");
      }
      ordinals.add(record.outputOrdinal);
      const row = [
        record.outputOrdinal,
        record.sourcePath,
        record.filename,
        record.mimeType,
        record.sizeBytes,
        record.sha256,
        record.sourceEvidence,
      ];
      const captureFingerprint = publicationSourceEvidenceFingerprint(record);
      if (captureFingerprint !== undefined) {
        row.push(captureFingerprint);
      }
      return row;
    });
  return JSON.stringify([owner, rows]);
}
