import type {
  ListProfileChangeHistoryResponse,
  ProfileChangeEvent,
  ProfileChangeField,
  ProfileChangeSource,
} from "@atlas/core/contract";

export const PROFILE_HISTORY_PAGE_SIZE = 100;

export function getNextProfileHistoryOffset(
  pages: readonly ListProfileChangeHistoryResponse[]
): number | undefined {
  const lastPage = pages.at(-1);
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
      if (!seenIds.has(event.id)) {
        seenIds.add(event.id);
        events.push(event);
      }
    }
  }
  return events;
}

const JSON_FIELDS = new Set<ProfileChangeField>([
  "mcp",
  "pack_import",
  "skills",
  "tools",
]);

export function formatProfileChangeField(field: ProfileChangeField): string {
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

export function formatProfileChangeSource(source: ProfileChangeSource): string {
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

export function formatProfileChangeActor(actorUserId: string | null): string {
  if (!actorUserId) {
    return "System";
  }
  return actorUserId.length > 20 ? `${actorUserId.slice(0, 16)}…` : actorUserId;
}

export function formatProfileChangeValue(
  value: string | null,
  field: ProfileChangeField
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

export function formatProfileChangeTime(
  value: string,
  options: { locale?: string; timeZone?: string } = {}
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown time";
  }

  return new Intl.DateTimeFormat(options.locale, {
    dateStyle: "medium",
    timeStyle: "short",
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  }).format(date);
}

export function formatProfileChangeMetadata(
  event: Pick<ProfileChangeEvent, "actorUserId" | "createdAt" | "source">,
  options: { locale?: string; timeZone?: string } = {}
): string {
  return `${formatProfileChangeTime(event.createdAt, options)} · ${formatProfileChangeSource(event.source)} · ${formatProfileChangeActor(event.actorUserId)}`;
}
