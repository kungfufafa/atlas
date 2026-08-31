import type {
  ListProfileChangeHistoryResponse,
  ProfileChangeEvent,
} from "@atlas/core/contract";

export const PROFILE_HISTORY_PAGE_SIZE = 100;

export function getNextProfileHistoryOffset(
  pages: readonly ListProfileChangeHistoryResponse[]
): number | undefined {
  const lastPage = pages[pages.length - 1];
  if (!lastPage || lastPage.events.length < PROFILE_HISTORY_PAGE_SIZE) {
    return;
  }

  return pages.reduce((total, page) => total + page.events.length, 0);
}

export function mergeProfileHistoryPages(
  pages: readonly ListProfileChangeHistoryResponse[]
): ProfileChangeEvent[] {
  const events: ProfileChangeEvent[] = [];
  const seenIds = new Set<string>();

  for (const page of pages) {
    for (const event of page.events) {
      if (seenIds.has(event.id)) {
        continue;
      }
      seenIds.add(event.id);
      events.push(event);
    }
  }

  return events;
}

const JSON_FIELDS = new Set<ProfileChangeEvent["field"]>([
  "mcp",
  "pack_import",
  "skills",
  "tools",
]);

export function canViewProfileHistory(input: {
  isPlatformAdmin: boolean;
  orgRole: string | null | undefined;
}): boolean {
  return input.isPlatformAdmin || input.orgRole === "admin";
}

export function formatProfileChangeActor(actorUserId: string | null): string {
  if (!actorUserId) {
    return "System";
  }

  return actorUserId.length > 20 ? `${actorUserId.slice(0, 16)}…` : actorUserId;
}

export function formatProfileChangeField(
  field: ProfileChangeEvent["field"]
): string {
  switch (field) {
    case "system_prompt":
      return "System prompt";
    case "soul.soul":
      return "SOUL.md";
    case "soul.style":
      return "STYLE.md";
    case "soul.instructions":
      return "INSTRUCTIONS.md";
    case "soul.memory":
      return "MEMORY.md";
    case "tools":
      return "Tools";
    case "skills":
      return "Skills";
    case "mcp":
      return "MCP servers";
    case "pack_import":
      return "Profile import";
  }
}

export function formatProfileChangeSource(
  source: ProfileChangeEvent["source"]
): string {
  switch (source) {
    case "dashboard":
      return "Dashboard";
    case "super_bot":
      return "Super Agent";
    case "skill_manage":
      return "Skill manager";
    case "pack_import":
      return "Profile import";
  }
}

export function formatProfileChangeValue(
  value: string | null,
  field: ProfileChangeEvent["field"]
): string {
  if (value === null) {
    return "Not set";
  }

  if (value.length === 0) {
    return "Empty";
  }

  if (!JSON_FIELDS.has(field)) {
    return value;
  }

  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
