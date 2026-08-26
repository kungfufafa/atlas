import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
  AtlasApiError,
  applyRedactionBoundary,
  buildSkillCuratorPlan,
  discoverSkillDirectory,
  isGlobalSkillSourcePath,
  isPathWithinProfileSkillsDir,
  isSkillCuratorDue,
  parseRawProfileSkillContent,
  resolveSkillCuratorConsolidationEnabled,
  SKILL_CURATOR_MAX_BODY_BYTES,
  type SkillCuratorCandidate,
} from "@atlas/core";
import type {
  SkillCuratorRunResult,
  SkillCuratorStatusResponse,
} from "@atlas/core/contract";
import type {
  DatabaseAdapter,
  StoredProfileRecord,
  StoredSkillRecord,
} from "@atlas/db";
import type { SkillProposalService } from "./skill-proposal-service";

export type SkillCuratorGenerateMarkdown = (input: {
  losers: Array<{ body: string; description: string; name: string }>;
  profileId: string;
  winner: { body: string; description: string; name: string };
}) => Promise<string | null>;

export interface SkillCuratorRunOptions {
  now?: Date;
  profileId?: string;
  proposedByUserId?: string | null;
  trigger: "manual" | "scheduled";
}

interface CandidateWithRaw {
  candidate: SkillCuratorCandidate;
  raw: string;
  record: StoredSkillRecord;
}

export class SkillCuratorService {
  private readonly inFlight = new Set<string>();
  private readonly latest = new Map<string, SkillCuratorRunResult>();

  constructor(
    private readonly db: DatabaseAdapter,
    private readonly proposals: SkillProposalService,
    private readonly generateMarkdown: SkillCuratorGenerateMarkdown = async () =>
      null
  ) {}

  status(
    orgId: string
  ): SkillCuratorStatusResponse | Promise<SkillCuratorStatusResponse> {
    return this.resolveStatus(orgId);
  }

  async run(
    orgId: string,
    options: SkillCuratorRunOptions
  ): Promise<SkillCuratorRunResult> {
    const key = orgId;
    const startedAt = (options.now ?? new Date()).toISOString();
    if (this.inFlight.has(key)) {
      return this.buildResult(orgId, options, startedAt, {
        status: "in_flight",
      });
    }
    this.inFlight.add(key);
    try {
      const result = await this.runLocked(orgId, options, startedAt);
      this.latest.set(orgId, result);
      return result;
    } finally {
      this.inFlight.delete(key);
    }
  }

  async runDue(
    orgId: string,
    options: { now?: Date } = {}
  ): Promise<SkillCuratorRunResult | null> {
    const organization = await this.db.getOrganizationById(orgId);
    if (!organization || organization.archivedAt) {
      throw new AtlasApiError("Not found", 404);
    }
    const now = options.now ?? new Date();
    if (
      !isSkillCuratorDue({
        enabled: organization.skillsCuratorConsolidation === true,
        lastRunAt: organization.skillsCuratorLastRunAt,
        now,
      })
    ) {
      return null;
    }

    const result = await this.run(orgId, { now, trigger: "scheduled" });
    if (result.status === "in_flight") {
      return null;
    }
    if (result.status === "completed" || result.status === "disabled") {
      await this.db.markSkillCuratorRunCompleted(orgId, result.finishedAt);
    }
    return result;
  }

  private async resolveStatus(
    orgId: string
  ): Promise<SkillCuratorStatusResponse> {
    const org = await this.db.getOrganizationById(orgId);
    if (!org || org.archivedAt) {
      throw new AtlasApiError("Not found", 404);
    }
    return {
      enabled: org.skillsCuratorConsolidation === true,
      lastRunAt: org.skillsCuratorLastRunAt ?? null,
      latest: this.latest.get(orgId) ?? null,
    };
  }

  private async runLocked(
    orgId: string,
    options: SkillCuratorRunOptions,
    startedAt: string
  ): Promise<SkillCuratorRunResult> {
    const organization = await this.db.getOrganizationById(orgId);
    if (!organization || organization.archivedAt) {
      throw new AtlasApiError("Not found", 404);
    }
    const allProfiles = await this.db.listProfilesForOrg(orgId);
    const profiles = options.profileId
      ? allProfiles.filter((profile) => profile.id === options.profileId)
      : allProfiles;
    if (options.profileId && profiles.length === 0) {
      throw new AtlasApiError("Profile not found.", 404);
    }
    const enabledProfiles = profiles.filter((profile) =>
      resolveSkillCuratorConsolidationEnabled({
        orgSkillsCuratorConsolidation:
          organization.skillsCuratorConsolidation ?? false,
        profileSkillsCuratorConsolidation:
          profile.skillsCuratorConsolidation ?? null,
      })
    );
    if (enabledProfiles.length === 0) {
      return this.buildResult(orgId, options, startedAt, {
        profileIds: profiles.map((profile) => profile.id),
        status: "disabled",
      });
    }

    const activeProfileIds = await this.findActiveWorkProfileIds(orgId);
    let considered = 0;
    let skippedAutomationOrTask = 0;
    let skippedGeneration = 0;
    let skippedInvalid = 0;
    let staged = 0;
    for (const profile of enabledProfiles) {
      if (activeProfileIds.has(profile.id)) {
        skippedAutomationOrTask += 1;
        continue;
      }
      const candidates = await this.loadCandidates(orgId, profile);
      const pending = await this.db.listSkillProposals(orgId, {
        profileId: profile.id,
        status: "pending",
      });
      const pendingIds = new Set<string>();
      for (const proposal of pending) {
        const matching = candidates.find(
          (candidate) => candidate.record.name === proposal.skillName
        );
        if (matching) {
          pendingIds.add(matching.record.id);
        }
        if (proposal.consolidation) {
          pendingIds.add(proposal.consolidation.winner.id);
          for (const loser of proposal.consolidation.losers) {
            pendingIds.add(loser.id);
          }
        }
      }
      const byId = new Map(
        candidates.map((candidate) => [candidate.record.id, candidate])
      );
      const plan = buildSkillCuratorPlan({
        now: options.now,
        pendingSkillIds: pendingIds,
        skills: candidates.map((entry) => entry.candidate),
      });
      considered += plan.considered;
      for (const cluster of plan.clusters) {
        const winner = byId.get(cluster.winner.id);
        const losers = cluster.losers
          .map((loser) => byId.get(loser.id))
          .filter((entry): entry is CandidateWithRaw => Boolean(entry));
        if (!winner || losers.length !== cluster.losers.length) {
          skippedInvalid += 1;
          continue;
        }
        let markdown: string | null;
        try {
          markdown = await this.generateMarkdown({
            losers: losers.map((entry) => ({
              body: entry.candidate.body,
              description: entry.candidate.description,
              name: entry.record.name,
            })),
            profileId: profile.id,
            winner: {
              body: winner.candidate.body,
              description: winner.candidate.description,
              name: winner.record.name,
            },
          });
        } catch {
          skippedGeneration += 1;
          continue;
        }
        if (!markdown?.trim()) {
          skippedGeneration += 1;
          continue;
        }
        try {
          const parsed = parseRawProfileSkillContent(
            markdown,
            orgId,
            profile.id
          );
          if (parsed.name !== winner.record.name) {
            throw new Error("Winner name changed");
          }
          await this.recheckActive(orgId, profile.id);
          const stageResult = await this.proposals.stageProposal({
            action: "consolidate",
            consolidation: {
              losers: losers.map((entry) => ({
                id: entry.record.id,
                name: entry.record.name,
                sha256: hash(entry.raw),
              })),
              winner: {
                id: winner.record.id,
                name: winner.record.name,
                sha256: hash(winner.raw),
              },
            },
            content: markdown,
            orgId,
            profileId: profile.id,
            proposedByUserId: options.proposedByUserId ?? null,
            skillName: winner.record.name,
          });
          if (stageResult.outcome === "created") {
            staged += 1;
          }
        } catch {
          skippedInvalid += 1;
        }
      }
    }

    return this.buildResult(orgId, options, startedAt, {
      considered,
      profileIds: enabledProfiles.map((profile) => profile.id),
      skippedAutomationOrTask,
      skippedGeneration,
      skippedInvalid,
      staged,
      status: "completed",
    });
  }

  private async loadCandidates(
    orgId: string,
    profile: StoredProfileRecord
  ): Promise<CandidateWithRaw[]> {
    const [assigned, usage] = await Promise.all([
      this.db.listSkillsForProfile(profile.id),
      this.db.listSkillUsageForProfile(profile.id),
    ]);
    const usageById = new Map(usage.map((entry) => [entry.skillId, entry]));
    const result: CandidateWithRaw[] = [];
    for (const record of assigned) {
      if (
        record.createdBy === "bundled" ||
        isGlobalSkillSourcePath(record.sourcePath) ||
        !isPathWithinProfileSkillsDir(orgId, profile.id, record.sourcePath)
      ) {
        continue;
      }
      const skillFile = path.join(record.sourcePath, "SKILL.md");
      try {
        const stats = await lstat(skillFile);
        if (
          !stats.isFile() ||
          stats.isSymbolicLink() ||
          stats.size > SKILL_CURATOR_MAX_BODY_BYTES
        ) {
          continue;
        }
        const raw = await readFile(skillFile, "utf8");
        const discovered = await discoverSkillDirectory(record.sourcePath);
        if (!discovered || discovered.name !== record.name) {
          continue;
        }
        const usageEntry = usageById.get(record.id);
        const safeBody = applyRedactionBoundary(discovered.body, "learning");
        const safeDescription = applyRedactionBoundary(
          record.description,
          "learning"
        );
        result.push({
          candidate: {
            body: safeBody,
            createdBy: record.createdBy,
            description: safeDescription,
            enabled: record.enabled,
            id: record.id,
            lastPatchedAt: usageEntry?.lastPatchedAt,
            lastUsedAt: usageEntry?.lastUsedAt,
            name: record.name,
            sourcePath: record.sourcePath,
            updatedAt: record.updatedAt,
            useCount: usageEntry?.useCount,
          },
          raw,
          record,
        });
      } catch {
        // An unreadable or concurrently changed skill is not a safe candidate.
      }
    }
    return result;
  }

  private async findActiveWorkProfileIds(orgId: string): Promise<Set<string>> {
    const [automations, tasks] = await Promise.all([
      this.db.listAutomationsForOrg(orgId),
      this.db.listTasksForOrg(orgId),
    ]);
    const ids = new Set(
      automations
        .filter((automation) => automation.enabled)
        .map((automation) => automation.profileId)
    );
    for (const task of tasks) {
      if (task.status !== "done" && task.status !== "failed") {
        ids.add(task.profileId);
      }
    }
    return ids;
  }

  private async recheckActive(orgId: string, profileId: string): Promise<void> {
    const [organization, profile] = await Promise.all([
      this.db.getOrganizationById(orgId),
      this.db.getProfileForOrg(profileId, orgId),
    ]);
    if (
      !organization ||
      organization.archivedAt ||
      !profile ||
      !resolveSkillCuratorConsolidationEnabled({
        orgSkillsCuratorConsolidation:
          organization.skillsCuratorConsolidation ?? false,
        profileSkillsCuratorConsolidation:
          profile.skillsCuratorConsolidation ?? null,
      })
    ) {
      throw new AtlasApiError("Workspace or curator setting changed.", 409);
    }
  }

  private buildResult(
    orgId: string,
    options: SkillCuratorRunOptions,
    startedAt: string,
    values: Partial<SkillCuratorRunResult>
  ): SkillCuratorRunResult {
    return {
      considered: values.considered ?? 0,
      finishedAt: new Date().toISOString(),
      orgId,
      profileIds: values.profileIds ?? [],
      skippedAutomationOrTask: values.skippedAutomationOrTask ?? 0,
      skippedGeneration: values.skippedGeneration ?? 0,
      skippedInvalid: values.skippedInvalid ?? 0,
      staged: values.staged ?? 0,
      startedAt,
      status: values.status ?? "completed",
      trigger: options.trigger,
    };
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
