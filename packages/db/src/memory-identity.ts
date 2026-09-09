import type { StoredMemoryRecord } from "./types";

function normalizedSubject(subject: string | null | undefined): string | null {
  return subject?.normalize("NFKC").trim().toLowerCase() || null;
}

/** Exact fact identity, never a fuzzy or same-topic replacement decision. */
export function isExactMemoryFact(
  existing: StoredMemoryRecord,
  incoming: StoredMemoryRecord
): boolean {
  return (
    existing.orgId === incoming.orgId &&
    existing.ownerId === incoming.ownerId &&
    existing.scope === incoming.scope &&
    existing.content.trim() === incoming.content.trim() &&
    normalizedSubject(existing.subject) === normalizedSubject(incoming.subject)
  );
}
