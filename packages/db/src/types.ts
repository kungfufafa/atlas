import type {
  AgentChannel,
  AgentQuestionnaire,
  AgentTodo,
  CompactedHistoryArchive,
  OrgRole,
  ThinkingEffort,
} from "@atlas/core";
import type {
  ArtifactPublication,
  ArtifactPublicationCaptureEvidence,
  ArtifactPublicationIdentity,
  ArtifactPublicationScope,
} from "@atlas/core/artifact-publication";

export type { OrgRole } from "@atlas/core";
export type ChannelType = "telegram" | "whatsapp" | "discord";

export type AutomationRunStatus = "running" | "completed" | "failed";

export interface StoredAutomationRecord {
  createdAt: string;
  definition: unknown;
  enabled: boolean;
  id: string;
  name: string;
  orgId?: string | null;
  profileId: string;
  updatedAt: string;
  version: number;
}

export interface StoredAutomationRunRecord {
  automationId: string;
  completedAt: string | null;
  deliveryError?: string | null;
  deliveryStatus?: string | null;
  error: string | null;
  id: string;
  output: string | null;
  startedAt: string;
  status: AutomationRunStatus;
}

export interface AutomationUnreadCountRecord {
  automationId: string;
  unreadCount: number;
}

export interface StoredProfileRecord {
  createdAt: string;
  id: string;
  isDefault?: boolean;
  /** Internal reservation state; importing profiles must never be user-visible. */
  isImporting?: boolean;
  isSuper: boolean;
  model: string | null;
  name: string;
  orgId?: string | null;
  /** null = inherit org default; true/false = force curator consolidation on/off */
  skillsCuratorConsolidation?: boolean | null;
  /** null = inherit org default; true/false = force post-turn review on/off for this profile */
  skillsPostTurnReview?: boolean | null;
  /** null = inherit org default; true/false = force gate on/off for this profile */
  skillsWriteApproval?: boolean | null;
  systemPrompt: string;
  thinkingEffort?: ThinkingEffort | null;
  thinkingEnabled?: boolean | null;
  updatedAt: string;
}

export interface ProfileImportPublication {
  composioAssignments: StoredProfileComposioToolkitRecord[];
  /** Existing tool records captured while planning, revalidated at publish. */
  expectedTools: ProfileImportExpectedTool[];
  mcpServerIds: string[];
  newSkills: StoredSkillRecord[];
  newTools: StoredToolRecord[];
  orgId: string;
  profileId: string;
  skillIds: string[];
  toolIds: string[];
}

export type ProfileImportExpectedTool = Pick<
  StoredToolRecord,
  "description" | "handlerConfig" | "handlerType" | "id" | "name" | "orgId"
>;

export type ProfileImportAdmission = "exists" | "inactive" | "reserved";
export type ProfileImportPublishResult = "conflict" | "inactive" | "published";

export interface StoredToolRecord {
  createdAt: string;
  description: string;
  handlerConfig: unknown;
  handlerType: string;
  id: string;
  name: string;
  orgId?: string | null;
  updatedAt: string;
}

export interface StoredSessionRecord {
  agentQuestionnaire: AgentQuestionnaire | null;
  agentTodos: AgentTodo[];
  channel: string;
  createdAt: string;
  id: string;
  modelOverride: string | null;
  orgId?: string | null;
  profileId: string;
  title: string | null;
  userId?: string | null;
}

export interface StoredSessionMessageRecord {
  createdAt: string;
  id: string;
  payload: unknown;
  seq: number;
  sessionId: string;
}

export interface StoredSessionHistoryArchiveRecord
  extends CompactedHistoryArchive {
  sessionId: string;
}

export type AttachmentKind = "image" | "document";

export interface StoredAttachmentRecord {
  channel: string;
  createdAt: string;
  filename: string | null;
  id: string;
  kind: AttachmentKind;
  mediaType: string;
  orgId: string | null;
  profileId: string;
  sessionId: string | null;
  sizeBytes: number;
  storagePath: string;
}

export interface StoredSessionSummaryRecord {
  channel: string;
  createdAt: string;
  id: string;
  messageCount: number;
  orgId?: string | null;
  preview: string | null;
  profileId: string;
  title: string | null;
  updatedAt: string;
}

export interface StoredTaskRecord {
  createdAt: string;
  createdByUserId?: string | null;
  description: string;
  id: string;
  orgId?: string | null;
  position: number;
  profileId: string;
  prompt: string;
  sessionId?: string | null;
  status: string;
  title: string;
  updatedAt: string;
}

export type TaskRunStatus = "running" | "completed" | "failed";

export interface StoredTaskRunRecord {
  completedAt: string | null;
  error: string | null;
  id: string;
  output: string | null;
  startedAt: string;
  status: TaskRunStatus;
  taskId: string;
}

export interface StoredLlmUsageStatsRecord {
  estimatedCostUsd: number;
  estimatedInvocations?: number;
  id: string;
  inputTokens: number;
  orgId?: string | null;
  outputTokens: number;
  reportedInvocations?: number;
  requestCount: number;
  trackedSince: string;
  unknownInvocations?: number;
  updatedAt: string;
}

export interface StoredLlmUsageModelStatsRecord {
  estimatedCostUsd: number;
  estimatedInvocations?: number;
  inputTokens: number;
  modelId: string;
  orgId?: string | null;
  outputTokens: number;
  reportedInvocations?: number;
  requestCount: number;
  trackedSince: string;
  unknownInvocations?: number;
  updatedAt: string;
}

export interface StoredWorkspaceSettingsRecord {
  codingAgentHarnesses: StoredCodingAgentHarnessRecord[];
  /** False opts this organization into host-native coding-harness login. */
  codingAgentProviderPassthrough: boolean;
  id: string;
  imageModel: string | null;
  orgId?: string | null;
  selectedCodingAgentHarness: string | null;
  /** null = inherit the ATLAS_OMNI env var; true/false = set explicitly here. */
  tokenOptimizerEnabled?: boolean | null;
  transcriptionModel: string | null;
  updatedAt: string;
  visionModel: string | null;
}

export interface StoredOrgAiConfigRecord {
  config: unknown;
  orgId: string;
  updatedAt: string;
}

export type StoredCodingAgentHarnessKind =
  | "codex"
  | "claude_code"
  | "opencode"
  | "pi"
  | "cursor_agent";

export interface StoredCodingAgentHarnessProbeCache {
  authenticated: boolean | null;
  checkedAt: string;
  nextStep: "install" | "retry" | null;
  ready: boolean;
  /** Prevents a readiness result from one organization/auth mode being reused by another. */
  scopeKey?: string | null;
  statusMessage: string | null;
}

export interface StoredCodingAgentHarnessRecord {
  args: string[];
  command: string;
  enabled: boolean;
  id: string;
  kind: StoredCodingAgentHarnessKind;
  name: string;
  probeCache?: StoredCodingAgentHarnessProbeCache | null;
}

export interface StoredNotificationDestinationRecord {
  channel: "telegram";
  config: {
    chatId: number;
    topicId?: number | null;
  };
  createdAt: string;
  id: string;
  name: string;
  orgId: string;
  secretHash: string;
  updatedAt: string;
}

export type StoredOrgComposioToolkitStatus = "disabled" | "enabled";

/** @deprecated Use StoredOrgComposioToolkitStatus for org catalog rows. */
export type StoredComposioToolkitStatus =
  | StoredOrgComposioToolkitStatus
  | "oauth_in_progress"
  | "connected"
  | "error";

export interface StoredComposioToolkitRecord {
  cachedTools: Array<{
    slug: string;
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
  createdAt: string;
  displayName: string;
  id: string;
  lastError: string | null;
  orgId: string;
  status: StoredOrgComposioToolkitStatus;
  toolkitSlug: string;
  updatedAt: string;
}

export type MemoryScope = "user" | "project" | "organization" | "agent";

export interface StoredMemoryRecord {
  confidence: number;
  content: string;
  createdAt: string;
  id: string;
  importance: number;
  orgId: string;
  ownerId: string;
  scope: MemoryScope;
  source?: string | null;
  subject?: string | null;
  updatedAt: string;
}

export type StoredComposioUserConnectionStatus =
  | "oauth_in_progress"
  | "connected"
  | "error";

export interface StoredComposioUserConnectionRecord {
  connectedAccountId: string | null;
  createdAt: string;
  id: string;
  lastError: string | null;
  oauthStateHash: string | null;
  orgId: string;
  sessionIdEnc: string | null;
  status: StoredComposioUserConnectionStatus;
  toolkitId: string;
  updatedAt: string;
  userId: string;
}

export interface StoredProfileComposioToolkitRecord {
  allowedActions: string[] | null;
  profileId: string;
  toolkitId: string;
}

export interface LlmUsageStatsDelta {
  estimatedCostUsd: number;
  estimatedInvocations?: number;
  inputTokens: number;
  outputTokens: number;
  reportedInvocations?: number;
  requestCount: number;
  unknownInvocations?: number;
}

/** Bytes one optimiser removed from one tool result before it was inserted. */
export interface ToolOutputSavingsDelta {
  bytesIn: number;
  bytesOut: number;
  optimizer: string;
  tool: string;
}

/** One request's provider tokens, tagged with the arm it belongs to. */
export interface LlmTurnUsageDelta {
  estimated: boolean;
  inputTokens: number;
  optimized: boolean;
  outputTokens: number;
}

export interface StoredLlmTurnUsageRecord {
  arm: string;
  bucket: string;
  estimatedTurns: number;
  inputTokens: number;
  orgId: string;
  outputTokens: number;
  turns: number;
}

/** Sentinel for a usage dimension that could not be resolved at record time. */
export const UNKNOWN_USAGE_DIMENSION = "unknown";

/** Capability id recorded for rollup rows written before capability tracking. */
export const DEFAULT_USAGE_CAPABILITY = "chat.completion";

/** Attribution dimensions for a single LLM turn's usage. */
export interface LlmUsageDimensions {
  /** Capability that ran (e.g. `chat.completion`, `image.generation`). */
  capability: string;
  /** Product surface that initiated the request. */
  channel: AgentChannel | typeof UNKNOWN_USAGE_DIMENSION;
  modelId: string;
  orgId: string;
  profileId: string;
  /** Stable id of the provider credential/instance that served the request. */
  providerCredentialId: string;
  providerType: string;
  userId: string;
}

/** Per-turn counters folded into a daily rollup row. */
export interface LlmUsageDelta {
  estimatedCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
}

export interface StoredLlmUsageDailyRecord extends LlmUsageDimensions {
  /** `YYYY-MM-DD` (UTC). */
  day: string;
  estimatedCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
  updatedAt: string;
}

export interface StoredOrgUsageBudgetRecord {
  /** Monthly spend limit in USD. 0 means "no budget set". */
  monthlyLimitUsd: number;
  orgId: string;
  updatedAt: string;
}

export type LlmUsageGroupBy =
  | "workspace"
  | "user"
  | "profile"
  | "channel"
  | "provider"
  | "credential"
  | "model"
  | "capability";

export interface LlmUsageAggregateOptions {
  /** Restrict to a single initiating product surface. */
  channel?: string;
  /** Inclusive lower bound, `YYYY-MM-DD` (UTC). */
  from?: string;
  groupBy: LlmUsageGroupBy;
  /** Max rows returned, ordered by estimated cost, then tokens and requests. */
  limit?: number;
  /** Restrict to a single workspace (org admins are always scoped this way). */
  orgId?: string;
  /** Inclusive upper bound, `YYYY-MM-DD` (UTC). */
  to?: string;
  /** Restrict to a single user (members are scoped to themselves). */
  userId?: string;
}

export interface LlmUsageAggregateRow {
  estimatedCostUsd: number;
  inputTokens: number;
  /** Grouping key value (e.g. org id, user id, provider type, model id). */
  key: string;
  outputTokens: number;
  requestCount: number;
  totalTokens: number;
}

export interface StoredToolOutputSavingsRecord {
  /** Day the bytes were removed, `YYYY-MM-DD`. Day resolution because the panel
   * plots days and an hour column would be 24x the rows for a chart nobody asked
   * for at that grain. */
  bucket: string;
  bytesIn: number;
  bytesOut: number;
  calls: number;
  optimizer: string;
  orgId: string;
  tool: string;
  trackedSince: string;
  updatedAt: string;
}

export type McpServerStatus = "connected" | "disconnected" | "error";
export type McpTransport = "http" | "stdio";

export interface CachedMcpTool {
  description: string;
  inputSchema?: unknown;
  name: string;
}

export interface StoredSkillRecord {
  createdAt: string;
  createdBy: SkillCreatedBy;
  description: string;
  disableModelInvocation: boolean;
  enabled: boolean;
  hasTool: boolean;
  id: string;
  name: string;
  orgId?: string | null;
  sourcePath: string;
  updatedAt: string;
}

export type SkillCreatedBy = "agent" | "human" | "bundled";

export interface StoredSkillUsageRecord {
  createdAt: string;
  lastPatchedAt: string | null;
  lastUsedAt: string | null;
  lastViewedAt: string | null;
  orgId: string;
  patchCount: number;
  profileId: string;
  skillId: string;
  updatedAt: string;
  useCount: number;
  viewCount: number;
}

export interface StoredMcpServerRecord {
  cachedTools: CachedMcpTool[];
  config: unknown;
  createdAt: string;
  enabled: boolean;
  id: string;
  lastError: string | null;
  name: string;
  orgId?: string | null;
  status: McpServerStatus;
  transport: McpTransport;
  updatedAt: string;
}

export interface StoredUserRecord {
  createdAt: string;
  email: string;
  id: string;
  isPlatformAdmin?: boolean;
  name?: string | null;
  passwordHash: string;
  phone?: string | null;
  updatedAt: string;
}

export interface StoredOrganizationRecord {
  archivedAt?: string | null;
  createdAt: string;
  id: string;
  name: string;
  skillsCuratorConsolidation?: boolean;
  skillsCuratorLastRunAt?: string | null;
  skillsPostTurnReview?: boolean;
  skillsWriteApproval?: boolean;
  slug: string;
  updatedAt: string;
}

export interface StoredOrgMemberRecord {
  createdAt: string;
  orgId: string;
  role: OrgRole;
  userContext?: string | null;
  userId: string;
}

export interface StoredUserOrganizationRecord {
  joinedAt: string;
  organization: StoredOrganizationRecord;
  role: OrgRole;
}

export interface StoredOrgInviteRecord {
  acceptedAt: string | null;
  createdAt: string;
  email: string;
  expiresAt: string;
  id: string;
  invitedByUserId: string;
  orgId: string;
  revokedAt: string | null;
  role: OrgRole;
  tokenHash: string;
}

export type OrgMemoryProposalStatus = "pending" | "approved" | "rejected";

export type ProfileChangeSource =
  | "dashboard"
  | "super_bot"
  | "skill_manage"
  | "pack_import";

export type ProfileChangeField =
  | "system_prompt"
  | "soul.soul"
  | "soul.style"
  | "soul.instructions"
  | "soul.memory"
  | "tools"
  | "skills"
  | "mcp"
  | "pack_import";

export interface StoredProfileChangeEvent {
  actorUserId: string | null;
  afterValue: string | null;
  beforeValue: string | null;
  createdAt: string;
  field: ProfileChangeField;
  id: string;
  orgId: string;
  profileId: string;
  source: ProfileChangeSource;
}

export interface StoredOrgMemoryProposal {
  bullet: string;
  createdAt: string;
  id: string;
  orgId: string;
  pinned: boolean;
  profileId: string | null;
  proposedByUserId: string | null;
  reviewedAt: string | null;
  reviewerUserId: string | null;
  sessionId: string | null;
  status: OrgMemoryProposalStatus;
}

export type SkillProposalStatus = "pending" | "approved" | "rejected";
export type SkillProposalAction =
  | "create"
  | "patch"
  | "delete"
  | "edit"
  | "write_file"
  | "remove_file"
  | "consolidate";

export interface StoredSkillConsolidationRef {
  id: string;
  name: string;
  sha256: string;
}

export interface StoredSkillConsolidationPayload {
  losers: StoredSkillConsolidationRef[];
  winner: StoredSkillConsolidationRef;
}

export interface StoredSkillProposal {
  action: SkillProposalAction;
  consolidation?: StoredSkillConsolidationPayload | null;
  content: string | null;
  createdAt: string;
  id: string;
  orgId: string;
  patchNewString: string | null;
  patchOldString: string | null;
  profileId: string;
  proposedByUserId: string | null;
  relativePath: string | null;
  reviewedAt: string | null;
  reviewerUserId: string | null;
  sessionId: string | null;
  skillName: string;
  status: SkillProposalStatus;
}

export type SkillSuggestionStatus = "pending" | "applied";
export type SkillSuggestionAction = "create" | "patch";
export type SkillSuggestionSource = "post_turn_review";

export interface StoredSkillSuggestion {
  action: SkillSuggestionAction;
  appliedAt: string | null;
  content: string | null;
  createdAt: string;
  id: string;
  orgId: string;
  patchNewString: string | null;
  patchOldString: string | null;
  profileId: string;
  proposedByUserId: string | null;
  sessionId: string | null;
  skillName: string;
  source: SkillSuggestionSource;
  status: SkillSuggestionStatus;
  warnings: string[] | null;
}

export interface StoredArtifactPublicationRecord extends ArtifactPublication {
  /** Server-private selected-file evidence, never included in public publication projections. */
  captureEvidence?: ArtifactPublicationCaptureEvidence;
  snapshotId: string;
}

export interface ArtifactPublicationPageOptions {
  after?: { createdAt: string; id: string };
  limit: number;
}

export interface StoredArtifactShareRecord {
  createdAt: string;
  createdByUserId: string;
  filename: string;
  id: string;
  mimeType: string;
  orgId: string;
  profileId: string;
  revokedAt: string | null;
  sizeBytes: number;
  sourcePath: string;
  storagePath: string;
  tokenHash: string;
}

export interface StoredChannelOrgMappingRecord {
  channel: ChannelType;
  channelUserId: string;
  createdAt: string;
  orgId: string;
  userId: string;
}

export type ExecutionRunKind = "chat" | "automation" | "task" | "subagent";

export interface StoredExecutionRunRecord {
  checkpoint: string | null;
  createdAt: string;
  currentStepIndex: number;
  id: string;
  idempotencyKey: string | null;
  kind: ExecutionRunKind;
  leaseExpiresAt: string | null;
  leaseOwner: string | null;
  orgId: string;
  principalUserId: string;
  sessionId: string | null;
  status: string;
  updatedAt: string;
}

export interface CasExecutionRunInput {
  expectedLeaseOwner?: string;
  id: string;
  next: StoredExecutionRunRecord;
  nowIso?: string;
  requireExpiredLease?: boolean;
  requireUnexpiredLease?: boolean;
}

export interface StoredExecutionStepRecord {
  approvalId: string | null;
  argsHash: string;
  argsJson: string;
  createdAt: string;
  id: string;
  resultJson: string | null;
  runId: string;
  status: string;
  stepIndex: number;
  toolCallId: string | null;
  toolName: string;
  updatedAt: string;
}

export interface StoredActionApprovalRecord {
  actionHash: string;
  argsJson: string;
  createdAt: string;
  decidedAt: string | null;
  decidedByUserId: string | null;
  expiresAt: string;
  grantId: string | null;
  id: string;
  orgId: string;
  principalUserId: string;
  runId: string;
  sessionId: string | null;
  status: string;
  stepId: string;
  toolName: string;
}

export interface StoredLearningEvidenceRecord {
  createdAt: string;
  id: string;
  kind: string;
  orgId: string;
  payloadJson: string;
  principalUserId: string;
  runId: string | null;
  sessionId: string | null;
}

export interface StoredLearningCandidateRecord {
  content: string;
  createdAt: string;
  evidenceIds: string;
  id: string;
  kind: string;
  orgId: string;
  status: string;
  target: string;
  updatedAt: string;
}

export interface StoredLearningCommitRecord {
  candidateId: string;
  createdAt: string;
  id: string;
  memoryId: string | null;
  orgId: string;
  skillId: string | null;
}

export interface StoredLearningOutcomeRecord {
  commitId: string;
  createdAt: string;
  helpful: boolean | null;
  id: string;
  orgId: string;
  sessionId: string | null;
  used: boolean;
}

export interface StoredLearningJobRecord {
  createdAt: string;
  evaluatorVersion: string;
  id: string;
  idempotencyKey: string;
  mode: string;
  orgId: string;
  principalUserId: string;
  resultJson: string | null;
  sessionId: string;
  status: string;
  terminalMessageId: string;
  updatedAt: string;
}

export interface StoredAuditEventRecord {
  action: string;
  createdAt: string;
  id: string;
  orgId: string;
  payloadJson: string;
  principalUserId: string;
  resource: string;
  runId: string | null;
}

export interface StoredOutboxRecord {
  attempt: number;
  createdAt: string;
  envelopeJson: string;
  id: string;
  orgId: string;
  principalUserId: string;
  status: string;
  updatedAt: string;
}

export interface StoredSkillRevisionRecord {
  content: string;
  createdAt: string;
  createdByUserId: string | null;
  evidenceIds: string | null;
  id: string;
  orgId: string;
  skillId: string;
  version: number;
}

export interface StoredBrowserSessionRecord {
  activeOrgId?: string | null;
  createdAt: string;
  csrfTokenHash: string;
  expiresAt: string;
  id: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  sessionTokenHash: string;
  userId: string;
}

export interface DatabaseAdapter {
  /** Aggregate the daily usage rollup by a single dimension. */
  aggregateLlmUsage(
    options: LlmUsageAggregateOptions
  ): Promise<LlmUsageAggregateRow[]>;
  appendMessagesForSession(
    sessionId: string,
    messages: StoredSessionMessageRecord[]
  ): Promise<void>;
  /** Atomically publishes DB state for a filesystem-staged skill consolidation. */
  applySkillConsolidation(input: {
    archivedLosers: Array<{
      archivedSourcePath: string;
      id: string;
      name: string;
    }>;
    expectedConsolidation: StoredSkillConsolidationPayload;
    orgId: string;
    profileId: string;
    proposalId: string;
    reviewedAt: string;
    reviewerUserId: string;
    winner: StoredSkillRecord;
  }): Promise<boolean>;
  assignMcpServerToProfile(profileId: string, serverId: string): Promise<void>;
  assignSkillToProfile(profileId: string, skillId: string): Promise<void>;
  assignToolToProfile(profileId: string, toolId: string): Promise<void>;
  casExecutionRun(input: CasExecutionRunInput): Promise<boolean>;
  claimTaskOwner(
    taskId: string,
    orgId: string,
    userId: string,
    updatedAt: string
  ): Promise<boolean>;

  /** Atomically commit the complete output set, or reuse an exactly matching execution. */
  commitArtifactPublications(
    identity: ArtifactPublicationIdentity,
    records: readonly StoredArtifactPublicationRecord[]
  ): Promise<StoredArtifactPublicationRecord[]>;
  /**
   * Atomically replaces an existing Composio connection only when its current
   * OAuth state hash matches the expected generation.
   */
  compareAndSwapComposioUserConnection(
    record: StoredComposioUserConnectionRecord,
    expectedOAuthStateHash: string | null
  ): Promise<boolean>;
  /** Users excluding the auto-created CLI bearer-auth identity. */
  countHumanUsers(): Promise<number>;
  countOrgMemoryProposals(
    orgId: string,
    status: OrgMemoryProposalStatus
  ): Promise<number>;
  countPendingSkillProposals(
    orgId: string,
    profileId?: string
  ): Promise<number>;
  countProfileMcpAssignments(): Promise<number>;
  countUnreadAutomationRunsByOrg(
    userId: string,
    orgId: string
  ): Promise<AutomationUnreadCountRecord[]>;
  countUsers(): Promise<number>;
  createArtifactShare(record: StoredArtifactShareRecord): Promise<void>;
  createAuditEvent(record: StoredAuditEventRecord): Promise<void>;

  createBrowserSession(record: StoredBrowserSessionRecord): Promise<void>;
  createLearningCommit(record: StoredLearningCommitRecord): Promise<void>;
  createLearningEvidence(record: StoredLearningEvidenceRecord): Promise<void>;
  createLearningOutcome(record: StoredLearningOutcomeRecord): Promise<void>;

  // Scoped Memory Methods
  createMemory(record: StoredMemoryRecord): Promise<void>;

  /** Atomically reuse an exact scoped fact or insert; never replace other content. */
  createOrGetMemory(record: StoredMemoryRecord): Promise<StoredMemoryRecord>;

  createOrgInvite(record: StoredOrgInviteRecord): Promise<void>;

  createOrgMemoryProposal(record: StoredOrgMemoryProposal): Promise<void>;

  /** Append-only insert. Adapters intentionally expose no update/delete API. */
  createProfileChangeEvent(record: StoredProfileChangeEvent): Promise<void>;

  /** Atomically inserts a profile and returns false when its global id exists. */
  createProfileIfAbsent(record: StoredProfileRecord): Promise<boolean>;

  createSkillProposal(record: StoredSkillProposal): Promise<void>;
  createSkillRevision(record: StoredSkillRevisionRecord): Promise<void>;

  createSkillSuggestion(record: StoredSkillSuggestion): Promise<void>;
  createUser(record: StoredUserRecord): Promise<void>;
  deleteAttachment(id: string): Promise<boolean>;
  deleteAutomation(id: string): Promise<boolean>;
  deleteAutomationRun(automationId: string, runId: string): Promise<boolean>;
  deleteChannelOrgMapping(
    orgId: string,
    channel: ChannelType,
    channelUserId: string
  ): Promise<boolean>;
  deleteComposioToolkit(id: string): Promise<boolean>;
  deleteComposioUserConnection(id: string): Promise<boolean>;
  deleteExecutionRunIfOwner(id: string, leaseOwner: string): Promise<boolean>;
  deleteMcpServer(id: string): Promise<boolean>;
  deleteMemory(orgId: string, id: string): Promise<boolean>;
  deleteMessagesForSession(sessionId: string): Promise<void>;
  deleteNotificationDestination(id: string): Promise<boolean>;
  deleteOrgMember(orgId: string, userId: string): Promise<boolean>;
  deleteProfile(id: string): Promise<boolean>;
  deleteProfileForOrg(id: string, orgId: string): Promise<boolean>;
  deleteProfileImportReservation(id: string, orgId: string): Promise<boolean>;
  deleteSession(id: string): Promise<boolean>;
  deleteSkill(id: string): Promise<boolean>;
  deleteTask(id: string): Promise<boolean>;
  deleteTool(id: string): Promise<boolean>;
  getActionApproval(id: string): Promise<StoredActionApprovalRecord | null>;
  getActiveArtifactShareByPath(
    orgId: string,
    profileId: string,
    sourcePath: string
  ): Promise<StoredArtifactShareRecord | null>;
  getActiveAutomationRun(
    automationId: string
  ): Promise<StoredAutomationRunRecord | null>;
  getActiveTaskRun(taskId: string): Promise<StoredTaskRunRecord | null>;
  getArtifactPublication(
    scope: ArtifactPublicationScope,
    id: string
  ): Promise<StoredArtifactPublicationRecord | null>;
  getArtifactShareById(
    orgId: string,
    profileId: string,
    shareId: string
  ): Promise<StoredArtifactShareRecord | null>;
  getArtifactShareByTokenHash(
    tokenHash: string
  ): Promise<StoredArtifactShareRecord | null>;
  getAttachment(id: string): Promise<StoredAttachmentRecord | null>;
  getAutomation(id: string): Promise<StoredAutomationRecord | null>;

  getAutomationRunReadThrough(
    userId: string,
    orgId: string,
    automationId: string
  ): Promise<string | null>;
  getBrowserSessionBySessionTokenHash(
    sessionTokenHash: string
  ): Promise<StoredBrowserSessionRecord | null>;
  getChannelOrgMapping(
    orgId: string,
    channel: ChannelType,
    channelUserId: string
  ): Promise<StoredChannelOrgMappingRecord | null>;
  getComposioToolkit(id: string): Promise<StoredComposioToolkitRecord | null>;
  getComposioToolkitBySlug(
    orgId: string,
    toolkitSlug: string
  ): Promise<StoredComposioToolkitRecord | null>;
  getComposioUserConnection(
    userId: string,
    toolkitId: string
  ): Promise<StoredComposioUserConnectionRecord | null>;
  getComposioUserConnectionById(
    id: string
  ): Promise<StoredComposioUserConnectionRecord | null>;
  getConversationHistory(
    orgId: string,
    sessionId: string,
    options?: {
      archiveId?: string;
      excludeSuperAgent?: boolean;
      limit?: number;
      offset?: number;
      userId?: string;
    }
  ): Promise<{
    archiveId?: string;
    archivedAt?: string;
    createdAt: string;
    messages: StoredConversationMessageItem[];
    profileId: string;
    sessionId: string;
    title: string | null;
    totalMessages: number;
  } | null>;
  getDefaultProfileForOrg(orgId: string): Promise<StoredProfileRecord | null>;

  getExecutionRun(id: string): Promise<StoredExecutionRunRecord | null>;
  getExecutionRunByIdempotencyKey(
    orgId: string,
    idempotencyKey: string
  ): Promise<StoredExecutionRunRecord | null>;
  getLearningCandidate(
    id: string
  ): Promise<StoredLearningCandidateRecord | null>;
  getLearningJobByIdempotencyKey(
    orgId: string,
    idempotencyKey: string
  ): Promise<StoredLearningJobRecord | null>;

  getLlmUsageStats(): Promise<StoredLlmUsageStatsRecord | null>;
  getMcpServer(id: string): Promise<StoredMcpServerRecord | null>;
  getMcpServerByName(
    name: string,
    orgId?: string | null
  ): Promise<StoredMcpServerRecord | null>;
  getMemory(orgId: string, id: string): Promise<StoredMemoryRecord | null>;
  getNotificationDestination(
    id: string
  ): Promise<StoredNotificationDestinationRecord | null>;
  getOrgAiConfig(orgId: string): Promise<StoredOrgAiConfigRecord | null>;
  getOrganizationById(id: string): Promise<StoredOrganizationRecord | null>;
  getOrganizationBySlug(slug: string): Promise<StoredOrganizationRecord | null>;
  getOrgInviteByTokenHash(
    tokenHash: string
  ): Promise<StoredOrgInviteRecord | null>;
  getOrgMember(
    orgId: string,
    userId: string
  ): Promise<StoredOrgMemberRecord | null>;
  getOrgMemoryProposal(
    orgId: string,
    id: string
  ): Promise<StoredOrgMemoryProposal | null>;

  getOrgUsageBudget(orgId: string): Promise<StoredOrgUsageBudgetRecord | null>;
  getPendingOrgInvite(
    orgId: string,
    email: string
  ): Promise<StoredOrgInviteRecord | null>;
  getPendingOrgMemoryProposalByBullet(
    orgId: string,
    bullet: string
  ): Promise<StoredOrgMemoryProposal | null>;
  getPendingSkillProposalForCreate(
    orgId: string,
    profileId: string,
    skillName: string
  ): Promise<StoredSkillProposal | null>;
  getPendingSkillProposalForPatch(
    orgId: string,
    profileId: string,
    skillName: string,
    patchOldString: string,
    patchNewString: string
  ): Promise<StoredSkillProposal | null>;
  getPendingSkillProposalForSkill(
    orgId: string,
    profileId: string,
    skillName: string
  ): Promise<StoredSkillProposal | null>;
  getProfile(id: string): Promise<StoredProfileRecord | null>;
  getProfileForOrg(
    id: string,
    orgId: string
  ): Promise<StoredProfileRecord | null>;
  getSession(id: string): Promise<StoredSessionRecord | null>;
  getSessionQuestionnaire(
    sessionId: string
  ): Promise<AgentQuestionnaire | null>;
  getSessionTodos(sessionId: string): Promise<AgentTodo[]>;
  getSkill(id: string): Promise<StoredSkillRecord | null>;
  /**
   * Resolve a skill by name within `orgId`, falling back to a global (bundled)
   * skill of that name. Omit `orgId` to look up global skills only.
   */
  getSkillByName(
    name: string,
    orgId?: string | null
  ): Promise<StoredSkillRecord | null>;
  getSkillBySourcePath(sourcePath: string): Promise<StoredSkillRecord | null>;
  getSkillProposal(
    orgId: string,
    id: string
  ): Promise<StoredSkillProposal | null>;
  getSkillSuggestion(
    orgId: string,
    id: string
  ): Promise<StoredSkillSuggestion | null>;
  getSkillUsage(
    profileId: string,
    skillId: string
  ): Promise<StoredSkillUsageRecord | null>;
  getTask(id: string): Promise<StoredTaskRecord | null>;
  getTool(id: string): Promise<StoredToolRecord | null>;
  getToolByName(
    name: string,
    orgId?: string | null
  ): Promise<StoredToolRecord | null>;
  getUserByEmail(email: string): Promise<StoredUserRecord | null>;
  getUserById(id: string): Promise<StoredUserRecord | null>;
  getUserContext(orgId: string, userId: string): Promise<string | null>;

  getWorkspaceSettings(
    orgId?: string
  ): Promise<StoredWorkspaceSettingsRecord | null>;
  incrementLlmTurnUsage(orgId: string, delta: LlmTurnUsageDelta): Promise<void>;

  /** Fold one LLM turn into the multi-tenant daily usage rollup. */
  incrementLlmUsageDaily(
    dimensions: LlmUsageDimensions,
    delta: LlmUsageDelta
  ): Promise<void>;
  incrementLlmUsageStats(
    delta: LlmUsageStatsDelta,
    trackedSince: string
  ): Promise<void>;
  incrementLlmUsageStatsByModel(
    modelId: string,
    delta: LlmUsageStatsDelta,
    trackedSince: string
  ): Promise<void>;
  incrementSkillUsage(input: {
    orgId: string;
    profileId: string;
    skillId: string;
    viewDelta?: number;
    useDelta?: number;
    patchDelta?: number;
    viewedAt?: string;
    usedAt?: string;
    patchedAt?: string;
  }): Promise<void>;
  incrementToolOutputSavings(
    orgId: string,
    delta: ToolOutputSavingsDelta,
    trackedSince: string
  ): Promise<void>;

  insertAttachment(record: StoredAttachmentRecord): Promise<void>;
  insertAutomationRun(record: StoredAutomationRunRecord): Promise<void>;
  insertExecutionRunIfAbsent(
    record: StoredExecutionRunRecord
  ): Promise<boolean>;
  insertTaskRun(record: StoredTaskRunRecord): Promise<void>;
  isArtifactPublicationSnapshotReferenced(snapshotId: string): Promise<boolean>;
  listActionApprovalsForSession(
    sessionId: string
  ): Promise<StoredActionApprovalRecord[]>;
  listArtifactPublications(
    scope: ArtifactPublicationScope,
    options: ArtifactPublicationPageOptions
  ): Promise<StoredArtifactPublicationRecord[]>;

  listAutomationRuns(
    automationId: string,
    limit?: number
  ): Promise<StoredAutomationRunRecord[]>;

  listAutomations(): Promise<StoredAutomationRecord[]>;
  listAutomationsForOrg(orgId: string): Promise<StoredAutomationRecord[]>;
  listChannelOrgMappingsForOrg(
    orgId: string
  ): Promise<StoredChannelOrgMappingRecord[]>;

  listComposioToolkitsForOrg(
    orgId: string
  ): Promise<StoredComposioToolkitRecord[]>;

  listComposioUserConnectionsForOrg(
    orgId: string
  ): Promise<StoredComposioUserConnectionRecord[]>;

  listComposioUserConnectionsForUser(
    orgId: string,
    userId: string
  ): Promise<StoredComposioUserConnectionRecord[]>;
  listExecutionRuns(filter?: {
    kind?: ExecutionRunKind;
    orgId?: string;
    sessionId?: string;
  }): Promise<StoredExecutionRunRecord[]>;
  listExecutionSteps(runId: string): Promise<StoredExecutionStepRecord[]>;
  listLearningCandidates(
    orgId: string,
    status?: string
  ): Promise<StoredLearningCandidateRecord[]>;
  listLearningCommits(orgId: string): Promise<StoredLearningCommitRecord[]>;
  listLearningEvidenceForSession(
    orgId: string,
    sessionId: string
  ): Promise<StoredLearningEvidenceRecord[]>;
  listLearningOutcomesForCommit(
    commitId: string
  ): Promise<StoredLearningOutcomeRecord[]>;
  listLlmTurnUsage(orgId: string): Promise<StoredLlmTurnUsageRecord[]>;
  listLlmUsageStatsByModel(): Promise<StoredLlmUsageModelStatsRecord[]>;
  listMcpServerProfileCounts(): Promise<Record<string, number>>;

  listMcpServers(): Promise<StoredMcpServerRecord[]>;
  listMcpServersForOrg(orgId: string): Promise<StoredMcpServerRecord[]>;

  listMcpServersForProfile(profileId: string): Promise<StoredMcpServerRecord[]>;
  listMemories(
    orgId: string,
    scope?: string,
    ownerId?: string,
    limit?: number
  ): Promise<StoredMemoryRecord[]>;

  listMessagesForSession(
    sessionId: string
  ): Promise<StoredSessionMessageRecord[]>;

  listNotificationDestinationsForOrg(
    orgId: string
  ): Promise<StoredNotificationDestinationRecord[]>;
  listOrganizations(): Promise<StoredOrganizationRecord[]>;
  listOrgMembers(orgId: string): Promise<StoredOrgMemberRecord[]>;
  listOrgMemoryProposals(
    orgId: string,
    status?: OrgMemoryProposalStatus
  ): Promise<StoredOrgMemoryProposal[]>;
  listOrgUsageBudgets(): Promise<StoredOrgUsageBudgetRecord[]>;

  listProfileChangeEvents(
    orgId: string,
    profileId: string,
    options?: { limit?: number; offset?: number }
  ): Promise<StoredProfileChangeEvent[]>;

  listProfileComposioToolkits(
    profileId: string
  ): Promise<StoredProfileComposioToolkitRecord[]>;

  listProfiles(): Promise<StoredProfileRecord[]>;
  listProfilesForMcpServer(serverId: string): Promise<StoredProfileRecord[]>;
  listProfilesForOrg(orgId: string): Promise<StoredProfileRecord[]>;
  listQueuedOutbox(orgId: string): Promise<StoredOutboxRecord[]>;
  listSessionSummaries(
    profileId: string,
    channel: string,
    userId?: string
  ): Promise<StoredSessionSummaryRecord[]>;

  listSessions(): Promise<StoredSessionRecord[]>;
  listSkillProposals(
    orgId: string,
    options?: {
      status?: SkillProposalStatus;
      profileId?: string;
      sessionId?: string;
    }
  ): Promise<StoredSkillProposal[]>;
  listSkillRevisions(skillId: string): Promise<StoredSkillRevisionRecord[]>;
  listSkillSuggestions(
    orgId: string,
    options?: {
      sessionId?: string;
      status?: SkillSuggestionStatus;
      profileId?: string;
    }
  ): Promise<StoredSkillSuggestion[]>;

  listSkills(): Promise<StoredSkillRecord[]>;

  listSkillsForProfile(profileId: string): Promise<StoredSkillRecord[]>;

  listSkillUsageForProfile(
    profileId: string
  ): Promise<StoredSkillUsageRecord[]>;

  listTaskRuns(taskId: string, limit?: number): Promise<StoredTaskRunRecord[]>;

  listTasks(): Promise<StoredTaskRecord[]>;
  listTasksForOrg(orgId: string): Promise<StoredTaskRecord[]>;
  listToolOutputSavings(
    orgId: string
  ): Promise<StoredToolOutputSavingsRecord[]>;

  listTools(): Promise<StoredToolRecord[]>;
  listToolsForOrg(orgId: string): Promise<StoredToolRecord[]>;

  listToolsForProfile(profileId: string): Promise<StoredToolRecord[]>;
  listUserOrganizations(
    userId: string
  ): Promise<StoredUserOrganizationRecord[]>;
  markOrgInviteAccepted(id: string, acceptedAt: string): Promise<void>;
  markSkillCuratorRunCompleted(
    orgId: string,
    completedAt: string
  ): Promise<boolean>;
  markSkillSuggestionApplied(
    orgId: string,
    id: string,
    appliedAt: string
  ): Promise<boolean>;

  /** Delete rollup rows on or before a `YYYY-MM-DD` day (retention). */
  pruneLlmUsageDaily(beforeDay: string): Promise<number>;
  publishProfileImport(
    publication: ProfileImportPublication
  ): Promise<ProfileImportPublishResult>;
  replaceMessagesForSession(
    sessionId: string,
    messages: StoredSessionMessageRecord[],
    archives?: StoredSessionHistoryArchiveRecord[]
  ): Promise<void>;
  replaceProfileComposioToolkits(
    profileId: string,
    assignments: StoredProfileComposioToolkitRecord[]
  ): Promise<void>;
  reserveProfileImport(
    record: StoredProfileRecord
  ): Promise<ProfileImportAdmission>;
  revokeArtifactPublication(
    scope: ArtifactPublicationScope,
    id: string,
    revokedAt: string
  ): Promise<boolean>;
  revokeArtifactShare(id: string, revokedAt: string): Promise<boolean>;
  revokeBrowserSessionBySessionTokenHash(
    sessionTokenHash: string,
    revokedAt: string
  ): Promise<boolean>;
  revokeOtherBrowserSessionsForUser(
    userId: string,
    keepSessionTokenHash: string,
    revokedAt: string
  ): Promise<number>;

  // Conversation Retrieval Methods
  searchConversationMessages(
    orgId: string,
    query: string,
    options?: {
      after?: string;
      before?: string;
      excludeSuperAgent?: boolean;
      limit?: number;
      /** Native topic lookup opts into bounded lexical ranking; default stays literal. */
      matchMode?: "literal" | "keywords";
      profileId?: string;
      userId?: string;
    }
  ): Promise<StoredConversationSearchResult[]>;
  searchMemories(
    orgId: string,
    query: string | readonly string[],
    scope?: string,
    ownerId?: string,
    limit?: number
  ): Promise<StoredMemoryRecord[]>;
  setUserContext(
    orgId: string,
    userId: string,
    content: string,
    updatedAt: string
  ): Promise<void>;
  /** Atomically archives an active org only when another active org remains. */
  tryMarkOrganizationArchived(
    orgId: string,
    archivedAt: string
  ): Promise<boolean>;
  unassignMcpServerFromProfile(
    profileId: string,
    serverId: string
  ): Promise<boolean>;
  unassignSkillFromProfile(
    profileId: string,
    skillId: string
  ): Promise<boolean>;
  unassignToolFromProfile(profileId: string, toolId: string): Promise<boolean>;
  updateArtifactShareSnapshot(
    id: string,
    snapshot: Pick<
      StoredArtifactShareRecord,
      "filename" | "mimeType" | "sizeBytes" | "storagePath"
    >
  ): Promise<void>;
  updateAutomationRun(record: StoredAutomationRunRecord): Promise<void>;
  updateBrowserSessionActiveOrgId(
    id: string,
    activeOrgId: string | null
  ): Promise<void>;
  updateBrowserSessionLastUsedAt(id: string, lastUsedAt: string): Promise<void>;
  updateMemory(
    orgId: string,
    id: string,
    patch: Partial<StoredMemoryRecord>
  ): Promise<void>;
  updateOrgMemoryProposalStatus(
    orgId: string,
    id: string,
    update: {
      status: OrgMemoryProposalStatus;
      reviewerUserId: string;
      reviewedAt: string;
      pinned?: boolean;
    }
  ): Promise<boolean>;
  updateSessionModelOverride(
    sessionId: string,
    modelOverride: string | null
  ): Promise<boolean>;
  updateSessionQuestionnaire(
    sessionId: string,
    questionnaire: AgentQuestionnaire | null
  ): Promise<void>;
  updateSessionTitle(sessionId: string, title: string): Promise<boolean>;
  updateSessionTodos(sessionId: string, todos: AgentTodo[]): Promise<void>;
  updateSkillProposalStatus(
    orgId: string,
    id: string,
    update: {
      status: SkillProposalStatus;
      reviewerUserId: string;
      reviewedAt: string;
    }
  ): Promise<boolean>;
  updateTaskRun(record: StoredTaskRunRecord): Promise<void>;
  updateUserPassword(
    id: string,
    passwordHash: string,
    updatedAt: string
  ): Promise<void>;
  updateUserProfile(
    id: string,
    profile: { name: string | null; phone: string | null; email?: string },
    updatedAt: string
  ): Promise<void>;
  upsertActionApproval(record: StoredActionApprovalRecord): Promise<void>;
  upsertAutomation(record: StoredAutomationRecord): Promise<void>;
  upsertAutomationRunReadThrough(
    userId: string,
    orgId: string,
    automationId: string,
    readThroughAt: string
  ): Promise<void>;
  upsertChannelOrgMapping(record: StoredChannelOrgMappingRecord): Promise<void>;
  upsertComposioToolkit(record: StoredComposioToolkitRecord): Promise<void>;
  upsertComposioUserConnection(
    record: StoredComposioUserConnectionRecord
  ): Promise<void>;
  upsertExecutionRun(record: StoredExecutionRunRecord): Promise<void>;
  upsertExecutionStep(record: StoredExecutionStepRecord): Promise<void>;
  upsertLearningCandidate(record: StoredLearningCandidateRecord): Promise<void>;
  upsertLearningJob(record: StoredLearningJobRecord): Promise<void>;
  upsertMcpServer(record: StoredMcpServerRecord): Promise<void>;
  upsertNotificationDestination(
    record: StoredNotificationDestinationRecord
  ): Promise<void>;
  upsertOrgAiConfig(record: StoredOrgAiConfigRecord): Promise<void>;

  upsertOrganization(record: StoredOrganizationRecord): Promise<void>;
  upsertOrgMember(record: StoredOrgMemberRecord): Promise<void>;
  upsertOrgUsageBudget(record: StoredOrgUsageBudgetRecord): Promise<void>;
  upsertOutboxMessage(record: StoredOutboxRecord): Promise<void>;
  upsertProfile(record: StoredProfileRecord): Promise<void>;
  upsertSession(record: StoredSessionRecord): Promise<void>;
  upsertSkill(record: StoredSkillRecord): Promise<void>;
  upsertTask(record: StoredTaskRecord): Promise<void>;
  upsertTool(record: StoredToolRecord): Promise<void>;
  upsertWorkspaceSettings(record: StoredWorkspaceSettingsRecord): Promise<void>;
}

export interface StoredConversationSearchResult {
  archivedAt?: string;
  archiveId?: string;
  createdAt: string;
  matchedSnippet: string;
  messageId: string;
  profileId: string;
  role: string;
  sessionId: string;
  sessionTitle: string | null;
}

export interface StoredConversationMessageItem {
  createdAt: string;
  id: string;
  role: string;
  seq: number;
  text: string;
}
