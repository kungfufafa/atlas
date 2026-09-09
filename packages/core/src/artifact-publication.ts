/** Server-resolved identity. Never construct this from model/tool-returned metadata. */
export interface ArtifactPublicationScope {
  orgId: string;
  profileId: string;
  sessionId: string;
}
export interface ArtifactPublicationIdentity extends ArtifactPublicationScope {
  actorId: string;
  executionId: string;
  runId: string;
  toolCallId: string;
}
export interface ArtifactPublication extends ArtifactPublicationIdentity {
  createdAt: string;
  filename: string;
  id: string;
  mimeType: string;
  outputOrdinal: number;
  revokedAt: string | null;
  sha256: string;
  sizeBytes: number;
  sourceEvidence: "tool_output_bytes" | "selected_workspace_capture";
  sourcePath: string;
}
/** Private capture receipt. Stable observed metadata is not an atomic snapshot or authorship proof. */
export interface ArtifactPublicationCaptureEvidence {
  file: {
    device: string;
    inode: string;
    ctimeNs: string;
    linkCount: 1;
    mtimeNs: string;
    sizeBytes: number;
  };
  kind: "selected_workspace_capture";
  observedMetadataStable: true;
  reader: "posix_dirfd_nofollow";
  rootIdentity: { device: string; inode: string };
  sha256: string;
  sizeBytes: number;
  sourcePath: string;
  version: 1;
}
/** Byte producers receive only this capability, never the execution finalizer. */
export interface ArtifactPublicationProducer {
  /**
   * Capture input properties/bytes synchronously before any await, inside the
   * producer failure boundary. Every rejected stage must poison the whole set.
   * Storage failure is retained for the trusted finalizer and does not reject.
   * Invalid input, conflicting output ordinal, cancellation or closed execution
   * rejects; callers must still preserve any previously created workspace receipt.
   * An exact repeated ordinal/path/byte sequence is idempotent.
   */
  stageBytes(input: {
    bytes: Uint8Array;
    sourcePath: string;
    outputOrdinal: number;
  }): Promise<void>;
}

/** Invocation-local byte capability. No ownership, output ordinal or finalizer is exposed. */
export interface ToolArtifactPublisher {
  stageBytes(input: { bytes: Uint8Array; sourcePath: string }): Promise<void>;
}

/** Trusted execution code must create a fresh publisher for each actual invocation. */
export function createToolArtifactPublisher(
  producer: ArtifactPublicationProducer
): ToolArtifactPublisher {
  let nextOrdinal = 0;
  return Object.freeze({
    stageBytes(input: {
      bytes: Uint8Array;
      sourcePath: string;
    }): Promise<void> {
      const outputOrdinal = nextOrdinal++;
      // The trusted producer captures synchronously inside its failure boundary.
      // Defer even property access there so a throwing tool getter poisons the set.
      let sourcePath: string | undefined;
      let bytes: Uint8Array | undefined;
      return producer.stageBytes({
        get bytes() {
          bytes ??= input.bytes;
          return bytes;
        },
        outputOrdinal,
        get sourcePath() {
          sourcePath ??= input.sourcePath;
          return sourcePath;
        },
      });
    },
  });
}

/** Preserve the original successful workspace effect even when staging rejects.
 * The trusted producer retains the rejection and poisons its complete output set.
 * This helper never retries the file producer or grants publication success.
 */
export async function stageToolArtifact(
  publisher: ToolArtifactPublisher | undefined,
  input: { bytes: Uint8Array; sourcePath: string }
): Promise<void> {
  if (!publisher) {
    return;
  }
  try {
    await publisher.stageBytes(input);
  } catch {
    // Publication failure is reported separately by the trusted finalizer.
  }
}

/** Explicit deliverables live under artifacts/, excluding hidden/support metadata paths. */
export function isArtifactPublicationPath(sourcePath: string): boolean {
  const parts = sourcePath.split("/");
  return (
    parts.length >= 2 &&
    parts[0] === "artifacts" &&
    parts.every((part) => part.length > 0 && !part.startsWith(".")) &&
    !/[\\\x00-\x1f\x7f]/.test(sourcePath) &&
    !sourcePath.endsWith(".atlas-meta.json")
  );
}
