import type { ToolArtifactPublisher } from "./artifact-publication";
import type { LoadAttachmentBytes } from "./attachments/types";
import type {
  CapabilityBindingV1,
  CapabilityClaimSource,
  CapabilityConfigV1,
  CapabilityRuntimeAvailability,
  CapabilitySupportStatus,
  ProviderCapabilityClaims,
  ProviderCapabilityConstraints,
  ProviderCapabilityOverridePatch,
} from "./provider-capabilities";
import type { RetryPolicy } from "./tools/execution-contract";

export type AutomationTrigger =
  | { type: "manual" }
  | { type: "schedule"; cron: string; timezone?: string }
  | { type: "runAt"; at: string; timezone?: string };

export interface AutomationStep {
  id: string;
  input: Record<string, unknown>;
  tool: string;
}

export type AutomationDeliveryChannel =
  | "telegram"
  | "whatsapp"
  | "email"
  | "discord";

export type AutomationDeliveryNotifyOn = "success" | "failure" | "both";

export interface AutomationDelivery {
  channel: AutomationDeliveryChannel;
  /** Optional Discord channel snowflake; defaults to DMs for all paired users. */
  channelId?: string;
  /** Optional Telegram chat override; defaults to all paired users. */
  chatId?: number;
  notifyOn?: AutomationDeliveryNotifyOn;
  /** Required when channel is email. */
  to?: string;
}

export interface AutomationDefinition {
  delivery?: AutomationDelivery;
  description: string;
  id: string;
  name: string;
  prompt: string;
  steps: AutomationStep[];
  trigger: AutomationTrigger;
  version: number;
}

export interface StoredAutomation extends AutomationDefinition {
  createdAt: string;
  /** Canonical user that owns scheduled/cron fires. Fail closed when missing. */
  createdByUserId?: string | null;
  enabled: boolean;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  orgId?: string | null;
  profileId: string;
  updatedAt: string;
}

export type AutomationRunStatus = "running" | "completed" | "failed";

export type AutomationDeliveryStatus = "sent" | "failed" | "skipped";

export interface AutomationRunRecord {
  automationId: string;
  completedAt: string | null;
  deliveryError?: string | null;
  deliveryStatus?: AutomationDeliveryStatus | null;
  error: string | null;
  id: string;
  output: string | null;
  /** Present when the API resolves read state for the current user. */
  read?: boolean;
  startedAt: string;
  status: AutomationRunStatus;
}

export interface AutomationUnreadSummary {
  byAutomationId: Record<string, number>;
  totalUnread: number;
}

export type AgentChannel =
  | "web"
  | "cli"
  | "telegram"
  | "whatsapp"
  | "discord"
  | "automation"
  | "task"
  | "subagent";

export const ATLAS_API_VERSION = 1;

export interface HealthResponse {
  apiVersion: typeof ATLAS_API_VERSION;
  /**
   * Whether Atlas can reach the Composio API with the saved key.
   * Probed only on `GET /v1/system/status` (`server.composioAvailable`).
   * `GET /health` always returns `false` so liveness stays local and fast.
   */
  composioAvailable: boolean;
  /** A Composio project API key is saved on this server. */
  composioConfigured: boolean;
  ok: true;
  providerConfigured: boolean;
  userConfigured: boolean;
}

export interface AutomationSchedule {
  /** Recurring cron trigger — mutually exclusive with runAt. */
  cron?: string;
  id: string;
  orgId: string;
  profileId: string;
  /** One-shot ISO-8601 datetime — mutually exclusive with cron. */
  runAt?: string;
  timezone: string | null;
}

export interface AutomationWorkerStatus {
  activeRuns: number;
  ok: boolean;
  process?: WorkerProcessInfo;
  providerConfigured: boolean;
  running: boolean;
  scheduledJobs: number;
}

export interface TaskWorkerStatus {
  activeRuns: number;
  ok: boolean;
  providerConfigured: boolean;
}

export interface WorkerProcessInfo {
  cpuPercent: number | null;
  managed: boolean;
  memoryMb: number | null;
  status: "online" | "stopped" | "errored" | null;
  uptimeSeconds: number | null;
}

export interface TelegramWorkerStatus {
  configured: boolean;
  ok: boolean;
  paired: boolean;
  process?: WorkerProcessInfo;
  running: boolean;
}

export interface DiscordWorkerStatus {
  configured: boolean;
  connected: boolean;
  ok: boolean;
  paired: boolean;
  process?: WorkerProcessInfo;
  running: boolean;
}

export interface WhatsAppWorkerStatus {
  configured: boolean;
  connected: boolean;
  devicePairingCode: string | null;
  ok: boolean;
  paired: boolean;
  process?: WorkerProcessInfo;
  qrCode: string | null;
  running: boolean;
}

export interface WorkerLogsResponse {
  stderr: string;
  stdout: string;
  worker?: string;
}

export type LlmUsageReportScope = "platform" | "workspace" | "user";
/** Product-surface filter, including rows recorded before attribution existed. */
export type LlmUsageChannelFilter = AgentChannel | "unknown";
export type LlmUsageReportGroupBy =
  | "workspace"
  | "user"
  | "profile"
  | "channel"
  | "provider"
  | "model"
  | "credential"
  | "capability"
  | "auth";

/** Credential path that served a request: host subscription login or API key. */
export type LlmUsageAuthKind = "subscription" | "api";

export interface LlmUsageReportRow {
  /**
   * Present for provider/credential/auth groupings: whether the rows were
   * served by a subscription login or an API-key credential.
   */
  authKind?: LlmUsageAuthKind;
  estimatedCostUsd: number;
  inputTokens: number;
  /** Raw grouping key (org id, user id, provider type, model id, …). */
  key: string;
  /** Human-friendly label (workspace name, user name/email, else the key). */
  label: string;
  outputTokens: number;
  requestCount: number;
  totalTokens: number;
}

export interface LlmUsageReportResponse {
  /** Optional product-surface filter applied to the report. */
  channel: LlmUsageChannelFilter | null;
  from: string | null;
  groupBy: LlmUsageReportGroupBy;
  rows: LlmUsageReportRow[];
  /** Data scope granted to the caller by RBAC. */
  scope: LlmUsageReportScope;
  to: string | null;
}

export interface OrgUsageBudgetResponse {
  /** Fraction of the budget used (0..1+), or null when no budget. */
  fractionUsed: number | null;
  /** `YYYY-MM` the spend is measured over. */
  month: string;
  /** Monthly USD limit, or null when no budget is set. */
  monthlyLimitUsd: number | null;
  /** Estimated spend so far this month (USD). */
  monthToDateUsd: number;
  overBudget: boolean;
}

/** Outer provider invocations; native runtimes may make additional internal requests. */
export interface LlmUsageProvenance {
  /** Every observed invocation supplied counters; not a claim of account billing. */
  allInvocationsReported: boolean;
  estimatedInvocations: number;
  reportedInvocations: number;
  /** Legacy rows or direct callers without an explicit usage classification. */
  unclassifiedInvocations: number;
  unknownInvocations: number;
}

export interface LlmUsageStats {
  estimatedCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** Numeric token/cost totals are recorded subtotals when usage is incomplete. */
  provenance?: LlmUsageProvenance;
  requestCount: number;
  totalTokens: number;
  trackedSince: string;
}

export interface LlmUsageModelStats extends LlmUsageStats {
  modelId: string;
}

export interface LlmUsageStatus extends LlmUsageStats {
  costEstimated: boolean;
  currentModel: string | null;
  displayName: string | null;
  models: LlmUsageModelStats[];
  provider: ProviderName | null;
  providerConfigured: boolean;
}

export interface McpStatus {
  assignedProfileCount: number;
  connectedCount: number;
  serverCount: number;
}

/**
 * Bytes an optimiser removed from tool results before they entered the
 * conversation. Not tokens and not cost: see the route that serves it for why
 * converting these to either would be a fabrication.
 */
export interface TokenOptimizationResponse {
  /**
   * Two arms. `optimized` is what an optimiser shortened; `control` is what went
   * in untouched. One arm alone is not a comparison, it is a restatement that
   * the feature was on.
   */
  arms: {
    control: TokenOptimizationArm;
    optimized: TokenOptimizationArm;
  };
  byTool: Array<{
    bytesIn: number;
    bytesOut: number;
    calls: number;
    tool: string;
  }>;
  /** One entry per day in the window, oldest first, zero-filled. */
  days: Array<{
    bytesIn: number;
    bytesRemoved: number;
    day: string;
  }>;
  /**
   * Provider input tokens per turn, split by arm. The only tokens here; every
   * other figure is bytes. Observational rather than randomised, so a workload
   * difference between the arms is a confound, not a result.
   */
  inputTokens: {
    control: TokenOptimizationTurnArm;
    optimized: TokenOptimizationTurnArm;
  };
  optimizers: Array<{
    enabled: boolean;
    id: string;
    /** Whether the binary is reachable on this host. Enabled without installed
     * is the case an operator has to be told about, because the optimiser fails
     * open and would otherwise look merely idle. */
    installed: boolean;
    tools: string[];
  }>;
  totals: {
    bytesIn: number;
    bytesRemoved: number;
    calls: number;
  };
  trackedSince: string | null;
  windowDays: number;
}

export interface TokenOptimizationTurnArm {
  arm: string;
  /** Turns whose token count came from an estimate, not the provider. */
  estimatedTurns: number;
  inputTokens: number;
  inputTokensPerTurn: number;
  turns: number;
}

export interface TokenOptimizationArm {
  arm: string;
  bytesIn: number;
  bytesOut: number;
  calls: number;
}

export interface SystemStatusResponse {
  automationWorker: AutomationWorkerStatus;
  checkedAt: string;
  discordWorker: DiscordWorkerStatus;
  llmUsage: LlmUsageStatus;
  mcp: McpStatus;
  server: HealthResponse;
  taskWorker: TaskWorkerStatus;
  telegramWorker: TelegramWorkerStatus;
  whatsappWorker: WhatsAppWorkerStatus;
}

export interface DataExportSkippedItem {
  path: string;
  reason: string;
}

export interface DataExportManifest {
  apiVersion: typeof ATLAS_API_VERSION;
  createdAt: string;
  fileCount: number;
  kind: "atlas-export";
  skipped: DataExportSkippedItem[];
  sourceRootName: string;
  topLevelPaths: string[];
  totalBytes: number;
  version: number;
}

export interface DataImportPreviewResponse {
  archiveFileCount: number;
  archiveTotalBytes: number;
  manifest: DataExportManifest;
  topLevelPaths: string[];
  willReplaceRoot: boolean;
}

export interface RestoreDataImportRequest {
  confirm: boolean;
  data: string;
}

export interface PreviewDataImportRequest {
  data: string;
}

export interface RestoreDataImportResponse {
  manifest: DataExportManifest;
  restoredFileCount: number;
  restoredRoot: string;
}

export interface SetupRestoreDataImportResponse
  extends RestoreDataImportResponse {
  requiresRestart: boolean;
}

/** A portable snapshot of one non-super profile; user-authored content may be sensitive. */
export interface ProfilePackSkippedItem {
  path: string;
  reason: string;
}

export interface ProfilePackCustomTool {
  description: string;
  handlerConfig: { modulePath: string; parameters?: JsonSchema };
  handlerType: "javascript";
  name: string;
}

export interface ProfilePackComposioToolkitAssignment {
  allowedActions: string[] | null;
  toolkitSlug: string;
}

export interface ProfilePackMeta {
  bundledSkillNames: string[];
  /** Present in current packs so action restrictions can be restored safely. */
  composioToolkitAssignments?: ProfilePackComposioToolkitAssignment[];
  /** Kept for compatibility with legacy packs, which are imported without assignments. */
  composioToolkitSlugs: string[];
  customTools?: ProfilePackCustomTool[];
  mcpServerNames: string[];
  model: string | null;
  name: string;
  profileSkillNames: string[];
  skillsPostTurnReview: boolean | null;
  skillsWriteApproval: boolean | null;
  systemPrompt: string;
  thinkingEffort: ThinkingEffort | null;
  thinkingEnabled: boolean | null;
  toolNames: string[];
}

export interface ProfilePackManifest {
  apiVersion: number | string;
  createdAt: string;
  kind: "atlas-profile-export" | "nakama-profile-export";
  meta: ProfilePackMeta;
  skipped: ProfilePackSkippedItem[];
  sourceProfileId: string;
  topLevelPaths: string[];
  version: number;
}

export interface ProfilePackPreviewResponse {
  archiveFileCount: number;
  archiveTotalBytes: number;
  manifest: ProfilePackManifest;
  plannedName: string;
  skippedAssignments: ProfilePackSkippedItem[];
  topLevelPaths: string[];
}

export interface ProfilePackImportRequest {
  confirm: boolean;
  data: string;
  name?: string;
}

export interface ProfilePackImportResponse {
  manifest: ProfilePackManifest;
  profileId: string;
  skippedAssignments: ProfilePackSkippedItem[];
}

export interface AuthCredentialsRequest {
  email: string;
  password: string;
}

export interface SetupAuthRequest {
  admin: {
    name: string;
    email: string;
    phone?: string;
    password: string;
  };
  organization: {
    name: string;
    slug: string;
  };
  /** Public web app origin (e.g. window.location.origin) for OAuth callbacks. */
  webPublicUrl?: string;
}

export interface UpdateWebPublicUrlRequest {
  webPublicUrl: string;
}

export interface WebPublicUrlSettingsResponse {
  /** Set when ATLAS_WEB_PUBLIC_URL / ATLAS_PUBLIC_URL overrides the saved value. */
  envOverride: string | null;
  webPublicUrl: string | null;
}

export interface AuthUserResponse {
  activeOrgId?: string | null;
  email: string;
  isPlatformAdmin?: boolean;
  name?: string | null;
  orgId?: string | null;
  phone?: string | null;
  /** Present only when the client requested token auth (`X-Atlas-Auth-Mode: token`). */
  sessionToken?: string;
}

export interface UpdateAuthProfileRequest {
  email?: string;
  name?: string | null;
  phone?: string | null;
}

export type OrgRole = "admin" | "member" | "viewer";
export type ChannelType = "telegram" | "whatsapp" | "discord";

export interface OrganizationSummary {
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

export interface CreateOrganizationRequest {
  admin?: {
    name: string;
    email: string;
    phone: string;
  };
  name: string;
  slug: string;
}

export interface UpdateOrganizationRequest {
  name?: string;
  skillsCuratorConsolidation?: boolean;
  skillsPostTurnReview?: boolean;
  skillsWriteApproval?: boolean;
}

export interface ListOrganizationsResponse {
  organizations: OrganizationSummary[];
}

export interface OrganizationResponse {
  organization: OrganizationSummary;
}

export interface OrgInviteCreatedResponse {
  invite: OrgInviteSummary;
  token: string;
}

export interface AddOrgMemberResponse {
  member: OrgMemberSummary;
  temporaryPassword: string | null;
}

export interface CreateOrganizationResponse {
  adminMember?: AddOrgMemberResponse;
  organization: OrganizationSummary;
}

export interface UserOrgSummary extends OrganizationSummary {
  role: OrgRole;
}

export interface ListUserOrgsResponse {
  orgs: UserOrgSummary[];
}

export interface SetActiveOrgRequest {
  orgId: string;
}

export interface OrgMemberSummary {
  createdAt: string;
  email: string;
  name: string | null;
  phone: string | null;
  role: OrgRole;
  userId: string;
}

export interface ListOrgMembersResponse {
  members: OrgMemberSummary[];
}

export interface AddOrgMemberRequest {
  email: string;
  name: string;
  phone?: string;
  role: OrgRole;
}

export interface OrgMemberResponse {
  member: OrgMemberSummary;
}

export interface UpdateOrgMemberRequest {
  name?: string | null;
  phone?: string | null;
  role?: OrgRole;
}

export interface OrgMemoryResponse {
  content: string;
}

export interface UpdateOrgMemoryRequest {
  content: string;
}

export interface AddOrgMemoryFactRequest {
  bullet: string;
  pin?: boolean;
}

export interface OrgMemorySearchRequest {
  query: string;
}

export interface OrgMemorySearchMatchEntry {
  bullet: string;
  date?: string;
  source: string;
  tier?: "pinned" | "recent-log" | "archive";
}

export interface OrgMemorySearchResponse {
  matches: OrgMemorySearchMatchEntry[];
  query: string;
}

export interface ArchiveOrgMemoryRequest {
  entries: string[];
  reason?: string;
}

export interface ArchiveOrgMemoryResponse {
  activeBytes: number;
  archived: number;
  archivePath: string;
}

export interface PinOrgMemoryRequest {
  bullet: string;
}

export interface UnpinOrgMemoryRequest {
  bullet: string;
}

export type OrgMemoryChangeAction =
  | "edit"
  | "approve"
  | "add_fact"
  | "pin"
  | "unpin"
  | "archive"
  | "restore";

export interface OrgMemoryChangeLogEntry {
  action: OrgMemoryChangeAction;
  actorUserId: string | null;
  createdAt: string;
  id: string;
  label: string;
  orgId: string;
  restoredFromId?: string | null;
}

export interface ListOrgMemoryHistoryResponse {
  changes: OrgMemoryChangeLogEntry[];
}

export interface RestoreOrgMemoryHistoryResponse {
  content: string;
}

export interface OrgMemoryHistoryRevisionResponse {
  change: OrgMemoryChangeLogEntry;
  content: string;
}

export type OrgMemoryProposalStatus = "pending" | "approved" | "rejected";

export interface OrgMemoryProposal {
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

export interface ListOrgMemoryProposalsResponse {
  pendingCount: number;
  proposals: OrgMemoryProposal[];
}

export interface ApproveOrgMemoryProposalRequest {
  pin?: boolean;
}

export interface OrgMemoryProposalResponse {
  content?: string;
  proposal: OrgMemoryProposal;
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

export interface SkillConsolidationRef {
  id: string;
  name: string;
  sha256: string;
}

export interface SkillConsolidationPayload {
  losers: SkillConsolidationRef[];
  winner: SkillConsolidationRef;
}

export interface SkillProposal {
  action: SkillProposalAction;
  consolidation?: SkillConsolidationPayload | null;
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
  warnings?: string[];
}

export interface ListSkillProposalsResponse {
  pendingCount: number;
  proposals: SkillProposal[];
}

export interface SkillProposalResponse {
  proposal: SkillProposal;
}

export type SkillCuratorRunStatus = "completed" | "disabled" | "in_flight";

export interface SkillCuratorRunResult {
  considered: number;
  finishedAt: string;
  orgId: string;
  profileIds: string[];
  skippedAutomationOrTask: number;
  skippedGeneration: number;
  skippedInvalid: number;
  staged: number;
  startedAt: string;
  status: SkillCuratorRunStatus;
  trigger: "manual" | "scheduled";
}

export interface SkillCuratorStatusResponse {
  enabled: boolean;
  lastRunAt: string | null;
  latest: SkillCuratorRunResult | null;
}

export interface SkillCuratorScheduleOrg {
  id: string;
  lastRunAt: string | null;
}

export interface ListSkillCuratorScheduleOrgsResponse {
  orgs: SkillCuratorScheduleOrg[];
}

export interface SkillCuratorDueRunResponse {
  result: SkillCuratorRunResult | null;
}

export type SkillSuggestionStatus = "pending" | "applied";
export type SkillSuggestionAction = "create" | "patch";
export type SkillSuggestionSource = "post_turn_review";

export interface SkillSuggestion {
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
  warnings?: string[];
}

export interface ListSkillSuggestionsResponse {
  suggestions: SkillSuggestion[];
}

export type ApplySkillSuggestionOutcome =
  | "applied"
  | "already_applied"
  | "staged_as_proposal";

export interface ApplySkillSuggestionResponse {
  outcome: ApplySkillSuggestionOutcome;
  proposalId?: string;
  suggestion: SkillSuggestion;
}

export interface InviteOrgMemberRequest {
  email: string;
  role: OrgRole;
}

export interface OrgInviteSummary {
  createdAt: string;
  email: string;
  expiresAt: string;
  id: string;
  orgId: string;
  role: OrgRole;
}

export interface AcceptOrgInviteRequest {
  password?: string;
  token: string;
}

export interface AcceptOrgInviteResponse {
  email: string;
  orgId: string;
  role: OrgRole;
  /** Present only when the client requested token auth (`X-Atlas-Auth-Mode: token`). */
  sessionToken?: string;
}

export interface PreviewOrgInviteResponse {
  email: string;
  expiresAt: string;
  orgName: string;
  role: OrgRole;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

export interface ChannelOrgMappingSummary {
  channel: ChannelType;
  channelUserId: string;
  createdAt: string;
  orgId: string;
  userId: string;
}

export interface CreateChannelOrgMappingRequest {
  channel: ChannelType;
  channelUserId: string;
  userId: string;
}

export interface ListChannelOrgMappingsResponse {
  mappings: ChannelOrgMappingSummary[];
}

export interface ExternalPrincipalInput {
  channelAddressed?: boolean;
  channelChatId?: string;
  channelIsGroup?: boolean;
  channelThreadId?: string;
  /** Trusted channel-native aliases observed for the same sender. */
  channelUserAliases?: string[];
  channelUserId: string;
}

export interface CreateSessionRequest {
  channel: AgentChannel;
  externalPrincipal?: ExternalPrincipalInput;
  model?: string;
  profileId?: string;
}

export interface CreateSessionResponse {
  sessionId: string;
}

export interface UpdateSessionRequest {
  model: string | null;
}

export interface BranchSessionRequest {
  messageIndex: number;
}

export interface BranchSessionResponse {
  sessionId: string;
}

export type AgentTodoStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled";

export interface AgentTodo {
  content: string;
  id: string;
  status: AgentTodoStatus;
}

export interface AgentQuestionChoice {
  id: string;
  label: string;
}

export interface AgentQuestionItem {
  allowCustomAnswer: boolean;
  choices: AgentQuestionChoice[];
  id: string;
  placeholder?: string;
  prompt: string;
  selectionMode?: "single" | "multiple";
}

export interface AgentQuestionnaire {
  id: string;
  questions: AgentQuestionItem[];
  title: string;
}

export interface AgentQuestionAnswer {
  answer: string;
  prompt: string;
  questionId: string;
}

export interface SessionMessageMeta {
  createdAt: string;
  id: string;
  seq: number;
}

/** How full the model context window is for the current chat session. */
export type ChatContextUsageSource = "provider" | "estimate";

export interface ChatContextUsage {
  /**
   * Bytes an optimiser kept out of this session's context so far. Absent until
   * something is actually removed, so the UI reports a measurement rather than
   * announcing a feature. Bytes, not tokens: the label must carry a byte unit.
   */
  bytesKeptOut?: number;
  /** Everything the handled tools produced this session, the denominator for
   * the percentage. Present whenever bytesKeptOut is. */
  bytesProduced?: number;
  contextWindow: number;
  source: ChatContextUsageSource;
  /** Atlas's compaction budget, or the provider's already-effective context window. */
  usableContextTokens: number;
  usedTokens: number;
}

export interface SessionMessagesResponse {
  canUpdateModel: boolean;
  channel: AgentChannel;
  contextUsage?: ChatContextUsage | null;
  messageMeta: SessionMessageMeta[];
  messages: ChatMessage[];
  model: string | null;
  questionnaire: AgentQuestionnaire | null;
  todos: AgentTodo[];
}

export interface SessionStatusResponse {
  active: boolean;
  cancelling?: boolean;
  startedAt?: string;
  turnId?: string;
}

export interface CancelSessionTurnRequest {
  expectedTurnId: string;
}

export interface CancelSessionTurnResponse extends SessionStatusResponse {
  cancelled: boolean;
}

export interface SessionSummary {
  channel: AgentChannel;
  createdAt: string;
  id: string;
  messageCount: number;
  preview: string | null;
  profileId: string;
  title: string | null;
  updatedAt: string;
}

export interface ListSessionsResponse {
  sessions: SessionSummary[];
}

export interface CompactSessionRequest {
  force?: boolean;
}

export interface CompactionResponse {
  action: "none" | "pruned" | "summarized";
  messagesAfter: number;
  messagesBefore: number;
  prunedTokens?: number;
}

/** Original context retained for retrieval after a successful Atlas compaction. */
export interface CompactedHistoryArchive {
  createdAt: string;
  id: string;
  messages: ChatMessage[];
}

export type MessageContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string; description?: string }
  | { type: "document"; filename: string; mediaType: string; data: string }
  | {
      type: "image_ref";
      attachmentId: string;
      mediaType: string;
      size: number;
      description?: string;
    }
  | {
      type: "document_ref";
      attachmentId: string;
      filename: string;
      mediaType: string;
      size: number;
    };

export interface ImageAttachment {
  data: string;
  mediaType: string;
}

export interface DocumentAttachment {
  data: string;
  filename: string;
  mediaType: string;
}

export type ExecutionPolicy =
  | "auto"
  | "fast"
  | "standard"
  | "research"
  | "agent";

export interface ActivityEvent {
  completedAt?: string;
  detail?: string;
  id: string;
  label: string;
  startedAt?: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  type:
    | "search"
    | "read"
    | "analyze"
    | "create"
    | "browse"
    | "retrieve"
    | "connect"
    | "verify"
    | "write";
}

export interface Citation {
  endOffset?: number;
  evidenceIds: string[];
  id: string;
  messageId?: string;
  sourceId: string;
  startOffset?: number;
}

export interface SourceItem {
  domain?: string;
  id: string;
  publishedDate?: string;
  publisher?: string;
  score?: number;
  snippet?: string;
  title: string;
  type?: "primary" | "secondary" | "community";
  url: string;
}

export interface ResearchSession {
  citationIds: string[];
  claims: unknown[];
  createdAt?: string;
  evidenceIds: string[];
  id: string;
  parentRevisionId?: string;
  question: string;
  revision?: number;
  sourceIds: string[];
  updatedAt: string;
}

export interface RiskAssessment {
  actionType:
    | "read"
    | "search"
    | "navigate"
    | "local_write"
    | "external_message"
    | "delete"
    | "purchase"
    | "submit_form"
    | "account_change";
  consequenceSummary: string;
  details?: Record<string, unknown>;
  requiresApproval: boolean;
  riskLevel: "low" | "medium" | "high";
  title: string;
}

export interface ApprovalRequest {
  consequenceSummary: string;
  createdAt: string;
  details?: Record<string, unknown>;
  id: string;
  runId?: string;
  status: "pending" | "approved" | "rejected" | "denied" | "expired";
  stepIndex?: number;
  title: string;
  tool: string;
  toolCallId: string;
}

export interface DecideApprovalRequest {
  decision: "approved" | "denied";
}

export interface DecideApprovalResponse {
  approval: ApprovalRequest;
  resumed: boolean;
}

export interface SendMessageInput {
  /** Browser origin for OAuth callbacks (e.g. window.location.origin). */
  clientOrigin?: string;
  documents?: DocumentAttachment[];
  /** Native control answers are consumed only while this exact questionnaire is current. */
  expectedQuestionnaire?: AgentQuestionnaire;
  images?: ImageAttachment[];
  message: string;
  policy?: ExecutionPolicy;
  /** Ask the model for follow-up question suggestions after the reply. */
  relatedQuestions?: boolean;
}

export interface SendMessageRequest {
  clientOrigin?: string;
  documents?: DocumentAttachment[];
  expectedQuestionnaire?: AgentQuestionnaire;
  externalPrincipal?: ExternalPrincipalInput;
  images?: ImageAttachment[];
  message: string;
  policy?: ExecutionPolicy;
  relatedQuestions?: boolean;
  stream?: boolean;
}

export interface SendMessageResponse {
  contextUsage?: ChatContextUsage;
  reply: string;
}

export type StreamEvent =
  | { type: "chunk"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "policy_resolved"; policy: ExecutionPolicy }
  | { type: "activity_start"; activity: ActivityEvent }
  | { type: "activity_update"; activity: ActivityEvent }
  | { type: "activity_complete"; activity: ActivityEvent }
  | { type: "citation_created"; citation: Citation; source?: SourceItem }
  | {
      type: "sources_updated";
      sources: SourceItem[];
      citedCount: number;
      reviewedCount: number;
    }
  | { type: "artifact_created"; artifact: import("./artifact-types").Artifact }
  | { type: "approval_requested"; approval: ApprovalRequest }
  | {
      type: "channel_action_requested";
      request: import("./channel-native-actions").ChannelNativeActionRequest;
    }
  | {
      type: "approval_resolved";
      approvalId: string;
      status: "approved" | "rejected";
    }
  | { type: "memory_saved"; summary: string }
  | {
      type: "tool_input_delta";
      toolCallId: string;
      tool: string;
      delta: string;
      accumulatedArguments?: string;
    }
  | {
      type: "tool_start";
      toolCallId: string;
      tool: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_end";
      toolCallId: string;
      tool: string;
      result: unknown;
    }
  | { type: "todos_updated"; todos: AgentTodo[] }
  | { type: "questionnaire_updated"; questionnaire: AgentQuestionnaire | null }
  | {
      type: "sub_agent_activity";
      parentToolCallId: string;
      label: string;
    }
  | { type: "related_questions"; questions: string[] }
  | { type: "done"; reply: string; contextUsage?: ChatContextUsage }
  | { type: "error"; error: string };

export interface DraftAutomationRequest {
  channel: AgentChannel;
  prompt: string;
}

export interface DraftAutomationResponse {
  automation: AutomationDefinition;
}

export interface ListAutomationsResponse {
  automations: StoredAutomation[];
  unread?: AutomationUnreadSummary;
}

export interface AutomationResponse {
  automation: StoredAutomation;
}

export interface CreateAutomationRequest {
  delivery?: AutomationDelivery;
  description: string;
  enabled?: boolean;
  name: string;
  profileId?: string;
  prompt: string;
  trigger: AutomationTrigger;
}

export interface UpdateAutomationRequest {
  delivery?: AutomationDelivery | null;
  description?: string;
  enabled?: boolean;
  name?: string;
  profileId?: string;
  prompt?: string;
  trigger?: AutomationTrigger;
}

export interface RunAutomationResponse {
  run: AutomationRunRecord;
}

export interface ListAutomationRunsResponse {
  runs: AutomationRunRecord[];
}

export interface MarkAutomationRunsReadResponse {
  readThroughAt: string;
}

export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "done",
  "failed",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface StoredTask {
  createdAt: string;
  createdByUserId: string | null;
  description: string;
  id: string;
  orgId: string | null;
  position: number;
  profileId: string;
  prompt: string;
  sessionId: string | null;
  status: TaskStatus;
  title: string;
  updatedAt: string;
}

export interface DraftTaskPromptRequest {
  description?: string;
  title: string;
}

export interface DraftTaskPromptResponse {
  prompt: string;
}

export interface CreateTaskRequest {
  description?: string;
  profileId?: string;
  prompt: string;
  status?: TaskStatus;
  title: string;
}

export interface UpdateTaskRequest {
  description?: string;
  position?: number;
  profileId?: string;
  prompt?: string;
  status?: TaskStatus;
  title?: string;
}

export interface ListTasksResponse {
  tasks: StoredTask[];
}

export interface TaskResponse {
  task: StoredTask;
}

export type TaskRunStatus = "running" | "completed" | "failed";

export interface TaskRunRecord {
  completedAt: string | null;
  error: string | null;
  id: string;
  output: string | null;
  startedAt: string;
  status: TaskRunStatus;
  taskId: string;
}

export interface RunTaskResponse {
  run: TaskRunRecord;
}

export interface ListTaskRunsResponse {
  runs: TaskRunRecord[];
}

export interface TaskMessagesResponse {
  messages: ChatMessage[];
  sessionId: string;
}

export interface TimezoneSettingsResponse {
  timezone: string;
}

export interface UpdateTimezoneRequest {
  timezone: string;
}

/**
 * Effort level sent to the provider's reasoning/thinking API.
 * Kept as `string` so each provider can declare its own valid values
 * (e.g. "low"/"medium"/"high" for OpenAI/OpenRouter/Fireworks,
 *  "low"/"medium"/"xhigh" for Anthropic & token-router,
 *  "low"/"high"/"max" for DeepSeek, etc.).
 * Use the model's `reasoningEffortValues` array (from the catalog) to
 * build the UI options list and validate user input.
 */
export type ThinkingEffort = string;

export interface ThinkingSettings {
  effort: ThinkingEffort;
  enabled: boolean;
}

export interface ThinkingSettingsResponse {
  thinking: ThinkingSettings;
}

export interface UpdateThinkingRequest {
  effort?: ThinkingEffort;
  enabled: boolean;
}

export interface CapabilityCatalogEntry {
  description: string;
  id: string;
  label: string;
  routable: boolean;
}

export interface PublicProviderCapability {
  capabilityId: string;
  implementationAvailable: boolean;
  nativeStatus: CapabilitySupportStatus;
}

export interface PublicProviderModel {
  capabilities: ProviderCapabilityClaims;
  id: string;
  name?: string;
}

export interface PublicProviderType {
  capabilities: PublicProviderCapability[];
  displayName: string;
  id: string;
  models: PublicProviderModel[];
}

export interface CapabilityCatalogResponse {
  capabilities: CapabilityCatalogEntry[];
  providers: PublicProviderType[];
  schemaVersion: number;
}

export interface CapabilityMappingsResponse {
  config: CapabilityConfigV1;
}

export interface CapabilityTargetOption {
  capabilityId: string;
  effective: EffectiveCapabilitySummary;
  modelId: string;
  modelName: string;
  providerId: string;
  providerLabel: string;
  providerType: ProviderName;
}

export interface CapabilityOptionsResponse {
  options: CapabilityTargetOption[];
  schemaVersion: number;
}

export interface UpdateCapabilityMappingRequest {
  binding: CapabilityBindingV1;
}

export interface UpdateCapabilityMappingResponse {
  capabilityId: string;
  config: CapabilityConfigV1;
}

export interface EffectiveCapabilitySummary {
  availability: CapabilityRuntimeAvailability;
  capabilityId: string;
  constraints?: ProviderCapabilityConstraints;
  reasons: string[];
  selectable: boolean;
  source: CapabilityClaimSource;
  status: CapabilitySupportStatus;
  verified: boolean;
}

export interface VisionSettings {
  model: string | null;
}

export interface VisionSettingsResponse {
  vision: VisionSettings;
}

export interface UpdateVisionRequest {
  model: string | null;
}

export interface TranscriptionSettings {
  model: string | null;
}

export interface TranscriptionSettingsResponse {
  transcription: TranscriptionSettings;
}

export interface UpdateTranscriptionRequest {
  model: string | null;
}

export interface TranscribeAudioRequest {
  data: string;
  filename?: string;
  mediaType: string;
  /** Session used to resolve the canonical actor/profile/channel for usage. */
  sessionId?: string;
}

export interface TranscribeAudioResponse {
  text: string;
}

export interface ImageGenerationSettings {
  model: string | null;
}

export interface ImageGenerationSettingsResponse {
  imageGeneration: ImageGenerationSettings;
}

export interface UpdateImageGenerationRequest {
  model: string | null;
}

export interface GenerateImageRequest {
  prompt: string;
  /** Session used to resolve the canonical actor/profile/channel for usage. */
  sessionId?: string;
  size?: string;
}

export interface GenerateImageResponse {
  data: string;
  mediaType: string;
  model: string;
  revisedPrompt?: string;
  size: string;
  sizeBytes: number;
}

export interface RotateLocalAuthTokenResponse {
  token: string;
}

export type ChannelAccessMode = "open" | "allowlist" | "denylist" | "pairing";

export interface TelegramSettingsResponse {
  accessMode: ChannelAccessMode;
  allowedUserIds: number[];
  blockedUserIds: number[];
  botTokenMasked: string | null;
  configured: boolean;
  handshakeCode: string | null;
  pairedUserIds: number[];
  profileId: string;
}

export interface UpdateTelegramSettingsRequest {
  accessMode?: ChannelAccessMode;
  allowedUserIds?: string;
  blockedUserIds?: string;
  botToken?: string;
  profileId?: string;
}

export interface DiscordSettingsResponse {
  accessMode: ChannelAccessMode;
  allowedUserIds: string[];
  blockedUserIds: string[];
  botTokenMasked: string | null;
  configured: boolean;
  handshakeCode: string | null;
  inviteUrl: string | null;
  pairedUserIds: string[];
  profileId: string;
}

export interface UpdateDiscordSettingsRequest {
  accessMode?: ChannelAccessMode;
  allowedUserIds?: string;
  blockedUserIds?: string;
  botToken?: string;
  profileId?: string;
}

export interface ComposioSettingsResponse {
  apiKeyMasked: string | null;
  composioReachable: boolean;
  configured: boolean;
}

export interface UpdateComposioSettingsRequest {
  apiKey?: string;
}

export interface ErrorTrackingSettingsResponse {
  configurationSource: "environment" | "settings" | null;
  configured: boolean;
  disabledByDoNotTrack: boolean;
  dsnMasked: string | null;
}

export interface UpdateErrorTrackingSettingsRequest {
  /** Empty clears the saved DSN; deployment environment overrides still win. */
  dsn?: string;
}

export interface SendErrorTrackingTestResponse {
  delivered: boolean;
}

export type NotificationDestinationChannel = "telegram";

export type NotificationWebhookLevel = "info" | "success" | "warning" | "error";

export interface TelegramNotificationDestinationConfig {
  chatId: number;
  topicId?: number | null;
}

export interface NotificationDestinationSummary {
  channel: NotificationDestinationChannel;
  createdAt: string;
  id: string;
  name: string;
  telegram: TelegramNotificationDestinationConfig;
  updatedAt: string;
  webhookPath: string;
}

export interface NotificationDestinationWithSecret {
  apiKey: string;
  destination: NotificationDestinationSummary;
}

export interface ListNotificationDestinationsResponse {
  destinations: NotificationDestinationSummary[];
}

export interface CreateNotificationDestinationRequest {
  channel: NotificationDestinationChannel;
  name: string;
  telegram: TelegramNotificationDestinationConfig;
}

export interface UpdateNotificationDestinationRequest {
  name: string;
  telegram: TelegramNotificationDestinationConfig;
}

export interface RegenerateNotificationDestinationKeyResponse {
  apiKey: string;
  destination: NotificationDestinationSummary;
}

export interface NotificationWebhookRequest {
  body: string;
  level?: NotificationWebhookLevel;
  title?: string;
}

export interface EmailSettingsResponse {
  configured: boolean;
  from: string | null;
  fromName: string | null;
  imapHost: string | null;
  imapPort: number | null;
  imapSecure: boolean | null;
  passwordMasked: string | null;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean | null;
  username: string | null;
}

export interface UpdateEmailSettingsRequest {
  from?: string;
  fromName?: string;
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  password?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  username?: string;
}

export interface SendEmailTestRequest {
  to?: string;
}

export interface SendEmailTestResponse {
  messageId: string;
  ok: true;
  to: string;
}

export type CodingAgentProviderPassthroughSummary = {
  active: boolean;
  configured: boolean;
  compatible: boolean;
  providerLabel: string | null;
  model: string | null;
  message?: string | null;
};

export interface CodingHarnessLoginCommand {
  command: string;
  name: string;
}

export interface CodingHarnessSettingsResponse {
  loginCommands: CodingHarnessLoginCommand[];
  providerPassthroughEnabled: boolean;
}

export interface UpdateCodingHarnessSettingsRequest {
  providerPassthroughEnabled: boolean;
}

export interface AgentBrowserStatusResponse {
  installCommand: string;
  installed: boolean;
  nextStep: "install" | null;
  ready: boolean;
  statusMessage: string | null;
  version: string | null;
}

export type AgentBrowserInstallEvent =
  | {
      type: "progress";
      message: string;
    }
  | {
      type: "done";
      status: AgentBrowserStatusResponse;
    }
  | {
      type: "error";
      error: string;
    };

export interface WhatsAppSettingsResponse {
  accessMode: ChannelAccessMode;
  allowedNumbers: string[];
  blockedNumbers: string[];
  configured: boolean;
  pairedJid: string | null;
  pairingCode: string | null;
  phoneNumberMasked: string | null;
  profileId: string;
}

export interface WhatsAppPairingStatusResponse {
  devicePairingCode: string | null;
  qrCode: string | null;
}

export interface UpdateWhatsAppSettingsRequest {
  accessMode?: ChannelAccessMode;
  allowedNumbers?: string[] | string;
  blockedNumbers?: string[] | string;
  phoneNumber?: string;
  profileId?: string;
}

export interface TimezoneCatalogEntry {
  abbreviation: string;
  /** Extra searchable city names (e.g. San Francisco → America/Los_Angeles). */
  aliases?: string[];
  city: string;
  countryCode: string;
  countryName: string;
  id: string;
  label: string;
  offset: string;
  tzName: string;
}

export interface TimezoneCatalogGroup {
  countryCode: string;
  countryName: string;
  timezones: TimezoneCatalogEntry[];
}

export interface ListTimezonesResponse {
  groups: TimezoneCatalogGroup[];
}

export interface ProfileRef {
  id: string;
  name: string;
}

export interface ApiErrorResponse {
  duplicate?: KnowledgeBaseDuplicateConflict;
  error: string;
  profiles?: ProfileRef[];
}

export interface CustomModelEntry {
  capabilities?: ProviderCapabilityClaims;
  /** Provider-reported or explicitly configured context capacity; omitted when unknown. */
  contextWindow?: number;
  default?: boolean;
  /** Runtime-advertised default reasoning effort for this model. */
  defaultReasoningEffort?: string;
  id: string;
  inputPerMillionUsd?: number;
  /** Provider-reported or explicitly configured maximum output; omitted when unknown. */
  maxOutputTokens?: number;
  name?: string;
  outputPerMillionUsd?: number;
  /**
   * Ordered list of effort values this model/provider accepts for reasoning.
   * Drives the UI dropdown dynamically. Omitted means unknown; [] means no
   * configurable effort levels. Never infer values from a model name.
   * Examples:
   *   Anthropic claude:  ["low", "medium", "xhigh"]
   *   DeepSeek:          ["low", "high", "max"]
   *   Token-router:      ["low", "medium", "xhigh"]
   */
  reasoningEffortValues?: string[];
  supportsThinking?: boolean;
  supportsVision?: boolean;
}

export interface ProviderModelOption {
  capabilities?: ProviderCapabilityClaims;
  contextWindow?: number;
  default?: boolean;
  /** Runtime-advertised default reasoning effort for this model. */
  defaultReasoningEffort?: string;
  id: string;
  inputPerMillionUsd?: number;
  maxOutputTokens?: number;
  name: string;
  outputPerMillionUsd?: number;
  provider: ProviderName;
  providerId?: string;
  providerLabel?: string;
  /** Propagated from CustomModelEntry or static catalog — drives the UI effort picker. */
  reasoningEffortValues?: string[];
  supportsThinking?: boolean;
  supportsVision?: boolean;
}

export interface ProviderInstanceSummary {
  baseUrl?: string | null;
  capabilityOverrides?: ProviderCapabilityClaims;
  createdAt: string;
  customModels?: CustomModelEntry[];
  hasApiKey: boolean;
  hostMode?: OllamaHostMode | null;
  id: string;
  label: string;
  modelCount: number;
  type: ProviderName;
  wireApi?: WireApi | null;
}

export interface ListProvidersResponse {
  defaultProviderId: string | null;
  providers: ProviderInstanceSummary[];
}

export interface TestProviderResponse {
  message: string;
  ok: true;
}

export type SubscriptionProviderKind = "chatgpt" | "claude";

export type SubscriptionAuthStatus =
  | "not_installed"
  | "not_authenticated"
  | "login_pending"
  | "authenticated"
  | "expired"
  | "error";

export type SubscriptionErrorCode =
  | "subscription_limit_reached"
  | "rate_limited"
  | "authentication_expired"
  | "model_unavailable"
  | "provider_unavailable"
  | "runtime_error";

export type SubscriptionLoginMethod = "browser" | "device" | "cli";

export interface SubscriptionAuthState {
  authenticated: boolean;
  canManage?: boolean;
  email?: string;
  installHint?: string;
  loginCommand?: string;
  message?: string;
  plan?: string;
  provider: SubscriptionProviderKind;
  runtimeVersion?: string | null;
  status: SubscriptionAuthStatus;
}

export interface SubscriptionLoginStartRequest {
  method?: Exclude<SubscriptionLoginMethod, "cli">;
}

export interface SubscriptionLoginStartResponse {
  authUrl?: string;
  instructions: string;
  loginCommand?: string;
  loginId: string;
  method: SubscriptionLoginMethod;
  userCode?: string;
  verificationUrl?: string;
}

export interface SubscriptionLoginStatusResponse {
  account?: SubscriptionAuthState;
  error?: string;
  loginId: string;
  status: "pending" | "completed" | "failed" | "cancelled";
}

export interface SubscriptionModelListResponse {
  models: ProviderModelOption[];
}

interface RuntimeOwnedSubscriptionFields {
  apiKey?: never;
  baseUrl?: never;
  customModels?: never;
  hostMode?: never;
  skipValidation?: never;
  wireApi?: never;
}

interface ConfigurableProviderFields {
  apiKey?: string;
  baseUrl?: string;
  customModels?: CustomModelEntry[];
  hostMode?: OllamaHostMode;
  skipValidation?: boolean;
  wireApi?: WireApi;
}

export type TestProviderRequest =
  | (RuntimeOwnedSubscriptionFields & {
      model?: string;
      type: SubscriptionProviderKind;
    })
  | (ConfigurableProviderFields & {
      model?: string;
      type: Exclude<ProviderName, SubscriptionProviderKind>;
    });

export type CreateProviderRequest =
  | (RuntimeOwnedSubscriptionFields & {
      label?: string;
      model?: string;
      type: SubscriptionProviderKind;
    })
  | (ConfigurableProviderFields & {
      apiKey: string;
      label?: string;
      model?: string;
      type: Exclude<ProviderName, SubscriptionProviderKind>;
    });

export interface CreateProviderResponse {
  defaultProviderId: string;
  initialModel: string;
  provider: ProviderInstanceSummary;
}

export interface UpdateProviderRequest {
  apiKey?: string;
  baseUrl?: string;
  capabilityOverrides?: ProviderCapabilityOverridePatch;
  customModels?: CustomModelEntry[];
  hostMode?: OllamaHostMode;
  label?: string;
  skipValidation?: boolean;
  wireApi?: WireApi;
}

export interface UpdateProviderResponse {
  provider: ProviderInstanceSummary;
}

export interface DeleteProviderResponse {
  defaultProviderId: string | null;
}

export interface ModelsResponse {
  baseUrl?: string | null;
  /** Full static model catalog for provider setup and management UIs. */
  catalog?: ProviderModelOption[];
  currentProviderId: string | null;
  customModels?: CustomModelEntry[];
  displayName: string | null;
  models: ProviderModelOption[];
  provider: ProviderName | null;
  providers: ProviderInstanceSummary[];
}

export interface DiscoverModelsRequest {
  apiKey?: string;
  baseUrl?: string;
  hostMode?: OllamaHostMode;
  /** When set, discovery uses the matching remote fetch path (Ollama includes `/api/tags` fallback). */
  provider?:
    | "anthropic"
    | "cerebras"
    | "deepseek"
    | "gemini"
    | "ollama"
    | "openai"
    | "openai_compatible"
    | "openrouter"
    | "fireworks"
    | "opencode_go"
    | "minimax"
    | "minimax_cn"
    | "xai"
    | "zhipu"
    | "zhipu_cn";
  providerId?: string;
}

export type ConfigureProviderRequest =
  | (RuntimeOwnedSubscriptionFields & {
      displayName?: never;
      model?: string;
      provider: SubscriptionProviderKind;
    })
  | (ConfigurableProviderFields & {
      displayName?: string;
      model?: string;
      provider: Exclude<ProviderName, SubscriptionProviderKind>;
    });

export interface ConfigureProviderResponse {
  currentModel: string;
  displayName: string | null;
  provider: ProviderName;
}

export interface ProfileSummary {
  createdAt: string;
  hasAvatar: boolean;
  id: string;
  isDefault?: boolean;
  isSuper: boolean;
  mcpServerCount: number;
  model: string | null;
  name: string;
  /** null = inherit org default; true/false = force curator consolidation on/off */
  skillsCuratorConsolidation?: boolean | null;
  /** null = inherit org default; true/false = force post-turn review on/off for this profile */
  skillsPostTurnReview?: boolean | null;
  /** null = inherit org default; true/false = force gate on/off for this profile */
  skillsWriteApproval?: boolean | null;
  soulActive: boolean;
  toolCount: number;
  updatedAt: string;
}

export interface ProfileDetail extends ProfileSummary {
  mcpServers: McpServerSummary[];
  skills: SkillSummary[];
  systemPrompt: string;
  tools: ToolSummary[];
}

export interface SkillUsageSummary {
  lastPatchedAt: string | null;
  lastUsedAt: string | null;
  lastViewedAt: string | null;
  patchCount: number;
  useCount: number;
  viewCount: number;
}

export type SkillCreatedBy = "agent" | "human" | "bundled";

export interface SkillSummary {
  createdAt: string;
  createdBy: SkillCreatedBy;
  description: string;
  disableModelInvocation: boolean;
  enabled: boolean;
  hasTool: boolean;
  id: string;
  name: string;
  sourcePath: string;
  updatedAt: string;
  usage?: SkillUsageSummary;
}

export interface SkillDetail extends SkillSummary {
  body: string;
}

export interface ListSkillsResponse {
  skills: SkillSummary[];
}

export interface SkillResponse {
  skill: SkillDetail;
}

export interface AssignSkillRequest {
  skillId: string;
}

export interface CreateSkillRequest {
  body?: string;
  description: string;
  disableModelInvocation?: boolean;
  name: string;
  profileId?: string;
}

export interface InstallSkillRequest {
  profileId: string;
  url: string;
}

export interface PatchSkillRequest {
  body?: string;
  description?: string;
  disableModelInvocation?: boolean;
}

export interface SyncSkillsResponse {
  created: number;
  discovered: number;
  updated: number;
}

export type McpServerStatus = "connected" | "disconnected" | "error";
export type McpTransport = "http" | "stdio";

export interface McpHttpConfig {
  headers?: Record<string, string>;
  url: string;
}

export interface McpStdioConfig {
  args?: string[];
  command: string;
  env?: Record<string, string>;
}

export type McpServerConfig = McpHttpConfig | McpStdioConfig;

export interface CachedMcpToolSummary {
  description: string;
  inputSchema?: unknown;
  name: string;
}

export interface McpServerSummary {
  assignedProfileCount?: number;
  createdAt: string;
  enabled: boolean;
  id: string;
  lastError: string | null;
  name: string;
  status: McpServerStatus;
  toolCount: number;
  transport: McpTransport;
  updatedAt: string;
}

export interface McpServerDetail extends McpServerSummary {
  cachedTools: CachedMcpToolSummary[];
  config: McpServerConfig;
}

export interface ListMcpServersResponse {
  servers: McpServerSummary[];
}

export interface McpServerResponse {
  server: McpServerDetail;
}

export interface CreateMcpServerRequest {
  config: McpServerConfig;
  connect?: boolean;
  enabled?: boolean;
  name: string;
  /** When testing an existing server, merges blank header/env values with stored secrets. */
  serverId?: string;
  transport: McpTransport;
}

export interface UpdateMcpServerRequest {
  config?: McpServerConfig;
  enabled?: boolean;
  name?: string;
  transport?: McpTransport;
}

export interface AssignMcpServerRequest {
  serverId: string;
}

export interface TestMcpServerResponse {
  error?: string;
  ok: boolean;
  toolCount: number;
  tools: CachedMcpToolSummary[];
}

export interface ToolSummary {
  description: string;
  handlerType: string;
  id: string;
  name: string;
}

export interface ToolDetail extends ToolSummary {
  createdAt: string;
  handlerConfig: unknown;
  /** Resolved JSON Schema for javascript tools (module export or handlerConfig). */
  parameters?: JsonSchema;
  updatedAt: string;
}

export interface ToolResponse {
  tool: ToolDetail;
}

export interface ToolSourceResponse {
  content: string;
  language: "javascript" | "typescript";
  path: string;
}

export interface ListProfilesResponse {
  profiles: ProfileSummary[];
}

export interface ProfileResponse {
  profile: ProfileDetail;
}

export interface CreateProfileRequest {
  id?: string;
  isSuper?: boolean;
  model?: string | null;
  name: string;
  soulFiles?: {
    "SOUL.md"?: string;
    "STYLE.md"?: string;
    "INSTRUCTIONS.md"?: string;
    "MEMORY.md"?: string;
  };
  systemPrompt?: string;
}

export interface UpdateProfileRequest {
  model?: string | null;
  name?: string;
  skillsCuratorConsolidation?: boolean | null;
  skillsPostTurnReview?: boolean | null;
  skillsWriteApproval?: boolean | null;
  soulFiles?: {
    "SOUL.md"?: string;
    "STYLE.md"?: string;
    "INSTRUCTIONS.md"?: string;
    "MEMORY.md"?: string;
  };
  systemPrompt?: string;
}

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

export interface ProfileChangeEvent {
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

export interface ListProfileChangeHistoryResponse {
  events: ProfileChangeEvent[];
}

export interface CloneProfileRequest {
  id?: string;
  name?: string;
}

export type CloneProfileResponse = ProfileResponse;

export interface CreateToolRequest {
  description: string;
  handlerConfig?: unknown;
  handlerType?: string;
  name: string;
}

export interface ListToolsResponse {
  tools: ToolDetail[];
}

export interface AssignToolRequest {
  toolId: string;
}

export interface RunToolRequest {
  parameters: Record<string, unknown>;
}

export interface RunToolResponse {
  error?: string;
  ok: boolean;
  result?: unknown;
}

export interface SuggestToolParamsRequest {
  prompt: string;
}

export interface SuggestToolParamsResponse {
  parameters: Record<string, unknown>;
}

import type { SoulFileStatus, SoulStackFiles } from "./soul/types";

export type { SoulFileStatus, SoulStackFiles } from "./soul/types";

export interface SoulStatusResponse {
  active: boolean;
  contents?: SoulStackFiles;
  directory: string;
  files: SoulFileStatus;
  profileId?: string;
}

export interface InitSoulResponse {
  created: string[];
  directory: string;
  profileId?: string;
}

export interface SoulStackResponse {
  directory: string;
  files: SoulStackFiles;
  loaded: string[];
  profileId?: string;
}

export interface UpdateSoulFileRequest {
  content: string;
}

export interface ArtifactFile {
  filename: string;
  formatDetails?: import("./artifact-types").ArtifactFormatDetails;
  mimeType: string;
  parentArtifactId?: string;
  path: string;
  revision?: number;
  rootArtifactId?: string;
  sizeBytes: number;
  updatedAt: string;
}

export type ArtifactCategory =
  | "document"
  | "html"
  | "image"
  | "markdown"
  | "other"
  | "text"
  | "video";

export interface ArtifactFolderTypeStats {
  fileCount: number;
  latestUpdatedAt: string;
}

export interface ArtifactFolderMetadata {
  fileCount: number;
  latestUpdatedAt: string;
  name: string;
  prefix: string;
  typeStats: Partial<Record<ArtifactCategory, ArtifactFolderTypeStats>>;
}

export interface ListArtifactsOptions {
  folder?: string;
  limit?: number;
  offset?: number;
}

export interface ListArtifactsResponse {
  artifacts: ArtifactFile[];
  directory: string;
  folders?: ArtifactFolderMetadata[];
  limit?: number;
  offset?: number;
  profileId: string;
  total: number;
}

export interface DeleteArtifactResponse {
  deleted: boolean;
  filename: string;
  profileId: string;
}

export type EditableArtifactKind = "markdown" | "delimited";

export interface EditableArtifactResponse {
  columnCount?: number;
  content?: string;
  delimiter?: "," | ";" | "\t";
  editable: boolean;
  expectedHash: string;
  filename: string;
  kind: EditableArtifactKind;
  path: string;
  reason?: string;
  rowCount?: number;
  rows?: string[][];
  sizeBytes: number;
  truncated: boolean;
}

export interface UpdateEditableArtifactRequest {
  content?: string;
  expectedHash: string;
  rows?: string[][];
}

export interface PublishArtifactShareRequest {
  /** Public web origin for minting share URLs (workers; browsers send Origin). */
  clientOrigin?: string;
  path: string;
}

export interface PublishArtifactShareResponse {
  id: string;
  refreshed: boolean;
  sharePath: string;
  shareUrl: string | null;
  token: string;
  webPublicUrlConfigured: boolean;
}

export interface ArtifactShareStatusResponse {
  active: boolean;
  createdAt: string;
  id: string;
  sharePath: string;
  shareUrl: string | null;
  webPublicUrlConfigured: boolean;
}

export interface RevokeArtifactShareResponse {
  id: string;
  revoked: boolean;
}

export interface PublicArtifactShareResponse {
  filename: string;
  inlineAllowed: boolean;
  mimeType: string;
  sizeBytes: number;
}

export type * from "./artifact-preview/types";

export type KnowledgeBaseDocumentStatus = "ready" | "failed";

export type KnowledgeBaseDuplicateAction = "error" | "skip" | "replace";

export type KnowledgeBaseDuplicateMatch = "content_hash" | "name_size";

export interface KnowledgeBaseDuplicateConflict {
  existingDocumentId: string;
  existingFilename: string;
  match: KnowledgeBaseDuplicateMatch;
}

export interface KnowledgeBaseDuplicateResponse extends ApiErrorResponse {
  duplicate: KnowledgeBaseDuplicateConflict;
}

export type KnowledgeBaseUploadOutcome = "created" | "skipped" | "replaced";

export interface KnowledgeBaseDocument {
  /** SHA-256 of the stored bytes. Optional for legacy manifests. */
  contentHash?: string;
  error?: string;
  filename: string;
  id: string;
  mediaType: string;
  sizeBytes: number;
  status: KnowledgeBaseDocumentStatus;
  uploadedAt: string;
}

export interface KnowledgeBaseSource {
  description: string;
  enabled: boolean;
  id: string;
  inherited: boolean;
  kind: "url";
  title: string;
  url: string;
}

export interface ListKnowledgeBaseResponse {
  documents: KnowledgeBaseDocument[];
  profileId: string;
  sources: KnowledgeBaseSource[];
}

export interface UploadKnowledgeBaseRequest {
  document: DocumentAttachment;
  onDuplicate?: KnowledgeBaseDuplicateAction;
}

export interface UploadKnowledgeBaseResponse {
  document: KnowledgeBaseDocument;
  outcome: KnowledgeBaseUploadOutcome;
  profileId: string;
}

export interface DeleteKnowledgeBaseResponse {
  deleted: boolean;
  documentId: string;
  profileId: string;
}

export interface UserContextStatusResponse {
  active: boolean;
  content?: string;
}

export interface UpdateUserContextRequest {
  content: string;
}

export interface InitUserContextResponse {
  created: boolean;
}

export type ProviderName = import("./provider-catalog").BuiltinProviderName;

export type OllamaHostMode = "local" | "cloud";

/** OpenAI-compatible endpoints may expose either wire protocol. */
export type WireApi = "chat" | "responses";

export type GenerateTextFormat = "json" | "text";

export interface GenerateTextInput {
  /** Defaults to `json` for structured automation drafts. Use `text` for plain prose. */
  format?: GenerateTextFormat;
  prompt: string;
  /** Provider-specific options (e.g. thinking/reasoning effort). */
  providerOptions?: Record<string, unknown>;
  /** Optional abort signal to cancel the request. */
  signal?: AbortSignal;
  system: string;
}

export interface JsonSchema {
  additionalProperties?: boolean | JsonSchema;
  description?: string;
  enum?: Array<string | number | boolean>;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  type?: string | string[];
}

export interface LlmToolDefinition {
  description: string;
  name: string;
  parameters: JsonSchema;
}

export interface ToolCall {
  arguments: Record<string, unknown>;
  id: string;
  name: string;
}

export type ProviderContentProtocol =
  | "anthropic-messages"
  | "gemini-content"
  | "openai-responses";

/** Identifies the wire format of opaque assistant content kept for exact replay. */
export interface ProviderContentProvenance {
  /** Exact model that produced the opaque payload. */
  modelId?: string;
  protocol: ProviderContentProtocol;
  provider: ProviderName;
  /** Stable configured provider identity; prevents replay across instances of the same type. */
  providerInstanceId?: string;
  /** Random connection revision rotated when provider connection semantics change. */
  providerReplayRevision?: string;
}

export type ChatMessage =
  | { role: "user"; content: string | MessageContentPart[] }
  | {
      /** Pending or resolved action approval rendered by chat UI; never replayed to providers. */
      approval?: ApprovalRequest;
      role: "assistant";
      content: string;
      /**
       * Follow-up question suggestions shown under the reply. UI-only: providers
       * must not send it back, and it is stripped before provider replay.
       */
      relatedQuestions?: string[];
      /** Model reasoning trace for display; not sent as plain assistant text to providers. */
      thinking?: string;
      summary?: boolean;
      /** Original attachments retained through compaction, independently of model summary wording. */
      fileReferences?: Extract<MessageContentPart, { type: "document_ref" }>[];
      toolCalls?: ToolCall[];
      /** Provider-specific assistant payload for multi-turn replay (Anthropic blocks, OpenAI response items). */
      providerContent?: unknown[];
      /**
       * Source of `providerContent`. Opaque content is replayed only when both
       * the provider and wire protocol match the active turn.
       */
      providerContentProvenance?: ProviderContentProvenance;
    }
  | { role: "tool"; toolCallId: string; name: string; content: string };

/** Exact native model evidence; never append these diagnostics to answer content. */
export interface ProviderModelIdentity {
  basis:
    | "exact"
    | "advertised-resolution"
    | "unresolved-alias"
    | "not-reported";
  reportedModels: string[];
  requestedModel: string;
  verification: "verified" | "unverifiable";
}

export interface ChatCompletionResult {
  assistantMessage: Extract<ChatMessage, { role: "assistant" }>;
  content: string;
  /**
   * Current provider-managed context occupancy, separate from billable usage.
   * The window is already the runtime's effective budget; do not reserve output again.
   */
  contextUsage?: {
    contextWindow: number;
    usedTokens: number;
  };
  modelIdentity?: ProviderModelIdentity;
  toolCalls: ToolCall[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    /** True when input/output tokens were estimated rather than reported by the provider. */
    estimated?: boolean;
  };
}

export interface GenerateTextResult {
  content: string;
  modelIdentity?: ProviderModelIdentity;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

export interface ProviderChatOptions {
  thinking?: {
    enabled: boolean;
    effort?: ThinkingEffort;
  };
  /** Use the active provider's hosted web search instead of executing web_search locally. */
  webSearch?: boolean;
}

export interface GenerateChatInput {
  /**
   * Atlas session id. Subscription runtimes use this to resume the provider-side
   * thread/session without replacing the Atlas session identifier.
   */
  conversationId?: string;
  /** Runtime tool requests execute through Atlas while the provider turn is open. */
  executeToolCall?: (
    call: ToolCall,
    signal?: AbortSignal
  ) => Promise<ProviderToolExecutionResult>;
  messages: ChatMessage[];
  providerOptions?: ProviderChatOptions;
  /**
   * Aborts the upstream request when the caller cancels the turn. Providers must
   * pass it to their HTTP client, otherwise a cancelled chat keeps streaming and
   * billing until the model finishes.
   */
  signal?: AbortSignal;
  system: string;
  tools?: LlmToolDefinition[];
}

export interface ProviderToolExecutionResult {
  content: string;
  success: boolean;
}

export type ToolApprovalDecision =
  | { decision: "approved"; grantId: string }
  | { decision: "denied" };

export interface ToolExecutionReceipt {
  call: ToolCall;
  content: string;
}

export interface ToolApprovalInput {
  approval: ApprovalRequest;
  call: ToolCall;
  runId: string;
  signal?: AbortSignal;
}

export interface StreamChatHandlers {
  onChunk: (delta: string) => void;
  onThinking?: (delta: string) => void;
  onToolEnd?: (event: {
    toolCallId: string;
    tool: string;
    result: unknown;
  }) => void;
  onToolInputDelta?: (event: {
    toolCallId: string;
    tool: string;
    delta: string;
    accumulatedArguments?: string;
  }) => void;
  onToolStart?: (event: {
    toolCallId: string;
    tool: string;
    input: Record<string, unknown>;
  }) => void;
}

export interface ProviderClient {
  generateChat(input: GenerateChatInput): Promise<ChatCompletionResult>;
  generateText(input: GenerateTextInput): Promise<GenerateTextResult>;
  /** The native runtime owns automatic context compaction and context accounting. */
  managesContext?: boolean;
  name: ProviderName;
  streamChat(
    input: GenerateChatInput,
    handlers: StreamChatHandlers
  ): Promise<ChatCompletionResult>;
}

export interface ToolContext {
  /** Nesting depth for sub-agent execution (0 = parent, 1 = child). */
  agentDepth?: number;
  /** Single-use approval grant consumed at the execution boundary. */
  approvalGrantId?: string;
  /** Fresh invocation-local byte staging capability, installed by trusted execution code. */
  artifactPublisher?: ToolArtifactPublisher;
  automationId?: string;
  automationRunId?: string;
  /** Revalidates tenant liveness at the final boundary before a tool runs. */
  beforeToolCall?: (toolName?: string) => Promise<void>;
  /** Session channel when known (used for interactive-only tool gates). */
  channel?: AgentChannel;
  /** Browser origin for OAuth callbacks during this tool run. */
  clientOrigin?: string;
  /** Emits concise live status lines while a sub-agent child loop runs (parent web UI). */
  emitSubAgentActivity?: (label: string) => void;
  /** Optional narrower read boundary for embedded document assets. */
  fileAssetAllowedDirs?: string[];
  /**
   * When true (skill_manage is in the session tool list), write_file / edit_file / delete_file
   * refuse paths matching skills/<name>/SKILL.md under the profile workspace.
   */
  forbidProfileSkillMarkdownWrites?: boolean;
  /** Dynamic per-turn gate: when true, skill_manage may only stage proposals. */
  forceSkillWriteProposal?: () => boolean;
  /** Platform admin bypass for org-memory writes when orgRole is not admin. */
  isPlatformAdmin?: boolean;
  /** Loads a provider-neutral document/image reference scoped to this execution. */
  loadAttachment?: LoadAttachmentBytes;
  /** Close the shared action run after the conversation turn settles. */
  onToolTurnEnd?: (
    runId: string,
    status: "completed" | "failed" | "cancelled",
    results: readonly ToolExecutionReceipt[]
  ) => Promise<void>;
  orgId?: string;
  /** Org role of the invoking user. Org-memory tools gate on this; undefined means deny-by-default. */
  orgRole?: OrgRole;
  profileId?: string;
  /**
   * Records bytes an optimiser removed from a tool result before insertion.
   * Passed in rather than imported because the database lives in the server and
   * this runs in core. Optional and fire-and-forget: a platform that does not
   * record anything simply leaves it undefined.
   */
  recordToolOutputSavings?: (saving: {
    bytesIn: number;
    bytesOut: number;
    optimizer: string;
    tool: string;
  }) => void;
  /**
   * Records what the provider actually charged for one request, tagged with
   * whether the optimiser was active. This is the only honest route from bytes
   * to tokens: the provider counts, split by arm.
   */
  recordTurnUsage?: (turn: {
    estimated: boolean;
    inputTokens: number;
    optimized: boolean;
    outputTokens: number;
  }) => void;
  requestChannelAction?: (
    action: import("./channel-native-actions").ChannelNativeAction,
    onPending?: (
      request: import("./channel-native-actions").ChannelNativeActionRequest
    ) => void,
    signal?: AbortSignal
  ) => Promise<import("./channel-native-actions").ChannelActionReceipt>;
  /** Persist the pending action before notifying the user, then await its decision. */
  requestToolApproval?: (
    request: ToolApprovalInput,
    onPending: () => void
  ) => Promise<ToolApprovalDecision>;
  /**
   * Durable execution-run id. Browser contexts, learning evidence, and
   * approval resume bind to this — not to a process-local session key.
   */
  runId?: string;
  sessionId?: string;
  /** Aborts when the caller cancels the turn. Long-running tools should stop their work on it. */
  signal?: AbortSignal;
  /**
   * Per-org override for the tool-output optimiser. Undefined means the setting
   * was never chosen, which falls back to the server's ATLAS_OMNI env var.
   */
  tokenOptimizerEnabled?: boolean | null;
  userId?: string;
  /** Profile workspace root (~/.atlas/orgs/{orgId}/profiles/{profileId}/). */
  workspaceRoot?: string;
}

export interface ToolDefinition<Input = unknown, Output = unknown> {
  /** Set only by the server wrapper that confines channel guest work-file access. */
  channelGuestFileSafe?: boolean;
  description: string;
  name: string;
  /** When true, this tool may run concurrently with other parallelSafe tools in the same turn. */
  parallelSafe?: boolean;
  parameters?: JsonSchema;
  /** Optional execution-boundary retry policy for this tool. */
  retryPolicy?: RetryPolicy;
  run(input: Input, context: ToolContext): Promise<Output>;
}

export const COMPOSIO_TOOLKIT_SLUG_PATTERN = /^[a-z0-9_-]+$/;

export type ComposioOrgToolkitStatus = "disabled" | "enabled";

export type ComposioUserConnectionStatus =
  | "oauth_in_progress"
  | "connected"
  | "error";

/** @deprecated Org catalog uses ComposioOrgToolkitStatus; user rows use ComposioUserConnectionStatus. */
export type ComposioToolkitStatus =
  | ComposioOrgToolkitStatus
  | ComposioUserConnectionStatus;

export type ComposioToolErrorCode =
  | "COMPOSIO_NOT_CONNECTED"
  | "COMPOSIO_TRANSIENT"
  | "COMPOSIO_POLICY";

export interface ComposioCachedToolSummary {
  description: string;
  inputSchema: Record<string, unknown>;
  name: string;
  slug: string;
}

export interface ComposioToolkitSummary {
  cachedTools: ComposioCachedToolSummary[];
  displayName: string;
  id: string;
  lastError: string | null;
  status: ComposioOrgToolkitStatus;
  toolkitSlug: string;
  updatedAt: string;
}

export interface ComposioUserConnectionSummary {
  id: string;
  lastError: string | null;
  status: ComposioUserConnectionStatus;
  toolkitId: string;
  toolkitSlug: string;
  updatedAt: string;
}

export interface ComposioCatalogToolkitSummary {
  description: string | null;
  logoUrl: string | null;
  name: string;
  slug: string;
}

export interface ListComposioToolkitsResponse {
  catalog: ComposioCatalogToolkitSummary[];
  catalogError: string | null;
  /** @deprecated Use composioReachable. */
  composioAvailable: boolean;
  /** Atlas can reach the Composio API with the saved key. */
  composioReachable: boolean;
  /** A Composio project API key is saved on this server. */
  configured: boolean;
  orgToolkits: ComposioToolkitSummary[];
  userConnections: ComposioUserConnectionSummary[];
}

export interface EnableComposioToolkitRequest {
  toolkitSlug: string;
}

export interface ComposioConnectRequest {
  /** Browser origin for OAuth callback (e.g. http://localhost:3000). */
  callbackOrigin?: string;
}

export interface ComposioConnectResponse {
  redirectUrl: string;
}

export interface ProfileComposioToolkitAssignment {
  allowedActions: string[] | null;
  toolkitId: string;
  toolkitSlug: string;
}

export interface ListProfileComposioToolkitsResponse {
  assignments: ProfileComposioToolkitAssignment[];
}

export interface UpdateProfileComposioToolkitsRequest {
  assignments: Array<{
    toolkitId: string;
    allowedActions?: string[] | null;
  }>;
}

export interface ComposioToolErrorResult {
  code: ComposioToolErrorCode;
  error: string;
  toolkitSlug?: string;
}

export * from "./tools/execution-contract";
