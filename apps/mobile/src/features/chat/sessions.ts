import type { SessionSummary } from "@atlas/core/contract";

const MAX_SESSION_LINE_LENGTH = 80;

export function collapseSessionText(value: string | null | undefined): string {
  if (!value) {
    return "";
  }

  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SESSION_LINE_LENGTH);
}

export function displaySessionTitle(title: string | null | undefined): string {
  return collapseSessionText(title) || "Untitled chat";
}

export function displaySessionPreview(
  preview: string | null | undefined
): string | null {
  return collapseSessionText(preview) || null;
}

export function mergeSessionsByRecency(
  groups: SessionSummary[][]
): SessionSummary[] {
  return groups.flat().sort((left, right) => {
    if (left.updatedAt === right.updatedAt) {
      return right.id.localeCompare(left.id);
    }
    return left.updatedAt < right.updatedAt ? 1 : -1;
  });
}
