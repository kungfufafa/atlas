export const SKILL_CURATOR_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export function isSkillCuratorDue(input: {
  enabled: boolean;
  lastRunAt?: string | null;
  now?: Date;
}): boolean {
  if (!input.enabled) {
    return false;
  }

  if (!input.lastRunAt) {
    return true;
  }

  const lastRunAt = Date.parse(input.lastRunAt);
  if (Number.isNaN(lastRunAt)) {
    return true;
  }

  return (
    (input.now?.getTime() ?? Date.now()) - lastRunAt >=
    SKILL_CURATOR_INTERVAL_MS
  );
}
