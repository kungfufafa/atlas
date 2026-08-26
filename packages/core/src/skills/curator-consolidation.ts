import { BUNDLED_SKILL_NAMES } from "./bundled-names";
import { isGlobalSkillSourcePath } from "./dedupe";

export const SKILL_CURATOR_MAX_CANDIDATES = 24;
export const SKILL_CURATOR_MAX_CLUSTERS = 3;
export const SKILL_CURATOR_MAX_CLUSTER_MEMBERS = 4;
export const SKILL_CURATOR_MAX_BODY_BYTES = 16 * 1024;
export const SKILL_CURATOR_MAX_TOTAL_BODY_BYTES = 64 * 1024;
export const SKILL_CURATOR_RECENT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const SKILL_CURATOR_HIGH_USE_COUNT = 20;
export const SKILL_CURATOR_MIN_OVERLAP = 0.45;

const bundledSkillNames = new Set<string>(BUNDLED_SKILL_NAMES);

export interface SkillCuratorCandidate {
  body: string;
  createdBy: "agent" | "human" | "bundled";
  description: string;
  enabled: boolean;
  id: string;
  lastPatchedAt?: string | null;
  lastUsedAt?: string | null;
  name: string;
  sourcePath: string;
  updatedAt: string;
  useCount?: number;
}

export type SkillCuratorSkipReason =
  | "bundled_or_global"
  | "disabled"
  | "pending_proposal"
  | "recent"
  | "high_use"
  | "body_too_large";

export interface SkillCuratorCluster {
  losers: SkillCuratorCandidate[];
  winner: SkillCuratorCandidate;
}

export interface SkillCuratorPlan {
  clusters: SkillCuratorCluster[];
  considered: number;
  skipped: Record<SkillCuratorSkipReason | "candidate_budget", number>;
}

export interface SkillCuratorConsolidationSources {
  orgSkillsCuratorConsolidation?: boolean | null;
  profileSkillsCuratorConsolidation?: boolean | null;
}

export function resolveSkillCuratorConsolidationEnabled(
  sources: SkillCuratorConsolidationSources
): boolean {
  if (
    sources.profileSkillsCuratorConsolidation !== undefined &&
    sources.profileSkillsCuratorConsolidation !== null
  ) {
    return sources.profileSkillsCuratorConsolidation;
  }
  return sources.orgSkillsCuratorConsolidation === true;
}

function parseTimestamp(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 2)
  );
}

export function skillCuratorSimilarity(
  left: SkillCuratorCandidate,
  right: SkillCuratorCandidate
): number {
  const leftTokens = tokenize(`${left.name} ${left.description}`);
  const rightTokens = tokenize(`${right.name} ${right.description}`);
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }
  const union = leftTokens.size + rightTokens.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function skipReason(input: {
  candidate: SkillCuratorCandidate;
  nowMs: number;
  pendingSkillIds: ReadonlySet<string>;
}): SkillCuratorSkipReason | null {
  const { candidate } = input;
  if (
    candidate.createdBy === "bundled" ||
    bundledSkillNames.has(candidate.name) ||
    isGlobalSkillSourcePath(candidate.sourcePath)
  ) {
    return "bundled_or_global";
  }
  if (!candidate.enabled) {
    return "disabled";
  }
  if (input.pendingSkillIds.has(candidate.id)) {
    return "pending_proposal";
  }
  const bodyBytes = Buffer.byteLength(candidate.body, "utf8");
  if (bodyBytes > SKILL_CURATOR_MAX_BODY_BYTES) {
    return "body_too_large";
  }
  if ((candidate.useCount ?? 0) >= SKILL_CURATOR_HIGH_USE_COUNT) {
    return "high_use";
  }
  const recentAt = Math.max(
    parseTimestamp(candidate.lastPatchedAt),
    parseTimestamp(candidate.lastUsedAt),
    parseTimestamp(candidate.updatedAt)
  );
  if (recentAt > 0 && input.nowMs - recentAt < SKILL_CURATOR_RECENT_WINDOW_MS) {
    return "recent";
  }
  return null;
}

function compareCandidates(
  left: SkillCuratorCandidate,
  right: SkillCuratorCandidate
): number {
  const useDifference = (right.useCount ?? 0) - (left.useCount ?? 0);
  if (useDifference !== 0) {
    return useDifference;
  }
  const usedDifference =
    parseTimestamp(right.lastUsedAt) - parseTimestamp(left.lastUsedAt);
  if (usedDifference !== 0) {
    return usedDifference;
  }
  return left.id.localeCompare(right.id);
}

/** Pure, deterministic and bounded planner. Candidate bodies are data only. */
export function buildSkillCuratorPlan(input: {
  now?: Date;
  pendingSkillIds?: ReadonlySet<string>;
  skills: SkillCuratorCandidate[];
}): SkillCuratorPlan {
  const skipped: SkillCuratorPlan["skipped"] = {
    body_too_large: 0,
    bundled_or_global: 0,
    candidate_budget: 0,
    disabled: 0,
    high_use: 0,
    pending_proposal: 0,
    recent: 0,
  };
  const eligible: SkillCuratorCandidate[] = [];
  let totalBytes = 0;
  const sortedInput = [...input.skills].sort((left, right) =>
    left.id.localeCompare(right.id)
  );
  for (const candidate of sortedInput) {
    const reason = skipReason({
      candidate,
      nowMs: (input.now ?? new Date()).getTime(),
      pendingSkillIds: input.pendingSkillIds ?? new Set<string>(),
    });
    if (reason) {
      skipped[reason] += 1;
      continue;
    }
    const candidateBytes = Buffer.byteLength(candidate.body, "utf8");
    if (
      eligible.length >= SKILL_CURATOR_MAX_CANDIDATES ||
      totalBytes + candidateBytes > SKILL_CURATOR_MAX_TOTAL_BODY_BYTES
    ) {
      skipped.candidate_budget += 1;
      continue;
    }
    eligible.push(candidate);
    totalBytes += candidateBytes;
  }

  const ranked = [...eligible].sort(compareCandidates);
  const assigned = new Set<string>();
  const clusters: SkillCuratorCluster[] = [];
  for (const seed of ranked) {
    if (
      assigned.has(seed.id) ||
      clusters.length >= SKILL_CURATOR_MAX_CLUSTERS
    ) {
      continue;
    }
    const members = ranked
      .filter(
        (candidate) =>
          !assigned.has(candidate.id) &&
          skillCuratorSimilarity(seed, candidate) >= SKILL_CURATOR_MIN_OVERLAP
      )
      .slice(0, SKILL_CURATOR_MAX_CLUSTER_MEMBERS)
      .sort(compareCandidates);
    if (members.length < 2) {
      continue;
    }
    const [winner, ...losers] = members;
    if (!winner) {
      continue;
    }
    for (const member of members) {
      assigned.add(member.id);
    }
    clusters.push({ losers, winner });
  }

  return { clusters, considered: eligible.length, skipped };
}
