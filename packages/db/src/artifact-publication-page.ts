import type { ArtifactPublicationPageOptions } from "./types";

export function comparePublicationKeys(
  left: { createdAt: string; id: string },
  right: { createdAt: string; id: string }
): number {
  return (
    Buffer.compare(Buffer.from(left.createdAt), Buffer.from(right.createdAt)) ||
    Buffer.compare(Buffer.from(left.id), Buffer.from(right.id))
  );
}

export function validateArtifactPublicationPage(
  options: ArtifactPublicationPageOptions
): void {
  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 101
  ) {
    throw new Error("Publication page limit must be between 1 and 101.");
  }
  if (
    options.after &&
    (!(
      Number.isFinite(Date.parse(options.after.createdAt)) &&
      options.after.id.trim()
    ) ||
      options.after.id.length > 100)
  ) {
    throw new Error("Invalid publication cursor.");
  }
}
