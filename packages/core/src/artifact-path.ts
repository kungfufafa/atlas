/** Relative deliverable paths belong under artifacts/ so the canvas can open them. */

export function coerceDeliverableArtifactPath(relativePath: string): string {
  const trimmed = relativePath.trim();
  const normalized = trimmed.replaceAll("\\", "/").replace(/^\.\//, "");

  if (normalized.startsWith("artifacts/")) {
    return normalized;
  }

  if (isAbsoluteFilesystemPath(trimmed)) {
    return trimmed;
  }

  return `artifacts/${normalized.replace(/^\/+/, "")}`;
}

function isAbsoluteFilesystemPath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}
