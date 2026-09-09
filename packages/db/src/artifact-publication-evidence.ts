import type { StoredArtifactPublicationRecord } from "./types";

const IDENTITY_NUMBER = /^\d{1,64}$/;
const TIMESTAMP = /^-?\d{1,64}$/;
const HASH = /^[a-f0-9]{64}$/;

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  );
}

/** Canonical private evidence binding. Generated-byte fingerprints remain unchanged. */
export function publicationSourceEvidenceFingerprint(
  record: Pick<
    StoredArtifactPublicationRecord,
    "captureEvidence" | "sourceEvidence" | "sourcePath" | "sha256" | "sizeBytes"
  >
): string | undefined {
  if (record.sourceEvidence === "tool_output_bytes") {
    if (record.captureEvidence !== undefined) {
      throw new Error(
        "Generated output cannot contain selected-file evidence."
      );
    }
    return;
  }
  const capture = record.captureEvidence;
  if (
    record.sourceEvidence !== "selected_workspace_capture" ||
    !capture ||
    typeof capture !== "object" ||
    !exactKeys(capture, [
      "file",
      "kind",
      "observedMetadataStable",
      "reader",
      "rootIdentity",
      "sha256",
      "sizeBytes",
      "sourcePath",
      "version",
    ]) ||
    !capture.file ||
    typeof capture.file !== "object" ||
    !exactKeys(capture.file, [
      "device",
      "inode",
      "ctimeNs",
      "linkCount",
      "mtimeNs",
      "sizeBytes",
    ]) ||
    !capture.rootIdentity ||
    typeof capture.rootIdentity !== "object" ||
    !exactKeys(capture.rootIdentity, ["device", "inode"]) ||
    capture.kind !== "selected_workspace_capture" ||
    capture.version !== 1 ||
    capture.reader !== "posix_dirfd_nofollow" ||
    capture.observedMetadataStable !== true ||
    capture.file.linkCount !== 1 ||
    ![
      capture.file.device,
      capture.file.inode,
      capture.rootIdentity.device,
      capture.rootIdentity.inode,
    ].every(
      (value) => typeof value === "string" && IDENTITY_NUMBER.test(value)
    ) ||
    ![capture.file.ctimeNs, capture.file.mtimeNs].every(
      (value) => typeof value === "string" && TIMESTAMP.test(value)
    ) ||
    typeof capture.sha256 !== "string" ||
    !HASH.test(capture.sha256) ||
    capture.sourcePath !== record.sourcePath ||
    capture.sha256 !== record.sha256 ||
    !Number.isSafeInteger(capture.sizeBytes) ||
    capture.sizeBytes < 0 ||
    capture.sizeBytes !== record.sizeBytes ||
    capture.file.sizeBytes !== record.sizeBytes
  ) {
    throw new Error("Invalid selected-file publication evidence.");
  }
  return JSON.stringify([
    capture.version,
    capture.kind,
    capture.reader,
    capture.observedMetadataStable,
    capture.sourcePath,
    capture.sha256,
    capture.sizeBytes,
    capture.rootIdentity.device,
    capture.rootIdentity.inode,
    capture.file.device,
    capture.file.inode,
    capture.file.sizeBytes,
    capture.file.linkCount,
    capture.file.mtimeNs,
    capture.file.ctimeNs,
  ]);
}
