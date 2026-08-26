import { getUserMessageText, type MessageContentPart } from "@atlas/core";
import { LOCAL_CLIENT_USER_ID } from "@atlas/core/local-auth";
import { LLM_USAGE_STATS_ID } from "../constants";
import type {
  DatabaseAdapter,
  LlmUsageAggregateRow,
  LlmUsageStatsDelta,
  ProfileImportPublication,
  StoredActionApprovalRecord,
  StoredArtifactShareRecord,
  StoredAttachmentRecord,
  StoredAuditEventRecord,
  StoredAutomationRecord,
  StoredAutomationRunRecord,
  StoredBrowserSessionRecord,
  StoredChannelOrgMappingRecord,
  StoredComposioToolkitRecord,
  StoredComposioUserConnectionRecord,
  StoredExecutionRunRecord,
  StoredExecutionStepRecord,
  StoredLearningCandidateRecord,
  StoredLearningCommitRecord,
  StoredLearningEvidenceRecord,
  StoredLearningJobRecord,
  StoredLearningOutcomeRecord,
  StoredLlmTurnUsageRecord,
  StoredLlmUsageDailyRecord,
  StoredLlmUsageModelStatsRecord,
  StoredLlmUsageStatsRecord,
  StoredMcpServerRecord,
  StoredMemoryRecord,
  StoredNotificationDestinationRecord,
  StoredOrgAiConfigRecord,
  StoredOrganizationRecord,
  StoredOrgInviteRecord,
  StoredOrgMemberRecord,
  StoredOrgMemoryProposal,
  StoredOrgUsageBudgetRecord,
  StoredOutboxRecord,
  StoredProfileComposioToolkitRecord,
  StoredProfileRecord,
  StoredSessionMessageRecord,
  StoredSessionRecord,
  StoredSessionSummaryRecord,
  StoredSkillProposal,
  StoredSkillRecord,
  StoredSkillRevisionRecord,
  StoredSkillSuggestion,
  StoredSkillUsageRecord,
  StoredTaskRecord,
  StoredTaskRunRecord,
  StoredToolOutputSavingsRecord,
  StoredToolRecord,
  StoredUserOrganizationRecord,
  StoredUserRecord,
  StoredWorkspaceSettingsRecord,
} from "../types";

function mcpServerNameKey(
  orgId: string | null | undefined,
  name: string
): string {
  return `${orgId ?? ""}\0${name}`;
}

function toolNameKey(orgId: string | null | undefined, name: string): string {
  return `${orgId ?? ""}\0${name}`;
}

function canonicalJson(value: unknown): string | null {
  const seen = new Set<object>();
  const normalize = (current: unknown): unknown => {
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw new Error("Non-finite JSON number");
      }
      return current;
    }
    if (Array.isArray(current)) {
      if (seen.has(current)) {
        throw new Error("Cyclic JSON value");
      }
      seen.add(current);
      const normalized = current.map(normalize);
      seen.delete(current);
      return normalized;
    }
    if (typeof current === "object" && current) {
      if (seen.has(current)) {
        throw new Error("Cyclic JSON value");
      }
      seen.add(current);
      const normalized: Record<string, unknown> = {};
      for (const key of Object.keys(current).sort()) {
        const item = (current as Record<string, unknown>)[key];
        if (item !== undefined) {
          normalized[key] = normalize(item);
        }
      }
      seen.delete(current);
      return normalized;
    }
    throw new Error("Non-JSON value");
  };

  try {
    return JSON.stringify(normalize(value));
  } catch {
    return null;
  }
}

function importToolExpectationMatches(
  current: StoredToolRecord,
  expected: ProfileImportPublication["expectedTools"][number]
): boolean {
  const currentConfig = canonicalJson(current.handlerConfig);
  return (
    current.id === expected.id &&
    current.name === expected.name &&
    current.description === expected.description &&
    current.handlerType === expected.handlerType &&
    current.orgId === expected.orgId &&
    currentConfig !== null &&
    currentConfig === canonicalJson(expected.handlerConfig)
  );
}

function readConversationMessagePayload(payload: unknown): {
  role: string;
  text: string;
} {
  if (typeof payload === "string") {
    return { role: "user", text: payload };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { role: "user", text: JSON.stringify(payload ?? "") };
  }

  const record = payload as Record<string, unknown>;
  return {
    role: typeof record.role === "string" ? record.role : "user",
    text:
      typeof record.content === "string"
        ? record.content
        : JSON.stringify(record.content ?? ""),
  };
}

const IN_MEMORY_ACTIVE_EXECUTION_STATUSES = new Set([
  "queued",
  "running",
  "awaiting_approval",
]);

function executionRunInsertConflict(
  executionRuns: Map<string, StoredExecutionRunRecord>,
  record: StoredExecutionRunRecord
): string | null {
  if (record.idempotencyKey) {
    const conflict = [...executionRuns.values()].find(
      (existing) =>
        existing.id !== record.id &&
        existing.orgId === record.orgId &&
        existing.idempotencyKey === record.idempotencyKey
    );
    if (conflict) {
      return "UNIQUE constraint failed: execution_runs_org_idempotency";
    }
  }
  if (
    record.kind === "automation" &&
    record.sessionId &&
    IN_MEMORY_ACTIVE_EXECUTION_STATUSES.has(record.status)
  ) {
    const conflict = [...executionRuns.values()].find(
      (existing) =>
        existing.id !== record.id &&
        existing.orgId === record.orgId &&
        existing.sessionId === record.sessionId &&
        existing.kind === "automation" &&
        IN_MEMORY_ACTIVE_EXECUTION_STATUSES.has(existing.status)
    );
    if (conflict) {
      return "UNIQUE constraint failed: execution_runs_active_automation";
    }
  }
  return null;
}

export function createInMemoryDatabaseAdapter(): DatabaseAdapter {
  const automations = new Map<string, StoredAutomationRecord>();
  const automationRuns = new Map<string, StoredAutomationRunRecord[]>();
  const automationRunReadState = new Map<
    string,
    {
      userId: string;
      orgId: string;
      automationId: string;
      readThroughAt: string;
    }
  >();
  const tasks = new Map<string, StoredTaskRecord>();
  const taskRuns = new Map<string, StoredTaskRunRecord[]>();
  const profiles = new Map<string, StoredProfileRecord>();
  const tools = new Map<string, StoredToolRecord>();
  const toolsByName = new Map<string, StoredToolRecord>();
  const profileTools = new Map<string, Set<string>>();
  const mcpServers = new Map<string, StoredMcpServerRecord>();
  const mcpServersByName = new Map<string, StoredMcpServerRecord>();
  const profileMcpServers = new Map<string, Set<string>>();
  const skills = new Map<string, StoredSkillRecord>();
  const skillsBySourcePath = new Map<string, StoredSkillRecord>();
  const profileSkills = new Map<string, Set<string>>();
  const skillUsage = new Map<string, StoredSkillUsageRecord>();
  const sessions = new Map<string, StoredSessionRecord>();
  const sessionMessages = new Map<string, StoredSessionMessageRecord[]>();
  const attachments = new Map<string, StoredAttachmentRecord>();
  const usersById = new Map<string, StoredUserRecord>();
  const usersByEmail = new Map<string, StoredUserRecord>();
  const browserSessionsByHash = new Map<string, StoredBrowserSessionRecord>();
  const organizations = new Map<string, StoredOrganizationRecord>();
  const organizationsBySlug = new Map<string, StoredOrganizationRecord>();
  const orgMembers = new Map<string, StoredOrgMemberRecord>();
  const orgInvites = new Map<string, StoredOrgInviteRecord>();
  const orgInvitesByTokenHash = new Map<string, StoredOrgInviteRecord>();
  const orgMemoryProposals = new Map<string, StoredOrgMemoryProposal>();
  const skillProposals = new Map<string, StoredSkillProposal>();
  const skillSuggestions = new Map<string, StoredSkillSuggestion>();
  const artifactShares = new Map<string, StoredArtifactShareRecord>();
  const artifactSharesByTokenHash = new Map<
    string,
    StoredArtifactShareRecord
  >();
  let llmUsageStats: StoredLlmUsageStatsRecord | null = null;
  const llmUsageByModel = new Map<string, StoredLlmUsageModelStatsRecord>();
  const toolOutputSavings = new Map<string, StoredToolOutputSavingsRecord>();
  const llmTurnUsage = new Map<string, StoredLlmTurnUsageRecord>();
  let workspaceSettings: StoredWorkspaceSettingsRecord | null = null;
  const orgWorkspaceSettings = new Map<string, StoredWorkspaceSettingsRecord>();
  const orgAiConfigs = new Map<string, StoredOrgAiConfigRecord>();
  const notificationDestinations = new Map<
    string,
    StoredNotificationDestinationRecord
  >();
  const composioToolkits = new Map<string, StoredComposioToolkitRecord>();
  const composioUserConnections = new Map<
    string,
    StoredComposioUserConnectionRecord
  >();
  const profileComposioToolkits = new Map<
    string,
    StoredProfileComposioToolkitRecord[]
  >();
  const memories = new Map<string, StoredMemoryRecord>();
  const memoryKey = (orgId: string, id: string) => `${orgId}:${id}`;
  const channelOrgMappings = new Map<string, StoredChannelOrgMappingRecord>();
  const executionRuns = new Map<string, StoredExecutionRunRecord>();
  const executionSteps = new Map<string, StoredExecutionStepRecord[]>();
  const actionApprovals = new Map<string, StoredActionApprovalRecord>();
  const learningEvidence = new Map<string, StoredLearningEvidenceRecord>();
  const learningCandidates = new Map<string, StoredLearningCandidateRecord>();
  const learningCommits = new Map<string, StoredLearningCommitRecord>();
  const learningOutcomes = new Map<string, StoredLearningOutcomeRecord[]>();
  const skillRevisions = new Map<string, StoredSkillRevisionRecord[]>();
  const learningJobs = new Map<string, StoredLearningJobRecord>();
  const auditEvents = new Map<string, StoredAuditEventRecord>();
  const outboundOutbox = new Map<string, StoredOutboxRecord>();
  const mappingKey = (channel: string, channelUserId: string) =>
    `${channel}:${channelUserId}`;
  const llmUsageDaily = new Map<string, StoredLlmUsageDailyRecord>();
  const orgUsageBudgets = new Map<string, StoredOrgUsageBudgetRecord>();

  return {
    aggregateLlmUsage(options) {
      const keyOf = (record: StoredLlmUsageDailyRecord): string => {
        if (options.groupBy === "user") {
          return record.userId;
        }
        if (options.groupBy === "profile") {
          return record.profileId;
        }
        if (options.groupBy === "provider") {
          return record.providerType;
        }
        if (options.groupBy === "credential") {
          return record.providerCredentialId;
        }
        if (options.groupBy === "model") {
          return record.modelId;
        }
        return record.orgId;
      };

      const totals = new Map<string, LlmUsageAggregateRow>();
      for (const record of llmUsageDaily.values()) {
        if (options.orgId && record.orgId !== options.orgId) {
          continue;
        }
        if (options.userId && record.userId !== options.userId) {
          continue;
        }
        if (options.from && record.day < options.from) {
          continue;
        }
        if (options.to && record.day > options.to) {
          continue;
        }

        const key = keyOf(record);
        const row = totals.get(key) ?? {
          estimatedCostUsd: 0,
          inputTokens: 0,
          key,
          outputTokens: 0,
          requestCount: 0,
          totalTokens: 0,
        };
        row.requestCount += record.requestCount;
        row.inputTokens += record.inputTokens;
        row.outputTokens += record.outputTokens;
        row.estimatedCostUsd += record.estimatedCostUsd;
        row.totalTokens = row.inputTokens + row.outputTokens;
        totals.set(key, row);
      }

      let rows = [...totals.values()].sort(
        (left, right) => right.totalTokens - left.totalTokens
      );
      if (typeof options.limit === "number" && options.limit > 0) {
        rows = rows.slice(0, Math.floor(options.limit));
      }
      return Promise.resolve(rows);
    },
    async appendMessagesForSession(sessionId, messages) {
      const existing = sessionMessages.get(sessionId) ?? [];
      sessionMessages.set(sessionId, [...existing, ...messages]);
    },

    async applySkillConsolidation(input) {
      const organization = organizations.get(input.orgId);
      const profile = profiles.get(input.profileId);
      const proposal = skillProposals.get(input.proposalId);
      if (
        !organization ||
        organization.archivedAt ||
        profile?.orgId !== input.orgId ||
        profile.isImporting ||
        !proposal ||
        proposal.orgId !== input.orgId ||
        proposal.profileId !== input.profileId ||
        proposal.status !== "pending" ||
        proposal.action !== "consolidate" ||
        JSON.stringify(proposal.consolidation) !==
          JSON.stringify(input.expectedConsolidation)
      ) {
        return false;
      }
      const assigned = profileSkills.get(input.profileId) ?? new Set<string>();
      const expectedRefs = [
        input.expectedConsolidation.winner,
        ...input.expectedConsolidation.losers,
      ];
      const archivedById = new Map(
        input.archivedLosers.map((loser) => [loser.id, loser])
      );
      if (
        expectedRefs.length < 2 ||
        archivedById.size !== input.expectedConsolidation.losers.length
      ) {
        return false;
      }
      for (const reference of expectedRefs) {
        const skill = skills.get(reference.id);
        if (
          !(skill && skill.enabled) ||
          skill.orgId !== input.orgId ||
          skill.name !== reference.name ||
          !assigned.has(reference.id)
        ) {
          return false;
        }
      }
      if (
        input.winner.id !== input.expectedConsolidation.winner.id ||
        input.winner.name !== input.expectedConsolidation.winner.name ||
        input.winner.orgId !== input.orgId
      ) {
        return false;
      }
      for (const reference of input.expectedConsolidation.losers) {
        const archived = archivedById.get(reference.id);
        if (!archived || archived.name !== reference.name) {
          return false;
        }
      }

      const nextSkills = new Map(skills);
      nextSkills.set(input.winner.id, input.winner);
      for (const loser of input.archivedLosers) {
        const current = nextSkills.get(loser.id);
        if (!current) {
          return false;
        }
        nextSkills.set(loser.id, {
          ...current,
          enabled: false,
          sourcePath: loser.archivedSourcePath,
          updatedAt: input.reviewedAt,
        });
      }
      for (const [id, record] of nextSkills) {
        skills.set(id, record);
      }
      skillsBySourcePath.clear();
      for (const record of skills.values()) {
        skillsBySourcePath.set(record.sourcePath, record);
      }
      for (const loser of input.archivedLosers) {
        assigned.delete(loser.id);
      }
      profileSkills.set(input.profileId, assigned);
      skillProposals.set(input.proposalId, {
        ...proposal,
        reviewedAt: input.reviewedAt,
        reviewerUserId: input.reviewerUserId,
        status: "approved",
      });
      return true;
    },

    async assignMcpServerToProfile(profileId, serverId) {
      if (profiles.get(profileId)?.isImporting) {
        return;
      }
      const assigned = profileMcpServers.get(profileId) ?? new Set<string>();
      assigned.add(serverId);
      profileMcpServers.set(profileId, assigned);
    },

    async assignSkillToProfile(profileId, skillId) {
      if (profiles.get(profileId)?.isImporting) {
        return;
      }
      const assigned = profileSkills.get(profileId) ?? new Set<string>();
      assigned.add(skillId);
      profileSkills.set(profileId, assigned);
    },

    async assignToolToProfile(profileId, toolId) {
      if (profiles.get(profileId)?.isImporting) {
        return;
      }
      const assigned = profileTools.get(profileId) ?? new Set<string>();
      assigned.add(toolId);
      profileTools.set(profileId, assigned);
    },
    async casExecutionRun(input) {
      const existing = executionRuns.get(input.id);
      if (!existing) {
        return false;
      }
      if (!IN_MEMORY_ACTIVE_EXECUTION_STATUSES.has(existing.status)) {
        return false;
      }
      if (
        input.expectedLeaseOwner !== undefined &&
        existing.leaseOwner !== input.expectedLeaseOwner
      ) {
        return false;
      }
      const nowMs = Date.parse(input.nowIso ?? new Date().toISOString());
      const expiresAtMs = existing.leaseExpiresAt
        ? Date.parse(existing.leaseExpiresAt)
        : Number.NaN;
      if (
        input.requireUnexpiredLease &&
        !(Number.isFinite(expiresAtMs) && expiresAtMs > nowMs)
      ) {
        return false;
      }
      if (input.requireExpiredLease) {
        const expired =
          !(existing.leaseOwner && Number.isFinite(expiresAtMs)) ||
          expiresAtMs <= nowMs;
        if (!expired) {
          return false;
        }
      }
      executionRuns.set(input.id, { ...input.next, id: existing.id });
      return true;
    },

    async compareAndSwapComposioUserConnection(record, expectedOAuthStateHash) {
      const current = composioUserConnections.get(record.id);
      if (
        !current ||
        current.orgId !== record.orgId ||
        current.userId !== record.userId ||
        current.toolkitId !== record.toolkitId ||
        current.oauthStateHash !== expectedOAuthStateHash
      ) {
        return false;
      }

      composioUserConnections.set(record.id, { ...record });
      return true;
    },

    async countHumanUsers() {
      return [...usersById.values()].filter(
        (user) => user.id !== LOCAL_CLIENT_USER_ID
      ).length;
    },

    async countOrgMemoryProposals(orgId, status) {
      let count = 0;
      for (const proposal of orgMemoryProposals.values()) {
        if (proposal.orgId === orgId && proposal.status === status) {
          count += 1;
        }
      }
      return count;
    },

    async countPendingSkillProposals(orgId, profileId) {
      let count = 0;
      for (const proposal of skillProposals.values()) {
        if (proposal.orgId !== orgId || proposal.status !== "pending") {
          continue;
        }
        if (profileId && proposal.profileId !== profileId) {
          continue;
        }
        count += 1;
      }
      return count;
    },

    async countProfileMcpAssignments() {
      let count = 0;

      for (const assigned of profileMcpServers.values()) {
        count += assigned.size;
      }

      return count;
    },

    async countUnreadAutomationRunsByOrg(userId, orgId) {
      const orgAutomations = Array.from(automations.values()).filter(
        (automation) => automation.orgId === orgId
      );
      const counts = new Map<string, number>();

      for (const automation of orgAutomations) {
        const readThroughAt =
          automationRunReadState.get(`${userId}:${orgId}:${automation.id}`)
            ?.readThroughAt ?? "1970-01-01T00:00:00.000Z";
        const runs = automationRuns.get(automation.id) ?? [];

        for (const run of runs) {
          if (run.status !== "completed" && run.status !== "failed") {
            continue;
          }

          const timestamp = run.completedAt ?? run.startedAt;
          if (timestamp > readThroughAt) {
            counts.set(automation.id, (counts.get(automation.id) ?? 0) + 1);
          }
        }
      }

      return Array.from(counts.entries()).map(
        ([automationId, unreadCount]) => ({
          automationId,
          unreadCount,
        })
      );
    },

    async countUsers() {
      return usersById.size;
    },

    async createArtifactShare(record) {
      artifactShares.set(record.id, record);
      if (!record.revokedAt) {
        artifactSharesByTokenHash.set(record.tokenHash, record);
      }
    },
    async createAuditEvent(record) {
      auditEvents.set(record.id, { ...record });
    },

    async createBrowserSession(record) {
      browserSessionsByHash.set(record.sessionTokenHash, record);
    },

    async createLearningCommit(record) {
      learningCommits.set(record.id, { ...record });
    },
    async createLearningEvidence(record) {
      learningEvidence.set(record.id, { ...record });
    },
    async createLearningOutcome(record) {
      const existing = learningOutcomes.get(record.commitId) ?? [];
      existing.push({ ...record });
      learningOutcomes.set(record.commitId, existing);
    },

    async createMemory(record) {
      memories.set(memoryKey(record.orgId, record.id), { ...record });
    },

    async createOrgInvite(record) {
      orgInvites.set(record.id, record);
      orgInvitesByTokenHash.set(record.tokenHash, record);
    },

    async createOrgMemoryProposal(record) {
      orgMemoryProposals.set(record.id, record);
    },

    async createProfileIfAbsent(record) {
      if (profiles.has(record.id)) {
        return false;
      }
      if (record.isDefault && record.orgId) {
        for (const profile of profiles.values()) {
          if (profile.orgId === record.orgId && profile.isDefault) {
            profiles.set(profile.id, { ...profile, isDefault: false });
          }
        }
      }
      profiles.set(record.id, { ...record, isImporting: false });
      return true;
    },

    async createSkillProposal(record) {
      skillProposals.set(record.id, record);
    },
    async createSkillRevision(record) {
      const existing = skillRevisions.get(record.skillId) ?? [];
      existing.push({ ...record });
      skillRevisions.set(record.skillId, existing);
    },

    async createSkillSuggestion(record) {
      skillSuggestions.set(record.id, record);
    },

    async createUser(record) {
      usersById.set(record.id, record);
      usersByEmail.set(record.email, record);
    },

    async deleteAttachment(id) {
      return attachments.delete(id);
    },

    async deleteAutomation(id) {
      automationRuns.delete(id);
      return automations.delete(id);
    },

    async deleteAutomationRun(automationId, runId) {
      const existing = automationRuns.get(automationId) ?? [];
      const filtered = existing.filter((run) => run.id !== runId);
      automationRuns.set(automationId, filtered);
      return filtered.length !== existing.length;
    },
    async deleteChannelOrgMapping(channel, channelUserId) {
      return channelOrgMappings.delete(mappingKey(channel, channelUserId));
    },

    async deleteComposioToolkit(id) {
      return composioToolkits.delete(id);
    },

    async deleteComposioUserConnection(id) {
      return composioUserConnections.delete(id);
    },
    async deleteExecutionRunIfOwner(id, leaseOwner) {
      const existing = executionRuns.get(id);
      if (!existing) {
        return false;
      }
      if (existing.leaseOwner !== leaseOwner) {
        return false;
      }
      if (!IN_MEMORY_ACTIVE_EXECUTION_STATUSES.has(existing.status)) {
        return false;
      }
      executionRuns.delete(id);
      return true;
    },

    async deleteMcpServer(id) {
      const existing = mcpServers.get(id);

      if (!existing) {
        return false;
      }

      mcpServers.delete(id);
      mcpServersByName.delete(mcpServerNameKey(existing.orgId, existing.name));

      for (const assigned of profileMcpServers.values()) {
        assigned.delete(id);
      }

      return true;
    },

    async deleteMemory(orgId, id) {
      return memories.delete(memoryKey(orgId, id));
    },

    async deleteMessagesForSession(sessionId) {
      sessionMessages.delete(sessionId);
    },

    async deleteNotificationDestination(id) {
      return notificationDestinations.delete(id);
    },

    async deleteOrgMember(orgId, userId) {
      return orgMembers.delete(`${orgId}:${userId}`);
    },

    async deleteProfile(id) {
      if (!profiles.delete(id)) {
        return false;
      }

      profileTools.delete(id);
      profileMcpServers.delete(id);
      profileSkills.delete(id);
      profileComposioToolkits.delete(id);
      return true;
    },

    async deleteProfileForOrg(id, orgId) {
      if (profiles.get(id)?.orgId !== orgId) {
        return false;
      }
      profiles.delete(id);
      profileTools.delete(id);
      profileMcpServers.delete(id);
      profileSkills.delete(id);
      profileComposioToolkits.delete(id);
      return true;
    },

    async deleteProfileImportReservation(id, orgId) {
      const profile = profiles.get(id);
      if (!(profile?.isImporting && profile.orgId === orgId)) {
        return false;
      }
      profiles.delete(id);
      profileTools.delete(id);
      profileMcpServers.delete(id);
      profileSkills.delete(id);
      profileComposioToolkits.delete(id);
      return true;
    },

    async deleteSession(id) {
      sessionMessages.delete(id);
      return sessions.delete(id);
    },

    async deleteSkill(id) {
      const existing = skills.get(id);

      if (!existing) {
        return false;
      }

      skills.delete(id);
      skillsBySourcePath.delete(existing.sourcePath);

      for (const assigned of profileSkills.values()) {
        assigned.delete(id);
      }

      return true;
    },

    async deleteTask(id) {
      taskRuns.delete(id);
      return tasks.delete(id);
    },

    async deleteTool(id) {
      const existing = tools.get(id);

      if (!existing) {
        return false;
      }

      tools.delete(id);
      toolsByName.delete(toolNameKey(existing.orgId, existing.name));

      for (const assigned of profileTools.values()) {
        assigned.delete(id);
      }

      return true;
    },
    async getActionApproval(id) {
      return actionApprovals.get(id) ?? null;
    },

    async getActiveArtifactShareByPath(orgId, profileId, sourcePath) {
      for (const share of artifactShares.values()) {
        if (
          share.orgId === orgId &&
          share.profileId === profileId &&
          share.sourcePath === sourcePath &&
          !share.revokedAt
        ) {
          return share;
        }
      }

      return null;
    },

    async getActiveAutomationRun(automationId) {
      return (
        [...(automationRuns.get(automationId) ?? [])]
          .filter((run) => run.status === "running")
          .sort((left, right) =>
            right.startedAt.localeCompare(left.startedAt)
          )[0] ?? null
      );
    },

    async getActiveTaskRun(taskId) {
      return (
        [...(taskRuns.get(taskId) ?? [])]
          .filter((run) => run.status === "running")
          .sort((left, right) =>
            right.startedAt.localeCompare(left.startedAt)
          )[0] ?? null
      );
    },

    async getArtifactShareById(orgId, profileId, shareId) {
      const share = artifactShares.get(shareId);
      if (!share || share.orgId !== orgId || share.profileId !== profileId) {
        return null;
      }

      return share;
    },

    async getArtifactShareByTokenHash(tokenHash) {
      const share = artifactSharesByTokenHash.get(tokenHash);
      return share && !share.revokedAt ? share : null;
    },

    async getAttachment(id) {
      return attachments.get(id) ?? null;
    },

    async getAutomation(id) {
      return automations.get(id) ?? null;
    },

    async getAutomationRunReadThrough(userId, orgId, automationId) {
      const key = `${userId}:${orgId}:${automationId}`;
      return automationRunReadState.get(key)?.readThroughAt ?? null;
    },

    async getBrowserSessionBySessionTokenHash(sessionTokenHash) {
      return browserSessionsByHash.get(sessionTokenHash) ?? null;
    },
    async getChannelOrgMapping(channel, channelUserId) {
      return channelOrgMappings.get(mappingKey(channel, channelUserId)) ?? null;
    },

    async getComposioToolkit(id) {
      return composioToolkits.get(id) ?? null;
    },

    async getComposioToolkitBySlug(orgId, toolkitSlug) {
      return (
        Array.from(composioToolkits.values()).find(
          (record) =>
            record.orgId === orgId && record.toolkitSlug === toolkitSlug
        ) ?? null
      );
    },

    async getComposioUserConnection(userId, toolkitId) {
      return (
        Array.from(composioUserConnections.values()).find(
          (record) => record.userId === userId && record.toolkitId === toolkitId
        ) ?? null
      );
    },

    async getComposioUserConnectionById(id) {
      return composioUserConnections.get(id) ?? null;
    },

    async getConversationHistory(orgId, sessionId, options = {}) {
      const session = sessions.get(sessionId);
      const profile = session ? profiles.get(session.profileId) : null;
      if (
        !session ||
        session.orgId !== orgId ||
        profile?.orgId !== orgId ||
        profile.isImporting ||
        (options.userId && session.userId !== options.userId) ||
        (options.excludeSuperAgent && profile.isSuper)
      ) {
        return null;
      }

      const allMessages = [...(sessionMessages.get(sessionId) ?? [])].sort(
        (left, right) => left.seq - right.seq
      );
      const limit = Math.min(100, options.limit ?? 50);
      const offset = options.offset ?? 0;
      const messages = allMessages
        .slice(offset, offset + limit)
        .map((message) => {
          const parsed = readConversationMessagePayload(message.payload);
          return {
            createdAt: message.createdAt,
            id: message.id,
            role: parsed.role,
            seq: message.seq,
            text: parsed.text.slice(0, 4000),
          };
        });

      return {
        createdAt: session.createdAt,
        messages,
        profileId: session.profileId,
        sessionId: session.id,
        title: session.title ?? null,
        totalMessages: allMessages.length,
      };
    },

    async getDefaultProfileForOrg(orgId) {
      return (
        Array.from(profiles.values()).find(
          (profile) =>
            profile.orgId === orgId && profile.isDefault && !profile.isImporting
        ) ?? null
      );
    },
    async getExecutionRun(id) {
      return executionRuns.get(id) ?? null;
    },
    async getExecutionRunByIdempotencyKey(orgId, idempotencyKey) {
      return (
        [...executionRuns.values()].find(
          (run) => run.orgId === orgId && run.idempotencyKey === idempotencyKey
        ) ?? null
      );
    },
    async getLearningCandidate(id) {
      return learningCandidates.get(id) ?? null;
    },
    async getLearningJobByIdempotencyKey(orgId, idempotencyKey) {
      return (
        [...learningJobs.values()].find(
          (job) => job.orgId === orgId && job.idempotencyKey === idempotencyKey
        ) ?? null
      );
    },

    async getLlmUsageStats() {
      return llmUsageStats;
    },

    async getMcpServer(id) {
      return mcpServers.get(id) ?? null;
    },

    async getMcpServerByName(name, orgId) {
      return mcpServersByName.get(mcpServerNameKey(orgId, name)) ?? null;
    },

    async getMemory(orgId, id) {
      return memories.get(memoryKey(orgId, id)) ?? null;
    },

    async getNotificationDestination(id) {
      return notificationDestinations.get(id) ?? null;
    },

    async getOrgAiConfig(orgId) {
      return orgAiConfigs.get(orgId) ?? null;
    },

    async getOrganizationById(id) {
      return organizations.get(id) ?? null;
    },

    async getOrganizationBySlug(slug) {
      return organizationsBySlug.get(slug) ?? null;
    },

    async getOrgInviteByTokenHash(tokenHash) {
      return orgInvitesByTokenHash.get(tokenHash) ?? null;
    },

    async getOrgMember(orgId, userId) {
      return orgMembers.get(`${orgId}:${userId}`) ?? null;
    },

    async getOrgMemoryProposal(orgId, id) {
      const proposal = orgMemoryProposals.get(id);
      if (!proposal || proposal.orgId !== orgId) {
        return null;
      }
      return proposal;
    },

    getOrgUsageBudget(orgId) {
      return Promise.resolve(orgUsageBudgets.get(orgId) ?? null);
    },

    async getPendingOrgInvite(orgId, email) {
      const normalizedEmail = email.trim().toLowerCase();
      for (const invite of orgInvites.values()) {
        if (
          invite.orgId === orgId &&
          invite.email === normalizedEmail &&
          !invite.acceptedAt &&
          !invite.revokedAt
        ) {
          return invite;
        }
      }

      return null;
    },

    async getPendingOrgMemoryProposalByBullet(orgId, bullet) {
      for (const proposal of orgMemoryProposals.values()) {
        if (
          proposal.orgId === orgId &&
          proposal.bullet === bullet &&
          proposal.status === "pending"
        ) {
          return proposal;
        }
      }
      return null;
    },

    async getPendingSkillProposalForCreate(orgId, profileId, skillName) {
      for (const proposal of skillProposals.values()) {
        if (
          proposal.orgId === orgId &&
          proposal.profileId === profileId &&
          proposal.skillName === skillName &&
          proposal.action === "create" &&
          proposal.status === "pending"
        ) {
          return proposal;
        }
      }
      return null;
    },

    async getPendingSkillProposalForPatch(
      orgId,
      profileId,
      skillName,
      patchOldString,
      patchNewString
    ) {
      for (const proposal of skillProposals.values()) {
        if (
          proposal.orgId === orgId &&
          proposal.profileId === profileId &&
          proposal.skillName === skillName &&
          proposal.action === "patch" &&
          proposal.patchOldString === patchOldString &&
          proposal.patchNewString === patchNewString &&
          proposal.status === "pending"
        ) {
          return proposal;
        }
      }
      return null;
    },

    async getPendingSkillProposalForSkill(orgId, profileId, skillName) {
      for (const proposal of skillProposals.values()) {
        if (
          proposal.orgId === orgId &&
          proposal.profileId === profileId &&
          proposal.skillName === skillName &&
          proposal.status === "pending"
        ) {
          return proposal;
        }
      }
      return null;
    },

    async getProfile(id) {
      const profile = profiles.get(id);
      return profile && !profile.isImporting ? profile : null;
    },

    async getProfileForOrg(id, orgId) {
      const profile = profiles.get(id);
      return profile?.orgId === orgId && !profile.isImporting ? profile : null;
    },

    async getSession(id) {
      const session = sessions.get(id);
      return session && !profiles.get(session.profileId)?.isImporting
        ? session
        : null;
    },

    async getSessionQuestionnaire(sessionId) {
      return sessions.get(sessionId)?.agentQuestionnaire ?? null;
    },

    async getSessionTodos(sessionId) {
      return sessions.get(sessionId)?.agentTodos ?? [];
    },

    async getSkill(id) {
      return skills.get(id) ?? null;
    },

    async getSkillByName(name, orgId) {
      const matches = Array.from(skills.values()).filter(
        (skill) => skill.name === name
      );

      return (
        matches.find((skill) => Boolean(orgId) && skill.orgId === orgId) ??
        matches.find((skill) => !skill.orgId) ??
        null
      );
    },

    async getSkillBySourcePath(sourcePath) {
      return skillsBySourcePath.get(sourcePath) ?? null;
    },

    async getSkillProposal(orgId, id) {
      const proposal = skillProposals.get(id);
      if (!proposal || proposal.orgId !== orgId) {
        return null;
      }
      return proposal;
    },

    async getSkillSuggestion(orgId, id) {
      const suggestion = skillSuggestions.get(id);
      if (!suggestion || suggestion.orgId !== orgId) {
        return null;
      }
      return suggestion;
    },

    async getSkillUsage(profileId, skillId) {
      return skillUsage.get(`${profileId}:${skillId}`) ?? null;
    },

    async getTask(id) {
      return tasks.get(id) ?? null;
    },

    async getTool(id) {
      return tools.get(id) ?? null;
    },

    async getToolByName(name, orgId) {
      if (orgId) {
        return (
          toolsByName.get(toolNameKey(orgId, name)) ??
          toolsByName.get(toolNameKey(null, name)) ??
          null
        );
      }

      return toolsByName.get(toolNameKey(null, name)) ?? null;
    },
    async getUserByEmail(email) {
      return usersByEmail.get(email) ?? null;
    },

    async getUserById(id) {
      return usersById.get(id) ?? null;
    },

    async getUserContext(orgId, userId) {
      return orgMembers.get(`${orgId}:${userId}`)?.userContext ?? null;
    },

    async getWorkspaceSettings(orgId) {
      const selected = orgId
        ? (orgWorkspaceSettings.get(orgId) ?? null)
        : workspaceSettings;
      return selected
        ? {
            ...selected,
            codingAgentHarnesses: selected.codingAgentHarnesses.map(
              (harness) => ({
                ...harness,
                args: [...harness.args],
              })
            ),
            codingAgentProviderPassthrough:
              selected.codingAgentProviderPassthrough !== false,
          }
        : null;
    },

    async incrementLlmTurnUsage(orgId, delta) {
      const updatedAt = new Date().toISOString();
      const bucket = updatedAt.slice(0, 10);
      const arm = delta.optimized ? "omni" : "none";
      const key = `${orgId}\u0000${bucket}\u0000${arm}`;
      const existing = llmTurnUsage.get(key);

      llmTurnUsage.set(key, {
        arm,
        bucket,
        estimatedTurns:
          (existing?.estimatedTurns ?? 0) + (delta.estimated ? 1 : 0),
        inputTokens: (existing?.inputTokens ?? 0) + delta.inputTokens,
        orgId,
        outputTokens: (existing?.outputTokens ?? 0) + delta.outputTokens,
        turns: (existing?.turns ?? 0) + 1,
      });
    },

    incrementLlmUsageDaily(dimensions, delta) {
      const day = new Date().toISOString().slice(0, 10);
      const key = [
        day,
        dimensions.orgId,
        dimensions.userId,
        dimensions.profileId,
        dimensions.providerType,
        dimensions.providerCredentialId,
        dimensions.modelId,
      ].join("\u0000");
      const existing = llmUsageDaily.get(key);
      llmUsageDaily.set(key, {
        ...dimensions,
        day,
        estimatedCostUsd:
          (existing?.estimatedCostUsd ?? 0) + delta.estimatedCostUsd,
        inputTokens: (existing?.inputTokens ?? 0) + delta.inputTokens,
        outputTokens: (existing?.outputTokens ?? 0) + delta.outputTokens,
        requestCount: (existing?.requestCount ?? 0) + delta.requestCount,
        updatedAt: new Date().toISOString(),
      });
      return Promise.resolve();
    },

    async incrementLlmUsageStats(
      delta: LlmUsageStatsDelta,
      trackedSince: string
    ) {
      const updatedAt = new Date().toISOString();

      if (!llmUsageStats) {
        llmUsageStats = {
          estimatedCostUsd: delta.estimatedCostUsd,
          id: LLM_USAGE_STATS_ID,
          inputTokens: delta.inputTokens,
          outputTokens: delta.outputTokens,
          requestCount: delta.requestCount,
          trackedSince,
          updatedAt,
        };
        return;
      }

      llmUsageStats = {
        ...llmUsageStats,
        estimatedCostUsd:
          llmUsageStats.estimatedCostUsd + delta.estimatedCostUsd,
        inputTokens: llmUsageStats.inputTokens + delta.inputTokens,
        outputTokens: llmUsageStats.outputTokens + delta.outputTokens,
        requestCount: llmUsageStats.requestCount + delta.requestCount,
        updatedAt,
      };
    },

    async incrementLlmUsageStatsByModel(
      modelId: string,
      delta: LlmUsageStatsDelta,
      trackedSince: string
    ) {
      const updatedAt = new Date().toISOString();
      const existing = llmUsageByModel.get(modelId);

      if (!existing) {
        llmUsageByModel.set(modelId, {
          estimatedCostUsd: delta.estimatedCostUsd,
          inputTokens: delta.inputTokens,
          modelId,
          outputTokens: delta.outputTokens,
          requestCount: delta.requestCount,
          trackedSince,
          updatedAt,
        });
        return;
      }

      llmUsageByModel.set(modelId, {
        ...existing,
        estimatedCostUsd: existing.estimatedCostUsd + delta.estimatedCostUsd,
        inputTokens: existing.inputTokens + delta.inputTokens,
        outputTokens: existing.outputTokens + delta.outputTokens,
        requestCount: existing.requestCount + delta.requestCount,
        updatedAt,
      });
    },

    async incrementSkillUsage(input) {
      const key = `${input.profileId}:${input.skillId}`;
      const now = new Date().toISOString();
      const existing = skillUsage.get(key);

      if (!existing) {
        skillUsage.set(key, {
          createdAt: now,
          lastPatchedAt: input.patchedAt ?? null,
          lastUsedAt: input.usedAt ?? null,
          lastViewedAt: input.viewedAt ?? null,
          orgId: input.orgId,
          patchCount: input.patchDelta ?? 0,
          profileId: input.profileId,
          skillId: input.skillId,
          updatedAt: now,
          useCount: input.useDelta ?? 0,
          viewCount: input.viewDelta ?? 0,
        });
        return;
      }

      skillUsage.set(key, {
        ...existing,
        lastPatchedAt: input.patchedAt ?? existing.lastPatchedAt,
        lastUsedAt: input.usedAt ?? existing.lastUsedAt,
        lastViewedAt: input.viewedAt ?? existing.lastViewedAt,
        patchCount: existing.patchCount + (input.patchDelta ?? 0),
        updatedAt: now,
        useCount: existing.useCount + (input.useDelta ?? 0),
        viewCount: existing.viewCount + (input.viewDelta ?? 0),
      });
    },

    async incrementToolOutputSavings(orgId, delta, trackedSince) {
      const updatedAt = new Date().toISOString();
      const bucket = updatedAt.slice(0, 10);
      const key = `${orgId}\u0000${bucket}\u0000${delta.optimizer}\u0000${delta.tool}`;
      const existing = toolOutputSavings.get(key);

      toolOutputSavings.set(key, {
        bucket,
        bytesIn: (existing?.bytesIn ?? 0) + delta.bytesIn,
        bytesOut: (existing?.bytesOut ?? 0) + delta.bytesOut,
        calls: (existing?.calls ?? 0) + 1,
        optimizer: delta.optimizer,
        orgId,
        tool: delta.tool,
        trackedSince: existing?.trackedSince ?? trackedSince,
        updatedAt,
      });
    },

    async insertAttachment(record) {
      attachments.set(record.id, { ...record });
    },

    async insertAutomationRun(record) {
      const existing = automationRuns.get(record.automationId) ?? [];
      automationRuns.set(record.automationId, [...existing, record]);
    },
    async insertExecutionRunIfAbsent(record) {
      if (executionRuns.has(record.id)) {
        return false;
      }
      if (executionRunInsertConflict(executionRuns, record)) {
        return false;
      }
      executionRuns.set(record.id, { ...record });
      return true;
    },

    async insertTaskRun(record) {
      const existing = taskRuns.get(record.taskId) ?? [];
      taskRuns.set(record.taskId, [...existing, record]);
    },
    async listActionApprovalsForSession(sessionId) {
      return [...actionApprovals.values()].filter(
        (item) => item.sessionId === sessionId
      );
    },

    async listAutomationRuns(automationId, limit = 20) {
      return [...(automationRuns.get(automationId) ?? [])]
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
        .slice(0, limit);
    },

    async listAutomations() {
      return Array.from(automations.values());
    },

    async listAutomationsForOrg(orgId) {
      return Array.from(automations.values()).filter(
        (automation) => automation.orgId === orgId
      );
    },
    async listChannelOrgMappingsForOrg(orgId) {
      return [...channelOrgMappings.values()].filter(
        (item) => item.orgId === orgId
      );
    },

    async listComposioToolkitsForOrg(orgId) {
      return Array.from(composioToolkits.values()).filter(
        (record) => record.orgId === orgId
      );
    },

    async listComposioUserConnectionsForOrg(orgId) {
      return Array.from(composioUserConnections.values()).filter(
        (record) => record.orgId === orgId
      );
    },

    async listComposioUserConnectionsForUser(orgId, userId) {
      return Array.from(composioUserConnections.values()).filter(
        (record) => record.orgId === orgId && record.userId === userId
      );
    },
    async listExecutionRuns(filter) {
      return [...executionRuns.values()].filter((run) => {
        if (filter?.kind && run.kind !== filter.kind) {
          return false;
        }
        if (filter?.orgId && run.orgId !== filter.orgId) {
          return false;
        }
        if (filter?.sessionId && run.sessionId !== filter.sessionId) {
          return false;
        }
        return true;
      });
    },
    async listExecutionSteps(runId) {
      return [...(executionSteps.get(runId) ?? [])].sort(
        (left, right) => left.stepIndex - right.stepIndex
      );
    },
    async listLearningCandidates(orgId, status) {
      return [...learningCandidates.values()].filter(
        (item) => item.orgId === orgId && (!status || item.status === status)
      );
    },
    async listLearningCommits(orgId) {
      return [...learningCommits.values()].filter(
        (item) => item.orgId === orgId
      );
    },
    async listLearningEvidenceForSession(orgId, sessionId) {
      return [...learningEvidence.values()].filter(
        (item) => item.orgId === orgId && item.sessionId === sessionId
      );
    },
    async listLearningOutcomesForCommit(commitId) {
      return [...(learningOutcomes.get(commitId) ?? [])];
    },

    async listLlmTurnUsage(orgId) {
      return [...llmTurnUsage.values()]
        .filter((row) => row.orgId === orgId)
        .sort((left, right) => left.bucket.localeCompare(right.bucket));
    },

    async listLlmUsageStatsByModel() {
      return [...llmUsageByModel.values()].sort((left, right) => {
        if (right.requestCount !== left.requestCount) {
          return right.requestCount - left.requestCount;
        }

        const rightTotal = right.inputTokens + right.outputTokens;
        const leftTotal = left.inputTokens + left.outputTokens;
        if (rightTotal !== leftTotal) {
          return rightTotal - leftTotal;
        }

        return left.modelId.localeCompare(right.modelId);
      });
    },

    async listMcpServerProfileCounts() {
      const counts: Record<string, number> = {};

      for (const assigned of profileMcpServers.values()) {
        for (const serverId of assigned) {
          counts[serverId] = (counts[serverId] ?? 0) + 1;
        }
      }

      return counts;
    },

    async listMcpServers() {
      return Array.from(mcpServers.values());
    },

    async listMcpServersForOrg(orgId) {
      return Array.from(mcpServers.values())
        .filter((server) => server.orgId === orgId)
        .sort((left, right) => left.name.localeCompare(right.name));
    },

    async listMcpServersForProfile(profileId) {
      if (profiles.get(profileId)?.isImporting) {
        return [];
      }
      const assigned = profileMcpServers.get(profileId);

      if (!assigned) {
        return [];
      }

      return Array.from(assigned)
        .map((serverId) => mcpServers.get(serverId))
        .filter(
          (server): server is StoredMcpServerRecord => server !== undefined
        );
    },

    async listMemories(orgId, scope, ownerId, limit) {
      let results = [...memories.values()].filter(
        (memory) => memory.orgId === orgId
      );
      if (scope) {
        results = results.filter((memory) => memory.scope === scope);
      }
      if (ownerId) {
        results = results.filter((memory) => memory.ownerId === ownerId);
      }
      return typeof limit === "number" ? results.slice(0, limit) : results;
    },

    async listMessagesForSession(sessionId) {
      return [...(sessionMessages.get(sessionId) ?? [])].sort(
        (left, right) => left.seq - right.seq
      );
    },

    async listNotificationDestinationsForOrg(orgId) {
      return Array.from(notificationDestinations.values()).filter(
        (record) => record.orgId === orgId
      );
    },

    async listOrganizations() {
      return Array.from(organizations.values()).sort((left, right) =>
        left.name.localeCompare(right.name)
      );
    },

    async listOrgMembers(orgId) {
      return Array.from(orgMembers.values())
        .filter((member) => member.orgId === orgId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    },

    async listOrgMemoryProposals(orgId, status) {
      const proposals = [...orgMemoryProposals.values()].filter(
        (proposal) => proposal.orgId === orgId
      );
      const filtered = status
        ? proposals.filter((proposal) => proposal.status === status)
        : proposals;
      return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    listOrgUsageBudgets() {
      return Promise.resolve(
        [...orgUsageBudgets.values()].sort(
          (left, right) => right.monthlyLimitUsd - left.monthlyLimitUsd
        )
      );
    },

    async listProfileComposioToolkits(profileId) {
      if (profiles.get(profileId)?.isImporting) {
        return [];
      }
      return profileComposioToolkits.get(profileId) ?? [];
    },

    async listProfiles() {
      return Array.from(profiles.values()).filter(
        (profile) => !profile.isImporting
      );
    },

    async listProfilesForMcpServer(serverId) {
      const matches: StoredProfileRecord[] = [];

      for (const [profileId, assigned] of profileMcpServers) {
        if (!assigned.has(serverId)) {
          continue;
        }

        const profile = profiles.get(profileId);

        if (profile && !profile.isImporting) {
          matches.push(profile);
        }
      }

      return matches.sort((left, right) => left.name.localeCompare(right.name));
    },

    async listProfilesForOrg(orgId) {
      return Array.from(profiles.values())
        .filter((profile) => profile.orgId === orgId && !profile.isImporting)
        .sort((left, right) => {
          if (left.isDefault !== right.isDefault) {
            return left.isDefault ? -1 : 1;
          }

          return left.name.localeCompare(right.name);
        });
    },
    async listQueuedOutbox(orgId) {
      return [...outboundOutbox.values()].filter(
        (item) => item.orgId === orgId && item.status === "queued"
      );
    },

    async listSessionSummaries(profileId, channel) {
      if (profiles.get(profileId)?.isImporting) {
        return [];
      }
      return Array.from(sessions.values())
        .filter(
          (session) =>
            session.profileId === profileId && session.channel === channel
        )
        .map((session) =>
          summarizeSession(session, sessionMessages.get(session.id) ?? [])
        )
        .filter((summary) => summary.messageCount > 0)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },

    async listSessions() {
      return Array.from(sessions.values()).filter(
        (session) => !profiles.get(session.profileId)?.isImporting
      );
    },

    async listSkillProposals(orgId, options = {}) {
      const { status, profileId, sessionId } = options;
      const proposals = [...skillProposals.values()].filter((proposal) => {
        if (proposal.orgId !== orgId) {
          return false;
        }
        if (status && proposal.status !== status) {
          return false;
        }
        if (profileId && proposal.profileId !== profileId) {
          return false;
        }
        if (sessionId && proposal.sessionId !== sessionId) {
          return false;
        }
        return true;
      });
      return proposals.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async listSkillRevisions(skillId) {
      return [...(skillRevisions.get(skillId) ?? [])].sort(
        (left, right) => left.version - right.version
      );
    },

    async listSkillSuggestions(orgId, options = {}) {
      const { sessionId, status, profileId } = options;
      const suggestions = [...skillSuggestions.values()].filter(
        (suggestion) => {
          if (suggestion.orgId !== orgId) {
            return false;
          }
          if (sessionId && suggestion.sessionId !== sessionId) {
            return false;
          }
          if (status && suggestion.status !== status) {
            return false;
          }
          if (profileId && suggestion.profileId !== profileId) {
            return false;
          }
          return true;
        }
      );
      return suggestions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    async listSkills() {
      return Array.from(skills.values()).sort((left, right) =>
        left.name.localeCompare(right.name)
      );
    },

    async listSkillsForProfile(profileId) {
      if (profiles.get(profileId)?.isImporting) {
        return [];
      }
      const assigned = profileSkills.get(profileId);

      if (!assigned) {
        return [];
      }

      return Array.from(assigned)
        .map((skillId) => skills.get(skillId))
        .filter((skill): skill is StoredSkillRecord => skill !== undefined)
        .sort((left, right) => left.name.localeCompare(right.name));
    },

    async listSkillUsageForProfile(profileId) {
      return Array.from(skillUsage.values())
        .filter((usage) => usage.profileId === profileId)
        .sort((left, right) => left.skillId.localeCompare(right.skillId));
    },

    async listTaskRuns(taskId, limit = 20) {
      return [...(taskRuns.get(taskId) ?? [])]
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
        .slice(0, limit);
    },

    async listTasks() {
      return Array.from(tasks.values()).sort((left, right) => {
        const statusCompare = left.status.localeCompare(right.status);
        return statusCompare === 0
          ? left.position - right.position
          : statusCompare;
      });
    },

    async listTasksForOrg(orgId) {
      return Array.from(tasks.values())
        .filter((task) => task.orgId === orgId)
        .sort((left, right) => {
          const statusCompare = left.status.localeCompare(right.status);
          return statusCompare === 0
            ? left.position - right.position
            : statusCompare;
        });
    },

    async listToolOutputSavings(orgId) {
      return [...toolOutputSavings.values()]
        .filter((row) => row.orgId === orgId)
        .sort((left, right) =>
          left.bucket === right.bucket
            ? right.bytesIn - right.bytesOut - (left.bytesIn - left.bytesOut)
            : left.bucket.localeCompare(right.bucket)
        );
    },

    async listTools() {
      return Array.from(tools.values());
    },

    async listToolsForOrg(orgId) {
      return Array.from(tools.values()).filter(
        (tool) => tool.orgId == null || tool.orgId === orgId
      );
    },

    async listToolsForProfile(profileId) {
      if (profiles.get(profileId)?.isImporting) {
        return [];
      }
      const assigned = profileTools.get(profileId);

      if (!assigned) {
        return [];
      }

      return Array.from(assigned)
        .map((toolId) => tools.get(toolId))
        .filter((tool): tool is StoredToolRecord => tool !== undefined);
    },

    async listUserOrganizations(userId) {
      return Array.from(orgMembers.values())
        .filter((member) => member.userId === userId)
        .map((member) => {
          const organization = organizations.get(member.orgId);
          if (!organization || organization.archivedAt) {
            return null;
          }

          return {
            joinedAt: member.createdAt,
            organization,
            role: member.role,
          } satisfies StoredUserOrganizationRecord;
        })
        .filter(
          (record): record is StoredUserOrganizationRecord => record !== null
        )
        .sort((left, right) =>
          left.organization.name.localeCompare(right.organization.name)
        );
    },

    async markOrgInviteAccepted(id, acceptedAt) {
      const invite = orgInvites.get(id);
      if (!invite) {
        return;
      }

      const updated = { ...invite, acceptedAt };
      orgInvites.set(id, updated);
      orgInvitesByTokenHash.set(updated.tokenHash, updated);
    },

    async markSkillCuratorRunCompleted(orgId, completedAt) {
      const organization = organizations.get(orgId);
      if (
        !organization ||
        organization.archivedAt ||
        !organization.skillsCuratorConsolidation
      ) {
        return false;
      }
      const updated = {
        ...organization,
        skillsCuratorLastRunAt: completedAt,
        updatedAt: completedAt,
      };
      organizations.set(orgId, updated);
      organizationsBySlug.set(updated.slug, updated);
      return true;
    },

    async markSkillSuggestionApplied(orgId, id, appliedAt) {
      const suggestion = skillSuggestions.get(id);
      if (!suggestion || suggestion.orgId !== orgId) {
        return false;
      }
      skillSuggestions.set(id, {
        ...suggestion,
        appliedAt,
        status: "applied",
      });
      return true;
    },
    pruneLlmUsageDaily(beforeDay) {
      let removed = 0;
      for (const [key, record] of llmUsageDaily.entries()) {
        if (record.day <= beforeDay) {
          llmUsageDaily.delete(key);
          removed += 1;
        }
      }
      return Promise.resolve(removed);
    },

    async publishProfileImport(publication) {
      const organization = organizations.get(publication.orgId);
      const reservation = profiles.get(publication.profileId);
      if (!organization || organization.archivedAt) {
        return "inactive";
      }
      if (
        !reservation?.isImporting ||
        reservation.orgId !== publication.orgId ||
        reservation.isDefault ||
        reservation.isSuper
      ) {
        return "conflict";
      }

      const toolIds = new Set(publication.toolIds);
      const skillIds = new Set(publication.skillIds);
      const mcpServerIds = new Set(publication.mcpServerIds);
      const composioToolkitIds = new Set(
        publication.composioAssignments.map(
          (assignment) => assignment.toolkitId
        )
      );
      const newToolsById = new Map(
        publication.newTools.map((tool) => [tool.id, tool])
      );
      const newSkillsById = new Map(
        publication.newSkills.map((skill) => [skill.id, skill])
      );
      const expectedToolIds = new Set(
        publication.expectedTools.map((tool) => tool.id)
      );
      if (
        toolIds.size !== publication.toolIds.length ||
        skillIds.size !== publication.skillIds.length ||
        mcpServerIds.size !== publication.mcpServerIds.length ||
        composioToolkitIds.size !== publication.composioAssignments.length ||
        newToolsById.size !== publication.newTools.length ||
        newSkillsById.size !== publication.newSkills.length ||
        expectedToolIds.size !== publication.expectedTools.length ||
        publication.newTools.some((tool) => !toolIds.has(tool.id)) ||
        publication.newSkills.some((skill) => !skillIds.has(skill.id)) ||
        publication.toolIds.some((id) =>
          newToolsById.has(id)
            ? expectedToolIds.has(id)
            : !expectedToolIds.has(id)
        )
      ) {
        return "conflict";
      }
      const newToolNames = new Set<string>();
      for (const tool of publication.newTools) {
        const nameKey = toolNameKey(tool.orgId, tool.name);
        if (
          tool.orgId !== publication.orgId ||
          tools.has(tool.id) ||
          toolsByName.has(nameKey) ||
          toolsByName.has(toolNameKey(null, tool.name)) ||
          newToolNames.has(nameKey)
        ) {
          return "conflict";
        }
        newToolNames.add(nameKey);
      }
      const newSkillNames = new Set<string>();
      const newSkillPaths = new Set<string>();
      for (const skill of publication.newSkills) {
        const hasVisibleNameCollision = Array.from(skills.values()).some(
          (existing) =>
            existing.name === skill.name &&
            (existing.orgId == null || existing.orgId === publication.orgId)
        );
        if (
          skill.orgId !== publication.orgId ||
          skills.has(skill.id) ||
          skillsBySourcePath.has(skill.sourcePath) ||
          hasVisibleNameCollision ||
          newSkillNames.has(skill.name) ||
          newSkillPaths.has(skill.sourcePath)
        ) {
          return "conflict";
        }
        newSkillNames.add(skill.name);
        newSkillPaths.add(skill.sourcePath);
      }
      for (const toolId of publication.toolIds) {
        const tool = newToolsById.get(toolId) ?? tools.get(toolId);
        if (
          !(tool && (tool.orgId == null || tool.orgId === publication.orgId))
        ) {
          return "conflict";
        }
      }
      for (const expectation of publication.expectedTools) {
        const current = tools.get(expectation.id);
        if (
          newToolsById.has(expectation.id) ||
          !toolIds.has(expectation.id) ||
          !current ||
          !importToolExpectationMatches(current, expectation)
        ) {
          return "conflict";
        }
      }
      for (const skillId of publication.skillIds) {
        const skill = newSkillsById.get(skillId) ?? skills.get(skillId);
        if (
          !(skill && (skill.orgId == null || skill.orgId === publication.orgId))
        ) {
          return "conflict";
        }
      }
      for (const serverId of publication.mcpServerIds) {
        if (mcpServers.get(serverId)?.orgId !== publication.orgId) {
          return "conflict";
        }
      }
      for (const assignment of publication.composioAssignments) {
        if (
          assignment.profileId !== publication.profileId ||
          composioToolkits.get(assignment.toolkitId)?.orgId !==
            publication.orgId
        ) {
          return "conflict";
        }
      }

      for (const tool of publication.newTools) {
        tools.set(tool.id, tool);
        toolsByName.set(toolNameKey(tool.orgId, tool.name), tool);
      }
      for (const skill of publication.newSkills) {
        skills.set(skill.id, skill);
        skillsBySourcePath.set(skill.sourcePath, skill);
      }
      profileTools.set(publication.profileId, new Set(publication.toolIds));
      profileSkills.set(publication.profileId, new Set(publication.skillIds));
      profileMcpServers.set(
        publication.profileId,
        new Set(publication.mcpServerIds)
      );
      profileComposioToolkits.set(
        publication.profileId,
        publication.composioAssignments.map((assignment) => ({
          ...assignment,
          profileId: publication.profileId,
        }))
      );
      profiles.set(publication.profileId, {
        ...reservation,
        isImporting: false,
      });
      return "published";
    },

    async replaceMessagesForSession(sessionId, messages) {
      sessionMessages.set(sessionId, [...messages]);
    },

    async replaceProfileComposioToolkits(profileId, assignments) {
      if (profiles.get(profileId)?.isImporting) {
        return;
      }
      profileComposioToolkits.set(
        profileId,
        assignments.map((assignment) => ({ ...assignment, profileId }))
      );
    },

    async reserveProfileImport(record) {
      const organization = record.orgId
        ? organizations.get(record.orgId)
        : null;
      if (!organization || organization.archivedAt) {
        return "inactive";
      }
      if (profiles.has(record.id)) {
        return "exists";
      }
      profiles.set(record.id, { ...record, isImporting: true });
      return "reserved";
    },

    async revokeArtifactShare(id, revokedAt) {
      const share = artifactShares.get(id);
      if (!share || share.revokedAt) {
        return false;
      }

      const updated = { ...share, revokedAt };
      artifactShares.set(id, updated);
      artifactSharesByTokenHash.delete(updated.tokenHash);
      return true;
    },

    async revokeBrowserSessionBySessionTokenHash(sessionTokenHash, revokedAt) {
      const session = browserSessionsByHash.get(sessionTokenHash);

      if (!session || session.revokedAt) {
        return false;
      }

      browserSessionsByHash.set(sessionTokenHash, { ...session, revokedAt });
      return true;
    },

    async revokeOtherBrowserSessionsForUser(
      userId,
      keepSessionTokenHash,
      revokedAt
    ) {
      let revoked = 0;
      for (const [hash, session] of browserSessionsByHash.entries()) {
        if (
          session.userId === userId &&
          hash !== keepSessionTokenHash &&
          !session.revokedAt
        ) {
          browserSessionsByHash.set(hash, { ...session, revokedAt });
          revoked += 1;
        }
      }
      return revoked;
    },

    async searchConversationMessages(orgId, queryText, options = {}) {
      const clean = queryText.trim();
      if (!clean) {
        return [];
      }

      const needle = clean.toLowerCase();
      const results = [];
      for (const session of sessions.values()) {
        const profile = profiles.get(session.profileId);
        if (
          session.orgId !== orgId ||
          profile?.orgId !== orgId ||
          profile.isImporting ||
          (options.profileId && session.profileId !== options.profileId) ||
          (options.userId && session.userId !== options.userId) ||
          (options.excludeSuperAgent && profile.isSuper)
        ) {
          continue;
        }

        for (const message of sessionMessages.get(session.id) ?? []) {
          if (
            (options.after && message.createdAt < options.after) ||
            (options.before && message.createdAt > options.before)
          ) {
            continue;
          }
          const parsed = readConversationMessagePayload(message.payload);
          const matchIndex = parsed.text.toLowerCase().indexOf(needle);
          if (matchIndex < 0) {
            continue;
          }
          const start = Math.max(0, matchIndex - 80);
          const end = Math.min(
            parsed.text.length,
            matchIndex + clean.length + 80
          );
          results.push({
            createdAt: message.createdAt,
            matchedSnippet: `...${parsed.text.slice(start, end).trim()}...`,
            messageId: message.id,
            profileId: session.profileId,
            role: parsed.role,
            sessionId: session.id,
            sessionTitle: session.title ?? null,
          });
        }
      }

      results.sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt)
      );
      return results.slice(0, options.limit ?? 20);
    },

    async searchMemories(orgId, query, scope, ownerId, limit) {
      const needle = query.trim().toLowerCase();
      let results = [...memories.values()].filter(
        (memory) =>
          memory.orgId === orgId &&
          memory.content.toLowerCase().includes(needle)
      );
      if (scope) {
        results = results.filter((memory) => memory.scope === scope);
      }
      if (ownerId) {
        results = results.filter((memory) => memory.ownerId === ownerId);
      }
      return typeof limit === "number" ? results.slice(0, limit) : results;
    },

    async setUserContext(orgId, userId, content, updatedAt) {
      const memberKey = `${orgId}:${userId}`;
      const member = orgMembers.get(memberKey);
      if (member) {
        orgMembers.set(memberKey, { ...member, userContext: content });
      }

      const user = usersById.get(userId);
      if (!user) {
        return;
      }

      const updated = { ...user, updatedAt };
      usersById.set(userId, updated);
      usersByEmail.set(updated.email, updated);
    },

    async tryMarkOrganizationArchived(orgId, archivedAt) {
      const activeCount = Array.from(organizations.values()).filter(
        (organization) => !organization.archivedAt
      ).length;
      const organization = organizations.get(orgId);

      if (activeCount <= 1 || !organization || organization.archivedAt) {
        return false;
      }

      const updated = {
        ...organization,
        archivedAt,
        updatedAt: archivedAt,
      };
      organizations.set(orgId, updated);
      organizationsBySlug.set(updated.slug, updated);
      return true;
    },

    async unassignMcpServerFromProfile(profileId, serverId) {
      const assigned = profileMcpServers.get(profileId);

      if (!assigned?.delete(serverId)) {
        return false;
      }

      return true;
    },

    async unassignSkillFromProfile(profileId, skillId) {
      const assigned = profileSkills.get(profileId);

      if (!assigned?.delete(skillId)) {
        return false;
      }

      return true;
    },

    async unassignToolFromProfile(profileId, toolId) {
      const assigned = profileTools.get(profileId);

      if (!assigned?.delete(toolId)) {
        return false;
      }

      return true;
    },

    async updateArtifactShareSnapshot(id, snapshot) {
      const existing = artifactShares.get(id);
      if (!existing) {
        return;
      }

      const updated = { ...existing, ...snapshot };
      artifactShares.set(id, updated);
      if (!updated.revokedAt) {
        artifactSharesByTokenHash.set(updated.tokenHash, updated);
      }
    },

    async updateAutomationRun(record) {
      const existing = automationRuns.get(record.automationId) ?? [];
      automationRuns.set(
        record.automationId,
        existing.map((run) => (run.id === record.id ? record : run))
      );
    },

    async updateBrowserSessionActiveOrgId(id, activeOrgId) {
      for (const [hash, session] of browserSessionsByHash.entries()) {
        if (session.id === id) {
          browserSessionsByHash.set(hash, { ...session, activeOrgId });
          return;
        }
      }
    },

    async updateBrowserSessionLastUsedAt(id, lastUsedAt) {
      for (const [hash, session] of browserSessionsByHash.entries()) {
        if (session.id === id) {
          browserSessionsByHash.set(hash, { ...session, lastUsedAt });
          return;
        }
      }
    },

    async updateMemory(orgId, id, patch) {
      const key = memoryKey(orgId, id);
      const existing = memories.get(key);
      if (existing) {
        memories.set(key, { ...existing, ...patch, id, orgId });
      }
    },

    async updateOrgMemoryProposalStatus(orgId, id, update) {
      const proposal = orgMemoryProposals.get(id);
      if (!proposal || proposal.orgId !== orgId) {
        return false;
      }
      orgMemoryProposals.set(id, {
        ...proposal,
        pinned: update.pinned ?? proposal.pinned,
        reviewedAt: update.reviewedAt,
        reviewerUserId: update.reviewerUserId,
        status: update.status,
      });
      return true;
    },

    async updateSessionModelOverride(sessionId, modelOverride) {
      const session = sessions.get(sessionId);

      if (!session) {
        return false;
      }

      sessions.set(sessionId, { ...session, modelOverride });
      return true;
    },

    async updateSessionQuestionnaire(sessionId, questionnaire) {
      const session = sessions.get(sessionId);

      if (!session) {
        return;
      }

      sessions.set(sessionId, {
        ...session,
        agentQuestionnaire: questionnaire,
      });
    },

    async updateSessionTitle(sessionId, title) {
      const session = sessions.get(sessionId);

      if (!session || session.title !== null) {
        return false;
      }

      sessions.set(sessionId, { ...session, title });
      return true;
    },

    async updateSessionTodos(sessionId, todos) {
      const session = sessions.get(sessionId);

      if (!session) {
        return;
      }

      sessions.set(sessionId, { ...session, agentTodos: todos });
    },

    async updateSkillProposalStatus(orgId, id, update) {
      const proposal = skillProposals.get(id);
      if (!proposal || proposal.orgId !== orgId) {
        return false;
      }
      skillProposals.set(id, {
        ...proposal,
        reviewedAt: update.reviewedAt,
        reviewerUserId: update.reviewerUserId,
        status: update.status,
      });
      return true;
    },

    async updateTaskRun(record) {
      const existing = taskRuns.get(record.taskId) ?? [];
      taskRuns.set(
        record.taskId,
        existing.map((run) => (run.id === record.id ? record : run))
      );
    },

    async updateUserPassword(id, passwordHash, updatedAt) {
      const user = usersById.get(id);
      if (!user) {
        return;
      }

      const updated = { ...user, passwordHash, updatedAt };
      usersById.set(id, updated);
      usersByEmail.set(updated.email, updated);
    },

    async updateUserProfile(id, profile, updatedAt) {
      const user = usersById.get(id);
      if (!user) {
        return;
      }

      const nextEmail = profile.email ?? user.email;
      if (nextEmail !== user.email) {
        usersByEmail.delete(user.email);
      }

      const updated = {
        ...user,
        email: nextEmail,
        name: profile.name,
        phone: profile.phone,
        updatedAt,
      };
      usersById.set(id, updated);
      usersByEmail.set(updated.email, updated);
    },
    async upsertActionApproval(record) {
      actionApprovals.set(record.id, { ...record });
    },

    async upsertAutomation(record) {
      automations.set(record.id, record);
    },

    async upsertAutomationRunReadThrough(
      userId,
      orgId,
      automationId,
      readThroughAt
    ) {
      const key = `${userId}:${orgId}:${automationId}`;
      automationRunReadState.set(key, {
        automationId,
        orgId,
        readThroughAt,
        userId,
      });
    },
    async upsertChannelOrgMapping(record) {
      channelOrgMappings.set(mappingKey(record.channel, record.channelUserId), {
        ...record,
      });
    },

    async upsertComposioToolkit(record) {
      composioToolkits.set(record.id, record);
    },

    async upsertComposioUserConnection(record) {
      composioUserConnections.set(record.id, record);
    },
    async upsertExecutionRun(record) {
      const conflict = executionRunInsertConflict(executionRuns, record);
      if (conflict) {
        throw new Error(conflict);
      }
      executionRuns.set(record.id, { ...record });
    },
    async upsertExecutionStep(record) {
      const existing = executionSteps.get(record.runId) ?? [];
      const next = existing.filter((step) => step.id !== record.id);
      next.push({ ...record });
      executionSteps.set(record.runId, next);
    },
    async upsertLearningCandidate(record) {
      learningCandidates.set(record.id, { ...record });
    },
    async upsertLearningJob(record) {
      learningJobs.set(record.id, { ...record });
    },

    async upsertMcpServer(record) {
      const existing = mcpServers.get(record.id);

      if (existing) {
        mcpServersByName.delete(
          mcpServerNameKey(existing.orgId, existing.name)
        );
      }

      mcpServers.set(record.id, record);
      mcpServersByName.set(mcpServerNameKey(record.orgId, record.name), record);
    },

    async upsertNotificationDestination(record) {
      notificationDestinations.set(record.id, record);
    },

    async upsertOrgAiConfig(record) {
      orgAiConfigs.set(record.orgId, structuredClone(record));
    },

    async upsertOrganization(record) {
      const existing = organizations.get(record.id);
      const withSchedule = {
        ...record,
        skillsCuratorLastRunAt:
          record.skillsCuratorLastRunAt === undefined
            ? existing?.skillsCuratorLastRunAt
            : record.skillsCuratorLastRunAt,
      };
      const updated =
        existing?.archivedAt && !record.archivedAt
          ? { ...withSchedule, archivedAt: existing.archivedAt }
          : withSchedule;
      organizations.set(record.id, updated);
      organizationsBySlug.set(updated.slug, updated);
    },

    async upsertOrgMember(record) {
      orgMembers.set(`${record.orgId}:${record.userId}`, record);
    },

    upsertOrgUsageBudget(record) {
      orgUsageBudgets.set(record.orgId, { ...record });
      return Promise.resolve();
    },
    async upsertOutboxMessage(record) {
      outboundOutbox.set(record.id, { ...record });
    },

    async upsertProfile(record) {
      if (profiles.get(record.id)?.isImporting) {
        return;
      }
      if (record.isDefault && record.orgId) {
        for (const profile of profiles.values()) {
          if (
            profile.orgId === record.orgId &&
            profile.id !== record.id &&
            profile.isDefault
          ) {
            profiles.set(profile.id, { ...profile, isDefault: false });
          }
        }
      }

      profiles.set(record.id, { ...record, isImporting: false });
    },

    async upsertSession(record) {
      if (profiles.get(record.profileId)?.isImporting) {
        return;
      }
      sessions.set(record.id, record);
    },

    async upsertSkill(record) {
      const existing = skills.get(record.id);

      if (existing) {
        skillsBySourcePath.delete(existing.sourcePath);
      }

      skills.set(record.id, record);
      skillsBySourcePath.set(record.sourcePath, record);
    },

    async upsertTask(record) {
      tasks.set(record.id, record);
    },

    async upsertTool(record) {
      const existing = tools.get(record.id);

      if (existing) {
        toolsByName.delete(toolNameKey(existing.orgId, existing.name));
      }

      tools.set(record.id, record);
      toolsByName.set(toolNameKey(record.orgId, record.name), record);
    },

    async upsertWorkspaceSettings(record) {
      const normalized = {
        ...record,
        codingAgentProviderPassthrough:
          record.codingAgentProviderPassthrough !== false,
      };
      if (record.orgId) {
        orgWorkspaceSettings.set(record.orgId, structuredClone(normalized));
        return;
      }
      workspaceSettings = {
        ...normalized,
        codingAgentHarnesses: record.codingAgentHarnesses.map((harness) => ({
          ...harness,
          args: [...harness.args],
        })),
      };
    },
  };
}

function summarizeSession(
  session: StoredSessionRecord,
  messages: StoredSessionMessageRecord[]
): StoredSessionSummaryRecord {
  const sorted = [...messages].sort((left, right) => left.seq - right.seq);
  const updatedAt =
    sorted.length > 0
      ? sorted[sorted.length - 1]!.createdAt
      : session.createdAt;
  const firstUser = sorted.find(
    (message) =>
      typeof message.payload === "object" &&
      message.payload !== null &&
      (message.payload as { role?: string }).role === "user"
  );
  const preview =
    typeof firstUser?.payload === "object" &&
    firstUser.payload !== null &&
    (firstUser.payload as { role?: string }).role === "user"
      ? (() => {
          const content = (firstUser.payload as { content: string | unknown[] })
            .content;
          const text = getUserMessageText(
            content as string | MessageContentPart[]
          ).trim();
          return text || (Array.isArray(content) ? "[image]" : null);
        })()
      : null;

  return {
    channel: session.channel,
    createdAt: session.createdAt,
    id: session.id,
    messageCount: sorted.length,
    preview,
    profileId: session.profileId,
    title: session.title ?? null,
    updatedAt,
  };
}
