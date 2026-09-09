import path from "node:path";
import {
  type AgentChatSession,
  type AgentHarness,
  type ChatCapabilityPolicy,
  type CompactionConfig,
  createAgentHarness,
  draftTaskPromptFromFields,
  executeToolCall,
  expandLearnInLastUserMessage,
  suggestToolParamsFromPrompt,
  type ToolLoopStopReason,
  tryParseLearnCommand,
} from "@atlas/agent";
import type {
  AgentBrowserStatusResponse,
  AgentChannel,
  AgentQuestionnaire,
  AgentTodo,
  ArtifactPreview,
  AssignSkillRequest,
  AssignToolRequest,
  BranchSessionResponse,
  CanonicalPrincipal,
  CapabilityCatalogResponse,
  CapabilityMappingsResponse,
  CapabilityOptionsResponse,
  ChatContextUsage,
  ChatMessage,
  CloneProfileRequest,
  CompactionResponse,
  ComposioSettingsResponse,
  ConfigureProviderRequest,
  ConfigureProviderResponse,
  CreateProfileRequest,
  CreateProviderRequest,
  CreateProviderResponse,
  CreateSkillRequest,
  CreateToolRequest,
  DeleteArtifactResponse,
  DeleteKnowledgeBaseResponse,
  DeleteProviderResponse,
  DiscordSettingsResponse,
  DiscoverModelsRequest,
  DocumentAttachment,
  EmailSettingsResponse,
  ErrorTrackingSettingsResponse,
  ExternalPrincipalInput,
  GenerateImageRequest,
  GenerateImageResponse,
  ImageAttachment,
  ImageGenerationSettings,
  ImageGenerationSettingsResponse,
  InitSoulResponse,
  InitUserContextResponse,
  InstallSkillRequest,
  KnowledgeBaseDuplicateAction,
  ListArtifactsOptions,
  ListArtifactsResponse,
  ListKnowledgeBaseResponse,
  ListProfilesResponse,
  ListProvidersResponse,
  ListSessionsResponse,
  ListSkillsResponse,
  ListToolsResponse,
  ModelsResponse,
  PatchSkillRequest,
  PreviewJob,
  PreviewManifest,
  PreviewMetadata,
  PreviewOptions,
  ProfileResponse,
  ProviderChatOptions,
  ProviderClient,
  ProviderInstance,
  RunToolResponse,
  SendEmailTestResponse,
  SendErrorTrackingTestResponse,
  SkillResponse,
  SoulStackResponse,
  SoulStatusResponse,
  SuggestToolParamsResponse,
  SyncSkillsResponse,
  TelegramSettingsResponse,
  TestProviderRequest,
  TestProviderResponse,
  ThinkingSettings,
  ThinkingSettingsResponse,
  ToolContext,
  ToolDefinition,
  ToolResponse,
  ToolSourceResponse,
  TranscribeAudioRequest,
  TranscribeAudioResponse,
  TranscriptionSettings,
  TranscriptionSettingsResponse,
  UpdateCapabilityMappingRequest,
  UpdateCapabilityMappingResponse,
  UpdateComposioSettingsRequest,
  UpdateDiscordSettingsRequest,
  UpdateEmailSettingsRequest,
  UpdateErrorTrackingSettingsRequest,
  UpdateImageGenerationRequest,
  UpdateProfileRequest,
  UpdateProviderRequest,
  UpdateProviderResponse,
  UpdateSoulFileRequest,
  UpdateTelegramSettingsRequest,
  UpdateThinkingRequest,
  UpdateTranscriptionRequest,
  UpdateUserContextRequest,
  UpdateVisionRequest,
  UpdateWhatsAppSettingsRequest,
  UploadKnowledgeBaseResponse,
  UserConfig,
  UserContextStatusResponse,
  VisionSettings,
  VisionSettingsResponse,
  WhatsAppSettingsResponse,
} from "@atlas/core";
import {
  AtlasApiError,
  appendOrgMemorySection,
  assignedSkillsForbidMarkdownWrites,
  buildErrorReport,
  buildToolExecutionContext,
  buildUserContextStatus,
  composeKnowledgeBaseCatalog,
  composeSoulSystemPrompt,
  composeTurnMemoryContext,
  createErrorTrackingSink,
  createSmtpSender,
  DEFAULT_THINKING_EFFORT,
  DEFAULT_THINKING_ENABLED,
  DEFAULT_TIMEZONE,
  DISCORD_BOT_TOKEN_IN_USE_MESSAGE,
  deleteArtifactFile,
  discordBotTokenUsedByAnotherWorkspace,
  emailConfigToMailboxConfig,
  extractImageParts,
  findProviderInstance,
  getActiveProviderInstance,
  getProfileSoulDir,
  getResolvedSoulStatus,
  initSoulDirectory,
  isChannelGuestUserId,
  isEmailConfigComplete,
  isProviderConfigured,
  isServiceAccountUserId,
  isSubscriptionProvider,
  isValidTimezone,
  isWritableSoulFileKey,
  listArtifacts,
  loadComposioSettingsPublic,
  loadDiscordSettingsPublic,
  loadEmailConfig,
  loadEmailSettingsPublic,
  loadErrorTrackingSettingsPublic,
  loadSoulStack,
  loadTelegramSettingsPublic,
  loadUserConfig,
  loadUserThinkingSettings,
  loadUserTimezone,
  loadUserTranscriptionSettings,
  loadUserVisionSettings,
  loadWhatsAppSettingsPublic,
  mapArtifactReadError,
  messageContentHasImages,
  migrateCapabilityTargetProviderIds,
  migrateLegacyCapabilityConfig,
  migrateLegacyChannelToWorkspace,
  nanoid,
  normalizeBaseUrl,
  normalizeUserContextContent,
  type OrgRole,
  PROVIDER_CAPABILITY_IDS,
  PrincipalRequiredError,
  parseSentryDsn,
  persistInlineAttachmentsInContent,
  previewService,
  readArtifactFile,
  readBundledSkillBody,
  refreshErrorTrackingEnabled,
  regenerateDiscordHandshake,
  regenerateTelegramHandshake,
  regenerateWhatsAppPairingCode,
  rehydrateMessagesForProvider as rehydrateAttachmentMessages,
  rehydrateAttachmentRefsInContent,
  replaceImagePartsWithDescriptions,
  resolveDiscordApplicationId,
  resolveSoulStackForProfile,
  runAsPrincipal,
  saveComposioConfig,
  saveDiscordConfig,
  saveEmailConfig,
  saveErrorTrackingDsn,
  saveTelegramConfig,
  saveUserThinkingSettings,
  saveUserTimezone,
  saveWhatsAppConfig,
  TELEGRAM_BOT_TOKEN_IN_USE_MESSAGE,
  telegramBotTokenUsedByAnotherWorkspace,
  USER_CONTEXT_TEMPLATE,
  validateCapabilityConfig,
  WHATSAPP_PHONE_IN_USE_MESSAGE,
  whatsAppPhoneUsedByAnotherWorkspace,
  withProfileSoulMutationLock,
  writeSoulFile,
} from "@atlas/core";
import { readAttachmentBytes } from "@atlas/core/attachments/store";
import { canAccessSuperAgentProfile } from "@atlas/core/profiles";
import {
  appendRuntimeProfileRules,
  type DatabaseAdapter,
  type LlmUsageDimensions,
  mergeWorkspaceSettings,
  type StoredProfileRecord,
  type StoredSessionRecord,
  type StoredTaskRecord,
  type StoredTaskRunRecord,
  UNKNOWN_USAGE_DIMENSION,
  WORKSPACE_SETTINGS_ID,
} from "@atlas/db";
import {
  AVAILABLE_MODELS,
  builtinProviderAdapterRegistry,
  createProviderForInstance,
  createProviderFromActiveConfig,
  evaluateCapabilityTarget,
  getModelsForProviderInstance,
  isCostEstimated,
  type ProviderAdapterRegistry,
  readApiKeyForInstance,
  resolveConfiguredCapability,
  withLiveOpenCodeGoCatalog,
} from "../providers";
import { resolveModelCompactionConfig } from "../providers/model-context";
import { wrapProviderForNonVision } from "../providers/non-vision-wrap";
import {
  estimateUsageCostUsd,
  type PricingContext,
} from "../providers/pricing";
import { resolveThinkingEffort } from "../providers/shared";
import { deleteSubscriptionConversation } from "../providers/subscription";
import { wrapProviderWithUsageTracking } from "../providers/usage-tracking";
import { createAskUserQuestionTools } from "../tools/ask-user-question-tool";
import { createDeepResearchServerTool } from "../tools/deep-research-server";
import { createOrgMemoryTools } from "../tools/org-memory-tools";
import { createSendDiscordArtifactTools } from "../tools/send-discord-artifact-tool";
import { createSkillManageTools } from "../tools/skill-manage-tool";
import { formatToolActivityLabel } from "../tools/sub-agent-activity";
import {
  buildSubAgentPrompt,
  buildSubAgentResult,
  DEFAULT_SUB_AGENT_TIMEOUT_MS,
  failSubAgentResult,
  MAX_SUB_AGENT_TIMEOUT_MS,
  type SubAgentRunInput,
  type SubAgentRunResult,
} from "../tools/sub-agent-shared";
import { SUB_AGENT_TOOL_NAME } from "../tools/sub-agent-tool";
import { createSuperAgentTools } from "../tools/super-agent-tools";
import { createTodoTools } from "../tools/todo-tools";
import { getAgentBrowserStatus } from "./agent-browser-service";
import { AgentQuestionnaireState } from "./agent-questionnaire-state";
import { AgentTodoState } from "./agent-todo-state";
import {
  createAttachmentLoader,
  createTurnAttachmentSaver,
} from "./attachment-service";
import {
  decodeAudioTranscriptionData,
  resolveTranscriptionProviderSelection,
  TRANSCRIPTION_MODEL_REQUIRED_MESSAGE,
  transcribeAudio,
} from "./audio-transcription";
import type { AutomationRunner } from "./automation-runner";
import { resolveExecutableToolsForPrincipal } from "./channel-guest-tool-policy";
import { ChannelNativeActionService } from "./channel-native-action-service";
import { isChannelWorkFileTool } from "./channel-work-file-tools";
import {
  createChatCapabilityAwareProvider,
  modelClaimsForCapability,
  resolveChatCapabilityPolicy,
} from "./chat-capability-policy";
import {
  type ChatToolApprovalDecisionInput,
  ChatToolApprovalService,
} from "./chat-tool-approval-service";
import {
  buildCodingAgentCommandTemplate,
  formatCodingAgentCommandContext,
  getBackendSkillName,
} from "./coding-agent-command";
import {
  type CodingAgentHarnessStatus,
  getCodingHarnessInstallCommand,
  listInstalledCodingAgentHarnesses,
  loadCodingAgentProviderPassthroughForOrg,
} from "./coding-agent-harness-service";
import type { ComposioService } from "./composio-service";
import {
  buildComposioConnectTools,
  buildComposioToolDefinitions,
} from "./composio-tool-bridge";
import { ExecutionPlaneService } from "./execution-plane-service";
import { IdentityService } from "./identity-service";
import {
  generateImage,
  IMAGE_MODEL_REQUIRED_MESSAGE,
  resolveImageGenerationSelection,
} from "./image-generation";
import {
  describeImagesWithConfiguredVisionModel,
  resolvePrimaryModelVisionSupport,
} from "./image-vision-fallback";
import {
  loadJavascriptTool,
  validateJavascriptToolModule,
} from "./javascript-tool-loader";
import { composeKnowledgeBaseTurnGrounding } from "./knowledge-base-grounding";
import { shouldExpandLearnCommand } from "./learn-command";
import { LearningPlaneService } from "./learning-plane-service";
import type { LlmUsageTracker } from "./llm-usage-tracker";
import type { McpClientManager } from "./mcp-client-manager";
import type { McpService } from "./mcp-service";
import { buildMcpToolDefinitions } from "./mcp-tool-bridge";
import { MemoryService } from "./memory-service";
import { OrgMemoryService } from "./org-memory-service";
import {
  ProfileChangeHistoryService,
  type ProfileChangeMeta,
  soulFieldFromKey,
} from "./profile-change-history";
import { ProfileService } from "./profile-service";
import {
  applyProviderInstanceUpdate,
  buildProviderInstanceFromCreateRequest,
  countModelsForInstance,
  decodeStoredModelSelection,
  isProviderInstanceUsable,
  mergeModelsForConfig,
  resolveDefaultModelForInstance,
  resolveInitialModel,
  resolveProfileProviderSelection,
  toProviderInstanceSummary,
} from "./provider-instance-helpers";
import {
  canonicalSubscriptionModelSnapshot,
  validateProviderConnection,
} from "./provider-validation-service";
import { createPublicationTurnPrincipal } from "./publication-turn-principal";
import {
  loadSessionHistory,
  replaceSessionHistory,
  wrapPersistedSession,
} from "./session-persistence";
import { SessionTitleService } from "./session-title-service";
import { sessionTurnRegistry } from "./session-turn-registry";
import { SkillPostTurnReviewService } from "./skill-post-turn-review-service";
import type { SkillProposalService } from "./skill-proposal-service";
import type { SkillSuggestionService } from "./skill-suggestion-service";
import type { SkillsService } from "./skills-service";
import { SubagentService } from "./subagent-service";
import { SuperAgentSessionState } from "./super-agent-session-state";
import type { TaskRunner } from "./task-runner";
import {
  resolveProfileStoredTools,
  withToolSearchCatalog,
} from "./tool-resolver";

interface StoredSession {
  channel: AgentChannel;
  isPlatformAdmin: boolean;
  modelOverride: string | null;
  orgId: string;
  orgRole: OrgRole | null;
  profileId: string;
  session: AgentChatSession;
  userId: string | null;
}

export type { SubAgentRunInput, SubAgentRunResult };

export interface SessionAccessOptions {
  excludeSuperAgent?: boolean;
  externalPrincipal?: ExternalPrincipalInput;
  isPlatformAdmin?: boolean;
  model?: string | null;
  orgRole?: OrgRole | null;
}

export interface SessionActor {
  isPlatformAdmin?: boolean;
  orgRole?: OrgRole | null;
  userId: string;
  workspaceWorkerChannel?: "discord" | "telegram" | "whatsapp";
}

export type SessionAccessIntent = "invoke" | "manage" | "read";

function providerBaseUrlChanged(
  instance: ProviderInstance,
  nextBaseUrl: string | undefined
): boolean {
  if (nextBaseUrl === undefined) {
    return false;
  }

  return (
    normalizeBaseUrl(nextBaseUrl) !== normalizeBaseUrl(instance.baseUrl ?? "")
  );
}

function requireCredentialForProviderEndpointChange(
  instance: ProviderInstance,
  nextBaseUrl: string | undefined,
  replacementApiKey: string | undefined
): void {
  if (
    providerBaseUrlChanged(instance, nextBaseUrl) &&
    readApiKeyForInstance(instance, process.env)?.trim() &&
    !replacementApiKey?.trim()
  ) {
    throw new Error("Re-enter the API key when changing a provider base URL.");
  }
}

export class AgentService {
  private userConfig: UserConfig | null;
  private readonly orgUserConfigs = new Map<string, UserConfig | null>();
  private readonly db: DatabaseAdapter;
  private readonly profileService: ProfileService;
  private readonly superAgentSessionState = new SuperAgentSessionState();
  private readonly agentTodoState: AgentTodoState;
  private readonly agentQuestionnaireState: AgentQuestionnaireState;
  private readonly superAgentTools: ToolDefinition[];
  private readonly orgMemoryTools: ToolDefinition[];
  private automationTools: ToolDefinition[] = [];
  private automationRunHistoryTools: ToolDefinition[] = [];
  private questionTools: ToolDefinition[] = [];
  private todoTools: ToolDefinition[] = [];
  private automationRunner: AutomationRunner | null = null;
  private taskRunner: TaskRunner | null = null;
  private mcpClientManager: McpClientManager | null = null;
  private mcpService: McpService | null = null;
  private composioService: ComposioService | null = null;
  private skillsService: SkillsService | null = null;
  private skillProposalService: SkillProposalService | null = null;
  private skillSuggestionService: SkillSuggestionService | null = null;
  private orgMemoryService: OrgMemoryService | null = null;
  private readonly memoryService: MemoryService;
  readonly identityService: IdentityService;
  readonly executionPlane: ExecutionPlaneService;
  readonly chatToolApprovals: ChatToolApprovalService;
  readonly channelNativeActions: ChannelNativeActionService;
  readonly learningPlane: LearningPlaneService;
  readonly subagents: SubagentService;
  private readonly sessions = new Map<string, StoredSession>();
  private readonly mcpAvailabilityVersions = new Map<string, number>();
  private readonly sessionInvalidationVersions = new Map<string, number>();
  private readonly profileToolInvalidationVersions = new Map<string, number>();
  private readonly sessionTitleService: SessionTitleService;
  private skillPostTurnReviewService: SkillPostTurnReviewService;
  private _providerConfigured: boolean;
  private providerSettingsPromise: Promise<void> | null = null;
  private readonly orgConfigMutationLocks = new Map<string, Promise<unknown>>();
  private visionSettingsPromise: Promise<void> | null = null;
  private transcriptionSettingsPromise: Promise<void> | null = null;
  private imageGenerationSettingsPromise: Promise<void> | null = null;

  constructor(
    userConfig: UserConfig | null,
    provider: ProviderClient | null,
    db: DatabaseAdapter,
    private readonly llmUsageTracker?: LlmUsageTracker,
    private readonly providerAdapterRegistry: ProviderAdapterRegistry = builtinProviderAdapterRegistry
  ) {
    this.userConfig = userConfig;
    this.db = db;
    this.memoryService = new MemoryService(db);
    this.identityService = new IdentityService(db);
    this.channelNativeActions = new ChannelNativeActionService(
      db,
      this.identityService
    );
    this.executionPlane = new ExecutionPlaneService(db);
    this.chatToolApprovals = new ChatToolApprovalService(
      db,
      this.executionPlane
    );
    this.learningPlane = new LearningPlaneService(db);
    this.subagents = new SubagentService(this, this.executionPlane, db);
    this.profileService = new ProfileService(db);
    this.sessionTitleService = new SessionTitleService(
      db,
      (orgId) => this.getOrgUserConfig(orgId),
      (instance, modelId, config) =>
        this.createCapabilityAwareProvider(instance, modelId, config)
    );
    this.skillPostTurnReviewService = new SkillPostTurnReviewService(
      db,
      (orgId) => this.getOrgUserConfig(orgId),
      undefined,
      (instance, modelId, config) =>
        this.createCapabilityAwareProvider(instance, modelId, config)
    );
    this.agentTodoState = new AgentTodoState(db);
    this.agentQuestionnaireState = new AgentQuestionnaireState(db);
    this.questionTools = createAskUserQuestionTools(
      this.agentQuestionnaireState
    );
    this.todoTools = createTodoTools(this.agentTodoState);
    this.superAgentTools = createSuperAgentTools(
      this.profileService,
      this.superAgentSessionState,
      {
        onProfileUpdated: (profileId) => {
          this.invalidateProfileSessions(profileId);
        },
      }
    );
    this.orgMemoryTools = createOrgMemoryTools(this.getOrgMemoryService());
    this._providerConfigured =
      isProviderConfigured(userConfig) && provider !== null;
  }

  /**
   * Binds a savings recorder to one org. Fire and forget on purpose: a counter
   * for a dashboard must never delay a tool result or fail a turn, so the write
   * is not awaited and a rejection is swallowed.
   */
  /** Same fire-and-forget shape as the savings recorder, for provider tokens. */
  /**
   * Resolve the attribution dimensions (workspace/user/profile + the active
   * provider credential and model) plus a pricing context for a session, so
   * each turn can be folded into the multi-tenant usage rollup. Returns
   * undefined when no provider is configured (nothing to attribute).
   */
  private buildUsageAttribution(options: {
    channel: AgentChannel;
    orgId: string;
    userId?: string | null;
    profileId: string;
    userConfig: UserConfig | null;
    modelSelection?: string | null;
  }): { dimensions: LlmUsageDimensions; pricing: PricingContext } | undefined {
    const resolved = this.resolveConfiguredProviderSelection(
      options.userConfig,
      options.modelSelection
    );
    const instance =
      resolved?.instance ?? getActiveProviderInstance(options.userConfig);
    if (!instance) {
      return;
    }

    const modelId =
      resolved?.model ||
      resolveDefaultModelForInstance(instance) ||
      instance.type;

    return {
      dimensions: {
        capability: PROVIDER_CAPABILITY_IDS.chatCompletion,
        channel: options.channel,
        modelId,
        orgId: options.orgId,
        profileId: options.profileId || UNKNOWN_USAGE_DIMENSION,
        providerCredentialId: instance.id,
        providerType: instance.type,
        userId: options.userId?.trim() || UNKNOWN_USAGE_DIMENSION,
      },
      pricing: { provider: instance.type, providerInstance: instance },
    };
  }

  /**
   * Folds one capability execution (image generation, transcription, vision
   * describe) into the multi-tenant usage rollup. Fire and forget on purpose:
   * a usage counter must never delay or fail the capability result.
   */
  private recordCapabilityUsageDaily(options: {
    capability: string;
    channel?: AgentChannel;
    instance: ProviderInstance;
    modelId: string;
    orgId: string;
    profileId?: string | null;
    usage?: { inputTokens: number; outputTokens: number } | null;
    userId?: string | null;
  }): void {
    const inputTokens = options.usage?.inputTokens ?? 0;
    const outputTokens = options.usage?.outputTokens ?? 0;
    const estimatedCostUsd = estimateUsageCostUsd(
      options.modelId,
      inputTokens,
      outputTokens,
      {
        provider: options.instance.type,
        providerInstance: options.instance,
      }
    );
    void this.db
      .incrementLlmUsageDaily(
        {
          capability: options.capability,
          channel: options.channel ?? UNKNOWN_USAGE_DIMENSION,
          modelId: options.modelId,
          orgId: options.orgId,
          profileId: options.profileId?.trim() || UNKNOWN_USAGE_DIMENSION,
          providerCredentialId: options.instance.id,
          providerType: options.instance.type,
          userId: options.userId?.trim() || UNKNOWN_USAGE_DIMENSION,
        },
        {
          estimatedCostUsd,
          inputTokens,
          outputTokens,
          requestCount: 1,
        }
      )
      .catch(() => undefined);
  }

  private turnUsageRecorderFor(
    orgId: string | undefined,
    attribution?: { dimensions: LlmUsageDimensions; pricing: PricingContext }
  ) {
    if (!orgId?.trim()) {
      return;
    }

    const scopedOrgId = orgId.trim();

    return (turn: {
      estimated: boolean;
      inputTokens: number;
      optimized: boolean;
      outputTokens: number;
    }): void => {
      void this.db
        .incrementLlmTurnUsage(scopedOrgId, turn)
        .catch(() => undefined);

      if (attribution) {
        const estimatedCostUsd = estimateUsageCostUsd(
          attribution.dimensions.modelId,
          turn.inputTokens,
          turn.outputTokens,
          attribution.pricing
        );
        void this.db
          .incrementLlmUsageDaily(attribution.dimensions, {
            estimatedCostUsd,
            inputTokens: turn.inputTokens,
            outputTokens: turn.outputTokens,
            requestCount: 1,
          })
          .catch(() => undefined);
      }
    };
  }

  private savingsRecorderFor(orgId: string | undefined) {
    if (!orgId?.trim()) {
      return;
    }

    const scopedOrgId = orgId.trim();

    return (saving: {
      bytesIn: number;
      bytesOut: number;
      optimizer: string;
      tool: string;
    }): void => {
      void this.db
        .incrementToolOutputSavings(
          scopedOrgId,
          saving,
          new Date().toISOString()
        )
        .catch(() => undefined);
    };
  }

  get profiles(): ProfileService {
    return this.profileService;
  }

  private getOrgMemoryService(): OrgMemoryService {
    if (!this.orgMemoryService) {
      this.orgMemoryService = new OrgMemoryService(this.db);
    }
    return this.orgMemoryService;
  }

  private async resolveOrgRole(
    orgId: string | null | undefined,
    userId: string | null | undefined
  ): Promise<OrgRole | null> {
    if (!(orgId && userId)) {
      return null;
    }
    const member = await this.db.getOrgMember(orgId, userId);
    return member?.role ?? null;
  }

  private async resolveIsPlatformAdmin(
    userId: string | null | undefined
  ): Promise<boolean> {
    if (!userId) {
      return false;
    }
    const user = await this.db.getUserById(userId);
    return user?.isPlatformAdmin === true;
  }

  private async canActorUpdateSessionModel(
    orgId: string,
    record: StoredSessionRecord,
    actor: SessionActor
  ): Promise<boolean> {
    return this.canActorAccessSessionRecord(orgId, record, actor, "manage");
  }

  private async canActorAccessSessionRecord(
    orgId: string,
    record: StoredSessionRecord,
    actor: SessionActor,
    intent: SessionAccessIntent
  ): Promise<boolean> {
    const channel = parseAgentChannel(record.channel);
    if (!channel) {
      return false;
    }

    if (actor.workspaceWorkerChannel) {
      const isMatchingExternalChannel =
        (channel === "discord" ||
          channel === "telegram" ||
          channel === "whatsapp") &&
        channel === actor.workspaceWorkerChannel;
      const persistedUserId = record.userId?.trim();
      if (
        !(isMatchingExternalChannel && persistedUserId) ||
        isServiceAccountUserId(persistedUserId)
      ) {
        return false;
      }

      const [member, profile] = await Promise.all([
        this.db.getOrgMember(orgId, persistedUserId),
        this.db.getProfileForOrg(record.profileId, orgId),
      ]);
      if (!(member && profile) || profile.isSuper) {
        return false;
      }
      return intent === "read" || member.role !== "viewer";
    }

    const actorUserId = actor.userId.trim();
    if (!actorUserId) {
      return false;
    }

    const [orgRole, isPlatformAdmin] = await Promise.all([
      this.resolveOrgRole(orgId, actorUserId),
      this.resolveIsPlatformAdmin(actorUserId),
    ]);
    const ownsSession = Boolean(record.userId) && record.userId === actorUserId;

    // Sending/streaming a turn must never impersonate another user's persisted
    // principal (and its per-user OAuth connections), including for admins.
    if (intent === "invoke") {
      return (
        ownsSession &&
        (isPlatformAdmin || orgRole === "admin" || orgRole === "member")
      );
    }

    if (isPlatformAdmin || orgRole === "admin") {
      return true;
    }
    if (!ownsSession) {
      return false;
    }
    return intent === "read" || orgRole === "member";
  }

  async canAccessSession(
    orgId: string,
    sessionId: string,
    actor: SessionActor,
    intent: SessionAccessIntent = "read"
  ): Promise<boolean> {
    const record = await this.getSessionRecordForOrg(orgId, sessionId);
    return record
      ? this.canActorAccessSessionRecord(orgId, record, actor, intent)
      : false;
  }

  async decideChatToolApproval(input: ChatToolApprovalDecisionInput) {
    return this.chatToolApprovals.decide(input);
  }

  setAutomationTools(tools: ToolDefinition[]): void {
    this.automationTools = tools;
    this.sessions.clear();
  }

  setAutomationRunHistoryTools(tools: ToolDefinition[]): void {
    this.automationRunHistoryTools = tools;
  }

  setAutomationRunner(runner: AutomationRunner): void {
    this.automationRunner = runner;
  }

  setTaskRunner(runner: TaskRunner): void {
    this.taskRunner = runner;
  }

  setMcpClientManager(manager: McpClientManager): void {
    this.mcpClientManager = manager;
    this.sessions.clear();
  }

  setMcpService(service: McpService): void {
    this.mcpService = service;
    service.setConfigurationChangeListener((orgId) =>
      this.invalidateSessionsForOrg(orgId)
    );
    service.setStartupConnectionListener((orgId) => {
      this.mcpAvailabilityVersions.set(
        orgId,
        (this.mcpAvailabilityVersions.get(orgId) ?? 0) + 1
      );
      for (const [sessionId, record] of this.sessions) {
        if (record.orgId === orgId) {
          this.refreshSessionAfterTurn(sessionId, record);
        }
      }
    });
  }

  setComposioService(service: ComposioService): void {
    this.composioService = service;
    service.setConfigurationChangeListener((orgId) =>
      this.invalidateSessionsForOrg(orgId)
    );
  }

  setSkillsService(service: SkillsService): void {
    this.skillsService = service;
    this.sessions.clear();
  }

  setSkillProposalService(service: SkillProposalService): void {
    this.skillProposalService = service;
    this.wireSkillPostTurnReviewOutcomeHandling();
  }

  setSkillSuggestionService(service: SkillSuggestionService): void {
    this.skillSuggestionService = service;
    this.wireSkillPostTurnReviewOutcomeHandling();
  }

  /**
   * Once both services are injected, plan where a generated review outcome
   * will be stored. The post-turn service revalidates the active organization
   * after this planning step and immediately before running the returned write.
   */
  private wireSkillPostTurnReviewOutcomeHandling(): void {
    const proposals = this.skillProposalService;
    const suggestions = this.skillSuggestionService;
    if (!(proposals && suggestions)) {
      return;
    }

    this.skillPostTurnReviewService.setPersistencePlanner(
      async (context, outcome) => {
        try {
          const writeApprovalRequired = await proposals.isWriteApprovalRequired(
            context.orgId,
            context.profileId
          );

          const persist = writeApprovalRequired
            ? () =>
                proposals.stageProposal({
                  action: outcome.action,
                  content:
                    outcome.action === "create" ? outcome.content : undefined,
                  newString:
                    outcome.action === "patch" ? outcome.newString : undefined,
                  oldString:
                    outcome.action === "patch" ? outcome.oldString : undefined,
                  orgId: context.orgId,
                  profileId: context.profileId,
                  proposedByUserId: context.userId,
                  sessionId: context.sessionId,
                  skillName: outcome.name,
                })
            : () =>
                suggestions.createSuggestion({
                  orgId: context.orgId,
                  outcome,
                  profileId: context.profileId,
                  proposedByUserId: context.userId,
                  sessionId: context.sessionId,
                });

          return async () => {
            try {
              await persist();
            } catch (error) {
              console.error(
                "Failed to record post-turn skill review outcome:",
                error
              );
            }
          };
        } catch (error) {
          console.error(
            "Failed to record post-turn skill review outcome:",
            error
          );
        }
      }
    );
  }

  getMcpService(): McpService {
    if (!this.mcpService) {
      throw new Error("MCP service is not configured.");
    }

    return this.mcpService;
  }

  async getUserTimezone(): Promise<string> {
    return this.userConfig?.timezone ?? loadUserTimezone();
  }

  getUserConfig(): UserConfig | null {
    return this.userConfig;
  }

  async getUserConfigForOrg(orgId: string): Promise<UserConfig | null> {
    return this.getOrgUserConfig(orgId);
  }

  async getOrgTimezone(orgId: string): Promise<string> {
    return (await this.getOrgUserConfig(orgId))?.timezone ?? DEFAULT_TIMEZONE;
  }

  async setOrgTimezone(
    orgId: string,
    timezone: string | undefined
  ): Promise<string> {
    const trimmed = timezone?.trim() ?? "";
    if (!trimmed) {
      throw new AtlasApiError("Timezone is required.", 400);
    }
    if (!isValidTimezone(trimmed)) {
      throw new AtlasApiError(`Invalid timezone: ${trimmed}`, 400);
    }

    return this.runSerializedOrgConfigMutation(orgId, async () => {
      const config = await this.getOrgConfigForUpdate(orgId);
      await this.saveOrgUserConfig(orgId, { ...config, timezone: trimmed });
      return trimmed;
    });
  }

  async getOrgThinkingSettings(
    orgId: string
  ): Promise<ThinkingSettingsResponse> {
    const config = await this.getOrgUserConfig(orgId);
    return {
      thinking: {
        effort: config?.thinkingEffort ?? DEFAULT_THINKING_EFFORT,
        enabled: config?.thinkingEnabled ?? DEFAULT_THINKING_ENABLED,
      },
    };
  }

  async setOrgThinkingSettings(
    orgId: string,
    input: UpdateThinkingRequest
  ): Promise<ThinkingSettingsResponse> {
    return this.runSerializedOrgConfigMutation(orgId, async () => {
      const config = await this.getOrgConfigForUpdate(orgId);
      const thinking = {
        effort:
          input.effort ?? config.thinkingEffort ?? DEFAULT_THINKING_EFFORT,
        enabled: input.enabled,
      };
      await this.saveOrgUserConfig(orgId, {
        ...config,
        thinkingEffort: thinking.effort,
        thinkingEnabled: thinking.enabled,
      });
      return { thinking };
    });
  }

  getCapabilityCatalog(): CapabilityCatalogResponse {
    return {
      capabilities: this.providerAdapterRegistry
        .listCapabilityDefinitions()
        .map((definition) => ({
          description: definition.description,
          id: definition.id,
          label: definition.label,
          routable: definition.routable,
        })),
      providers: this.providerAdapterRegistry.list().map((adapter) => ({
        capabilities: Object.entries(adapter.manifest.capabilities).map(
          ([capabilityId, entry]) => ({
            capabilityId,
            implementationAvailable:
              entry.implementation.status === "available",
            nativeStatus: entry.native.status,
          })
        ),
        displayName: adapter.manifest.provider.displayName,
        id: adapter.manifest.provider.id,
        models: adapter.manifest.models ?? [],
      })),
      schemaVersion: 1,
    };
  }

  async getOrgCapabilityMappings(
    orgId: string
  ): Promise<CapabilityMappingsResponse> {
    const config = await this.getOrgUserConfig(orgId);
    return {
      config: migrateLegacyCapabilityConfig(
        {
          imageModel: config?.imageModel,
          transcriptionModel: config?.transcriptionModel,
          visionModel: config?.visionModel,
        },
        config?.capabilityConfig
      ),
    };
  }

  async getOrgCapabilityOptions(
    orgId: string
  ): Promise<CapabilityOptionsResponse> {
    let config = await this.getOrgUserConfig(orgId);
    config = await this.refreshSubscriptionModelSnapshots(orgId, config);
    const providers = config?.providers ?? [];
    const capabilityConfig = migrateCapabilityTargetProviderIds(
      migrateLegacyCapabilityConfig(
        {
          imageModel: config?.imageModel,
          transcriptionModel: config?.transcriptionModel,
          visionModel: config?.visionModel,
        },
        config?.capabilityConfig
      ),
      providers,
      config?.defaultProviderId
    );
    const options: CapabilityOptionsResponse["options"] = [];

    for (const definition of this.providerAdapterRegistry.listCapabilityDefinitions()) {
      if (!definition.routable) {
        continue;
      }
      const binding = capabilityConfig.bindings[definition.id];
      const configuredTargets = binding
        ? [...(binding.primary ? [binding.primary] : []), ...binding.fallbacks]
        : [];

      for (const instance of providers) {
        const adapter = this.providerAdapterRegistry.get(instance.type);
        if (!adapter) {
          continue;
        }
        const manifestEntry = adapter.manifest.capabilities[definition.id];
        const modelNames = new Map<string, string>();
        const providerModels = getModelsForProviderInstance(instance);
        const providerModelsById = new Map(
          providerModels.map((model) => [model.id, model])
        );

        if (
          manifestEntry?.modelDefault.status === "supported" ||
          instance.capabilityOverrides?.[definition.id]?.status === "supported"
        ) {
          for (const model of providerModels) {
            modelNames.set(model.id, model.name);
          }
        }

        for (const model of providerModels) {
          if (model.capabilities?.[definition.id]) {
            modelNames.set(model.id, model.name);
          }
        }

        for (const model of adapter.manifest.models ?? []) {
          if (model.capabilities[definition.id]) {
            modelNames.set(model.id, model.name ?? model.id);
          }
        }

        for (const model of instance.customModels ?? []) {
          if (model.capabilities?.[definition.id]) {
            modelNames.set(model.id, model.name ?? model.id);
          }
        }

        for (const target of configuredTargets) {
          if (target.providerId === instance.id) {
            modelNames.set(target.modelId, target.modelId);
          }
        }

        for (const [modelId, modelName] of modelNames) {
          const modelClaim =
            providerModelsById.get(modelId)?.capabilities?.[definition.id];
          const effective = evaluateCapabilityTarget(
            {
              capabilityId: definition.id,
              config,
              readApiKey: (provider) =>
                readApiKeyForInstance(provider, process.env),
              registry: this.providerAdapterRegistry,
            },
            { modelId, providerId: instance.id },
            modelClaim ? [modelClaim] : []
          );
          options.push({
            capabilityId: definition.id,
            effective: {
              availability: effective.availability,
              capabilityId: definition.id,
              ...(effective.claim.constraints
                ? { constraints: effective.claim.constraints }
                : {}),
              reasons: effective.reasons,
              selectable: effective.selectable,
              source: effective.claim.source,
              status: effective.claim.status,
              verified: effective.claim.verified === true,
            },
            modelId,
            modelName,
            providerId: instance.id,
            providerLabel: instance.label,
            providerType: instance.type,
          });
        }
      }
    }

    return { options, schemaVersion: 1 };
  }

  async setOrgCapabilityMapping(
    orgId: string,
    capabilityId: string,
    input: UpdateCapabilityMappingRequest
  ): Promise<UpdateCapabilityMappingResponse> {
    const normalizedCapabilityId = capabilityId.trim();
    const definition = this.providerAdapterRegistry.getCapabilityDefinition(
      normalizedCapabilityId
    );
    if (!definition?.routable) {
      throw new AtlasApiError(
        `Capability "${normalizedCapabilityId}" is not configurable.`,
        400
      );
    }

    return this.runSerializedOrgConfigMutation(orgId, async () => {
      const config = await this.getOrgConfigForUpdate(orgId);
      const existing = migrateLegacyCapabilityConfig(
        {
          imageModel: config.imageModel,
          transcriptionModel: config.transcriptionModel,
          visionModel: config.visionModel,
        },
        config.capabilityConfig
      );
      const capabilityConfig = migrateCapabilityTargetProviderIds(
        validateCapabilityConfig({
          bindings: {
            ...existing.bindings,
            [normalizedCapabilityId]: input.binding,
          },
          schemaVersion: 1,
        }),
        config.providers,
        config.defaultProviderId
      );

      if (input.binding.enabled) {
        resolveConfiguredCapability({
          capabilityId: normalizedCapabilityId,
          config: { ...config, capabilityConfig },
          readApiKey: (instance) =>
            readApiKeyForInstance(instance, process.env),
          registry: this.providerAdapterRegistry,
        });
      }

      await this.saveOrgUserConfig(orgId, {
        ...config,
        ...legacyCapabilitySelectionPatch(
          normalizedCapabilityId,
          capabilityConfig.bindings[normalizedCapabilityId]?.primary ?? null
        ),
        capabilityConfig,
      });
      return { capabilityId: normalizedCapabilityId, config: capabilityConfig };
    });
  }

  async getOrgVisionSettings(orgId: string): Promise<VisionSettingsResponse> {
    const config = await this.getOrgUserConfig(orgId);
    return {
      vision: {
        model: capabilitySelectionForLegacyApi(
          config,
          PROVIDER_CAPABILITY_IDS.imageUnderstanding
        ),
      },
    };
  }

  async setOrgVisionSettings(
    orgId: string,
    input: UpdateVisionRequest
  ): Promise<VisionSettingsResponse> {
    const model = input.model?.trim() || null;
    await this.setOrgCapabilityMapping(
      orgId,
      PROVIDER_CAPABILITY_IDS.imageUnderstanding,
      capabilityMappingRequestFromLegacySelection(model)
    );
    return { vision: { model } };
  }

  async getOrgTranscriptionSettings(
    orgId: string
  ): Promise<TranscriptionSettingsResponse> {
    const config = await this.getOrgUserConfig(orgId);
    return {
      transcription: {
        model: capabilitySelectionForLegacyApi(
          config,
          PROVIDER_CAPABILITY_IDS.audioTranscription
        ),
      },
    };
  }

  async setOrgTranscriptionSettings(
    orgId: string,
    input: UpdateTranscriptionRequest
  ): Promise<TranscriptionSettingsResponse> {
    const model = input.model?.trim() || null;
    await this.setOrgCapabilityMapping(
      orgId,
      PROVIDER_CAPABILITY_IDS.audioTranscription,
      capabilityMappingRequestFromLegacySelection(model)
    );
    return { transcription: { model } };
  }

  async getOrgImageGenerationSettings(
    orgId: string
  ): Promise<ImageGenerationSettingsResponse> {
    const config = await this.getOrgUserConfig(orgId);
    return {
      imageGeneration: {
        model: capabilitySelectionForLegacyApi(
          config,
          PROVIDER_CAPABILITY_IDS.imageGeneration
        ),
      },
    };
  }

  async setOrgImageGenerationSettings(
    orgId: string,
    input: UpdateImageGenerationRequest
  ): Promise<ImageGenerationSettingsResponse> {
    const model = input.model?.trim() || null;
    await this.setOrgCapabilityMapping(
      orgId,
      PROVIDER_CAPABILITY_IDS.imageGeneration,
      capabilityMappingRequestFromLegacySelection(model)
    );
    return { imageGeneration: { model } };
  }

  async transcribeAudioForOrg(
    orgId: string,
    input: TranscribeAudioRequest,
    attribution?: {
      allowPersistedSessionPrincipal?: boolean;
      expectedChannel?: AgentChannel;
      userId?: string | null;
    }
  ): Promise<TranscribeAudioResponse> {
    const config = await this.getOrgUserConfig(orgId);
    const resolvedAttribution = await this.resolveCapabilityAttribution(
      orgId,
      input.sessionId,
      attribution
    );
    return this.transcribeAudioWithConfig(input, config, {
      channel: resolvedAttribution.channel,
      orgId,
      profileId: resolvedAttribution.profileId,
      userId: resolvedAttribution.userId,
    });
  }

  async generateImageForOrg(
    orgId: string,
    input: GenerateImageRequest,
    attribution?: {
      allowPersistedSessionPrincipal?: boolean;
      expectedChannel?: AgentChannel;
      userId?: string | null;
    }
  ): Promise<GenerateImageResponse> {
    const config = await this.getOrgUserConfig(orgId);
    const resolvedAttribution = await this.resolveCapabilityAttribution(
      orgId,
      input.sessionId,
      attribution
    );
    return this.generateImageWithConfig(input, config, orgId, {
      channel: resolvedAttribution.channel,
      profileId: resolvedAttribution.profileId,
      userId: resolvedAttribution.userId,
    });
  }

  async setUserTimezone(timezone: string | undefined): Promise<string> {
    const saved = await saveUserTimezone(timezone);

    if (this.userConfig) {
      this.userConfig = { ...this.userConfig, timezone: saved };
    }

    return saved;
  }

  async getThinkingSettings(): Promise<ThinkingSettingsResponse> {
    const thinking = await this.resolveThinkingSettings();
    return { thinking };
  }

  async setThinkingSettings(
    input: UpdateThinkingRequest
  ): Promise<ThinkingSettingsResponse> {
    const effort =
      input.effort ?? (await this.resolveThinkingSettings()).effort;
    const thinking: ThinkingSettings = {
      effort,
      enabled: input.enabled,
    };

    await saveUserThinkingSettings(thinking);

    if (this.userConfig) {
      this.userConfig = {
        ...this.userConfig,
        thinkingEffort: thinking.effort,
        thinkingEnabled: thinking.enabled,
      };
    }

    this.sessions.clear();

    return { thinking };
  }

  async getVisionSettings(): Promise<VisionSettingsResponse> {
    await this.ensureVisionSettingsLoaded();
    const vision = await this.resolveVisionSettings();
    return { vision };
  }

  async setVisionSettings(
    input: UpdateVisionRequest
  ): Promise<VisionSettingsResponse> {
    await this.ensureVisionSettingsLoaded();
    const model = input.model?.trim() || null;
    const nextConfig = withLegacyCapabilitySelection(
      this.userConfig,
      PROVIDER_CAPABILITY_IDS.imageUnderstanding,
      model
    );
    if (model) {
      resolveConfiguredCapability({
        capabilityId: PROVIDER_CAPABILITY_IDS.imageUnderstanding,
        config: nextConfig,
        readApiKey: (instance) => readApiKeyForInstance(instance, process.env),
        registry: this.providerAdapterRegistry,
      });
    }

    const vision: VisionSettings = { model };
    const existing = await this.db.getWorkspaceSettings();
    await this.db.upsertWorkspaceSettings(
      mergeWorkspaceSettings(existing, {
        id: WORKSPACE_SETTINGS_ID,
        imageModel: existing?.imageModel ?? this.userConfig?.imageModel ?? null,
        transcriptionModel:
          existing?.transcriptionModel ??
          this.userConfig?.transcriptionModel ??
          null,
        updatedAt: new Date().toISOString(),
        visionModel: model,
      })
    );

    this.userConfig = nextConfig;

    this.sessions.clear();

    return { vision };
  }

  async getTranscriptionSettings(): Promise<TranscriptionSettingsResponse> {
    await this.ensureTranscriptionSettingsLoaded();
    const transcription = await this.resolveTranscriptionSettings();
    return { transcription };
  }

  async setTranscriptionSettings(
    input: UpdateTranscriptionRequest
  ): Promise<TranscriptionSettingsResponse> {
    await this.ensureTranscriptionSettingsLoaded();
    const model = input.model?.trim() || null;
    const nextConfig = withLegacyCapabilitySelection(
      this.userConfig,
      PROVIDER_CAPABILITY_IDS.audioTranscription,
      model
    );
    if (model) {
      resolveConfiguredCapability({
        capabilityId: PROVIDER_CAPABILITY_IDS.audioTranscription,
        config: nextConfig,
        readApiKey: (instance) => readApiKeyForInstance(instance, process.env),
        registry: this.providerAdapterRegistry,
      });
    }

    const transcription: TranscriptionSettings = { model };
    const existing = await this.db.getWorkspaceSettings();
    await this.db.upsertWorkspaceSettings(
      mergeWorkspaceSettings(existing, {
        id: WORKSPACE_SETTINGS_ID,
        imageModel: existing?.imageModel ?? this.userConfig?.imageModel ?? null,
        transcriptionModel: model,
        updatedAt: new Date().toISOString(),
        visionModel:
          existing?.visionModel ?? this.userConfig?.visionModel ?? null,
      })
    );

    this.userConfig = nextConfig;

    return { transcription };
  }

  async transcribeAudio(
    input: TranscribeAudioRequest
  ): Promise<TranscribeAudioResponse> {
    await this.ensureTranscriptionSettingsLoaded();

    const data = input.data?.trim();
    const mediaType = input.mediaType?.trim();

    if (!(data && mediaType)) {
      throw new AtlasApiError("Audio data and media type are required.", 400);
    }

    const bytes = decodeAudioTranscriptionData(data);

    const selection = resolveTranscriptionProviderSelection(
      this.userConfig,
      process.env,
      this.providerAdapterRegistry
    );

    if (!selection) {
      throw new AtlasApiError(TRANSCRIPTION_MODEL_REQUIRED_MESSAGE, 400);
    }

    const text = await transcribeAudio(
      selection.instance,
      selection.model,
      {
        bytes,
        filename: input.filename?.trim() || "audio.ogg",
        mediaType,
      },
      process.env,
      this.providerAdapterRegistry
    );

    return { text };
  }

  async ensureTranscriptionSettingsLoaded(): Promise<void> {
    if (!this.transcriptionSettingsPromise) {
      this.transcriptionSettingsPromise =
        this.loadTranscriptionSettingsFromDatabase();
    }

    await this.transcriptionSettingsPromise;
  }

  private async loadTranscriptionSettingsFromDatabase(): Promise<void> {
    const stored = await this.db.getWorkspaceSettings();

    if (stored) {
      if (this.userConfig) {
        this.userConfig = {
          ...this.userConfig,
          imageModel: stored.imageModel ?? this.userConfig.imageModel,
          transcriptionModel: stored.transcriptionModel,
          visionModel: stored.visionModel ?? this.userConfig.visionModel,
        };
      }
      return;
    }

    const legacyModel =
      this.userConfig?.transcriptionModel ??
      (await loadUserTranscriptionSettings()).model ??
      null;

    await this.db.upsertWorkspaceSettings(
      mergeWorkspaceSettings(null, {
        id: WORKSPACE_SETTINGS_ID,
        imageModel: this.userConfig?.imageModel ?? null,
        transcriptionModel: legacyModel,
        updatedAt: new Date().toISOString(),
        visionModel: this.userConfig?.visionModel ?? null,
      })
    );

    if (this.userConfig) {
      this.userConfig = { ...this.userConfig, transcriptionModel: legacyModel };
    }
  }

  private async resolveTranscriptionSettings(): Promise<TranscriptionSettings> {
    return { model: this.userConfig?.transcriptionModel ?? null };
  }

  async getImageGenerationSettings(): Promise<ImageGenerationSettingsResponse> {
    await this.ensureImageGenerationSettingsLoaded();
    const imageGeneration = await this.resolveImageGenerationSettings();
    return { imageGeneration };
  }

  async setImageGenerationSettings(
    input: UpdateImageGenerationRequest
  ): Promise<ImageGenerationSettingsResponse> {
    await this.ensureImageGenerationSettingsLoaded();
    const model = input.model?.trim() || null;
    const nextConfig = withLegacyCapabilitySelection(
      this.userConfig,
      PROVIDER_CAPABILITY_IDS.imageGeneration,
      model
    );
    if (model) {
      resolveConfiguredCapability({
        capabilityId: PROVIDER_CAPABILITY_IDS.imageGeneration,
        config: nextConfig,
        readApiKey: (instance) => readApiKeyForInstance(instance, process.env),
        registry: this.providerAdapterRegistry,
      });
    }

    const imageGeneration: ImageGenerationSettings = { model };
    const existing = await this.db.getWorkspaceSettings();
    await this.db.upsertWorkspaceSettings(
      mergeWorkspaceSettings(existing, {
        id: WORKSPACE_SETTINGS_ID,
        imageModel: model,
        transcriptionModel:
          existing?.transcriptionModel ??
          this.userConfig?.transcriptionModel ??
          null,
        updatedAt: new Date().toISOString(),
        visionModel:
          existing?.visionModel ?? this.userConfig?.visionModel ?? null,
      })
    );

    this.userConfig = nextConfig;

    return { imageGeneration };
  }

  async generateImage(
    input: GenerateImageRequest
  ): Promise<GenerateImageResponse> {
    await this.ensureImageGenerationSettingsLoaded();

    const prompt = input.prompt?.trim();
    if (!prompt) {
      throw new AtlasApiError("Image prompt is required.", 400);
    }

    const selection = resolveImageGenerationSelection(this.userConfig, {
      registry: this.providerAdapterRegistry,
    });

    if (!selection) {
      throw new AtlasApiError(IMAGE_MODEL_REQUIRED_MESSAGE, 400);
    }

    const result = await generateImage(
      selection,
      {
        prompt,
        size: input.size,
      },
      this.providerAdapterRegistry
    );

    const usage = result.usage ?? {
      inputTokens: 0,
      outputTokens: 0,
    };
    this.llmUsageTracker?.record(
      result.model,
      usage.inputTokens,
      usage.outputTokens,
      {
        provider: selection.instance.type,
        providerInstance: selection.instance,
      }
    );

    return {
      data: Buffer.from(result.data).toString("base64"),
      mediaType: result.mediaType,
      model: result.model,
      size: result.size,
      sizeBytes: result.data.byteLength,
      ...(result.revisedPrompt ? { revisedPrompt: result.revisedPrompt } : {}),
    };
  }

  async ensureImageGenerationSettingsLoaded(): Promise<void> {
    if (!this.imageGenerationSettingsPromise) {
      this.imageGenerationSettingsPromise =
        this.loadImageGenerationSettingsFromDatabase();
    }

    await this.imageGenerationSettingsPromise;
  }

  private async loadImageGenerationSettingsFromDatabase(): Promise<void> {
    const stored = await this.db.getWorkspaceSettings();

    if (stored) {
      if (this.userConfig) {
        this.userConfig = {
          ...this.userConfig,
          imageModel: stored.imageModel,
          transcriptionModel:
            stored.transcriptionModel ?? this.userConfig.transcriptionModel,
          visionModel: stored.visionModel ?? this.userConfig.visionModel,
        };
      }
      return;
    }

    const legacyModel = this.userConfig?.imageModel ?? null;

    await this.db.upsertWorkspaceSettings(
      mergeWorkspaceSettings(null, {
        id: WORKSPACE_SETTINGS_ID,
        imageModel: legacyModel,
        transcriptionModel: this.userConfig?.transcriptionModel ?? null,
        updatedAt: new Date().toISOString(),
        visionModel: this.userConfig?.visionModel ?? null,
      })
    );

    if (this.userConfig) {
      this.userConfig = { ...this.userConfig, imageModel: legacyModel };
    }
  }

  private async resolveImageGenerationSettings(): Promise<ImageGenerationSettings> {
    return { model: this.userConfig?.imageModel ?? null };
  }

  async ensureProviderSettingsLoaded(): Promise<void> {
    if (!this.providerSettingsPromise) {
      this.providerSettingsPromise = this.loadProviderSettings();
    }

    await this.providerSettingsPromise;
  }

  private async loadProviderSettings(): Promise<void> {
    if (this._providerConfigured) {
      return;
    }

    this._providerConfigured = await this.checkAnyProviderConfigured();
  }

  private async checkAnyProviderConfigured(): Promise<boolean> {
    if (isProviderConfigured(this.userConfig)) {
      return true;
    }

    for (const config of this.orgUserConfigs.values()) {
      if (isProviderConfigured(config)) {
        return true;
      }
    }

    const organizations = (await this.db.listOrganizations()).filter(
      (organization) => !organization.archivedAt
    );
    for (const org of organizations) {
      const config = await this.getOrgUserConfig(org.id);
      if (isProviderConfigured(config)) {
        return true;
      }
    }

    return false;
  }

  async ensureVisionSettingsLoaded(): Promise<void> {
    if (!this.visionSettingsPromise) {
      this.visionSettingsPromise = this.loadVisionSettingsFromDatabase();
    }

    await this.visionSettingsPromise;
  }

  private async loadVisionSettingsFromDatabase(): Promise<void> {
    const stored = await this.db.getWorkspaceSettings();

    if (stored) {
      if (this.userConfig) {
        this.userConfig = {
          ...this.userConfig,
          imageModel: stored.imageModel,
          transcriptionModel: stored.transcriptionModel,
          visionModel: stored.visionModel,
        };
      }
      return;
    }

    const legacyVisionModel =
      this.userConfig?.visionModel ??
      (await loadUserVisionSettings()).model ??
      null;
    const legacyTranscriptionModel =
      this.userConfig?.transcriptionModel ??
      (await loadUserTranscriptionSettings()).model ??
      null;
    const legacyImageModel = this.userConfig?.imageModel ?? null;

    await this.db.upsertWorkspaceSettings(
      mergeWorkspaceSettings(null, {
        id: WORKSPACE_SETTINGS_ID,
        imageModel: legacyImageModel,
        transcriptionModel: legacyTranscriptionModel,
        updatedAt: new Date().toISOString(),
        visionModel: legacyVisionModel,
      })
    );

    if (this.userConfig) {
      this.userConfig = {
        ...this.userConfig,
        imageModel: legacyImageModel,
        transcriptionModel: legacyTranscriptionModel,
        visionModel: legacyVisionModel,
      };
    }
  }

  private async resolveVisionSettings(): Promise<VisionSettings> {
    return { model: this.userConfig?.visionModel ?? null };
  }

  private async resolveThinkingSettings(): Promise<ThinkingSettings> {
    if (
      this.userConfig?.thinkingEnabled !== undefined ||
      this.userConfig?.thinkingEffort !== undefined
    ) {
      return {
        effort: this.userConfig.thinkingEffort ?? "medium",
        enabled: this.userConfig.thinkingEnabled ?? true,
      };
    }

    return loadUserThinkingSettings();
  }

  private resolveChatProviderOptions(
    providerInstance: ReturnType<typeof getActiveProviderInstance>,
    thinkingSettings: ThinkingSettings,
    modelId?: string | null,
    overrides?: Partial<ProviderChatOptions>
  ): ProviderChatOptions | undefined {
    const model =
      providerInstance && modelId
        ? getModelsForProviderInstance(providerInstance).find(
            (entry) => entry.id === modelId
          )
        : undefined;
    const effort = resolveThinkingEffort(
      thinkingSettings.effort,
      model?.reasoningEffortValues,
      model?.defaultReasoningEffort
    );
    const thinking = {
      enabled: thinkingSettings.enabled,
      ...(effort ? { effort } : {}),
    };
    const webSearch = overrides?.webSearch;
    const mergedThinking = overrides?.thinking ?? thinking;

    if (!(webSearch || mergedThinking)) {
      return;
    }

    return {
      ...(webSearch ? { webSearch } : {}),
      ...(mergedThinking ? { thinking: mergedThinking } : {}),
    };
  }

  async getTelegramSettings(orgId: string): Promise<TelegramSettingsResponse> {
    await this.ensureLegacyChannelMigrated("telegram", orgId);
    return loadTelegramSettingsPublic(orgId);
  }

  async setTelegramSettings(
    orgId: string,
    input: UpdateTelegramSettingsRequest
  ): Promise<TelegramSettingsResponse> {
    await this.ensureLegacyChannelMigrated("telegram", orgId);
    const existing = await loadTelegramSettingsPublic(orgId);
    const botToken =
      input.botToken !== undefined && input.botToken.trim()
        ? input.botToken.trim()
        : undefined;

    if (!(botToken || existing.configured)) {
      throw new Error("Bot token is required.");
    }

    // Reject typo'd tokens at save time instead of letting the bridge crash
    // silently after the UI already reported success.
    if (botToken) {
      let verification: Response;
      try {
        const requestPath = [`bot${botToken}`, "getMe"]
          .map(encodeURIComponent)
          .join("/");
        verification = await fetch(`https://api.telegram.org/${requestPath}`, {
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        throw new AtlasApiError(
          "Could not reach Telegram to verify the bot token. Check your network and try again.",
          502
        );
      }

      if (!verification.ok) {
        throw new AtlasApiError(
          `Telegram rejected this bot token (${verification.status}). Paste a fresh token from @BotFather.`,
          400
        );
      }

      let payload: { ok?: boolean; result?: { is_bot?: boolean } };
      try {
        payload = (await verification.json()) as typeof payload;
      } catch {
        throw new AtlasApiError(
          "Telegram returned an invalid token-verification response.",
          502
        );
      }

      if (!(payload.ok === true && payload.result?.is_bot === true)) {
        throw new AtlasApiError("Telegram rejected this bot token.", 400);
      }

      if (await telegramBotTokenUsedByAnotherWorkspace(orgId, botToken)) {
        throw new AtlasApiError(TELEGRAM_BOT_TOKEN_IN_USE_MESSAGE, 409);
      }
    }

    const profileId = input.profileId?.trim();
    let resolvedProfileId = profileId;
    if (profileId) {
      const profile = await this.requireProfile(orgId, profileId);
      resolvedProfileId = profile.id;
    }

    if (input.accessMode && input.accessMode !== existing.accessMode) {
      console.log(
        JSON.stringify({
          action: "channel_access_mode_changed",
          channel: "telegram",
          nextMode: input.accessMode,
          orgId,
          previousMode: existing.accessMode,
          timestamp: new Date().toISOString(),
        })
      );
    }

    return saveTelegramConfig(
      {
        ...(input.accessMode === undefined
          ? {}
          : { accessMode: input.accessMode }),
        ...(botToken ? { botToken } : {}),
        ...(input.allowedUserIds === undefined
          ? existing.allowedUserIds.length > 0
            ? { allowedUserIds: existing.allowedUserIds.join(",") }
            : {}
          : { allowedUserIds: input.allowedUserIds }),
        ...(input.blockedUserIds === undefined
          ? existing.blockedUserIds.length > 0
            ? { blockedUserIds: existing.blockedUserIds.join(",") }
            : {}
          : { blockedUserIds: input.blockedUserIds }),
        ...(input.profileId === undefined
          ? {}
          : { profileId: resolvedProfileId }),
      },
      orgId
    );
  }

  async regenerateTelegramHandshake(
    orgId: string,
    handshakeUserId: string
  ): Promise<TelegramSettingsResponse> {
    await this.ensureLegacyChannelMigrated("telegram", orgId);
    const pairingAssertion = await this.identityService.issuePairingAssertion({
      channel: "telegram",
      orgId,
      userId: handshakeUserId,
    });
    return regenerateTelegramHandshake(
      orgId,
      handshakeUserId,
      pairingAssertion
    );
  }

  async getDiscordSettings(orgId: string): Promise<DiscordSettingsResponse> {
    await this.ensureLegacyChannelMigrated("discord", orgId);
    return loadDiscordSettingsPublic(orgId);
  }

  async setDiscordSettings(
    orgId: string,
    input: UpdateDiscordSettingsRequest
  ): Promise<DiscordSettingsResponse> {
    await this.ensureLegacyChannelMigrated("discord", orgId);
    const existing = await loadDiscordSettingsPublic(orgId);
    const botToken =
      input.botToken !== undefined && input.botToken.trim()
        ? input.botToken.trim()
        : undefined;

    if (!(botToken || existing.configured)) {
      throw new Error("Bot token is required.");
    }

    if (
      botToken &&
      !(await resolveDiscordApplicationId(botToken, { forceRefresh: true }))
    ) {
      throw new AtlasApiError("Discord bot token could not be validated.", 400);
    }

    if (
      botToken &&
      (await discordBotTokenUsedByAnotherWorkspace(orgId, botToken))
    ) {
      throw new AtlasApiError(DISCORD_BOT_TOKEN_IN_USE_MESSAGE, 409);
    }

    const profileId = input.profileId?.trim();
    let resolvedProfileId = profileId;
    if (profileId) {
      const profile = await this.requireProfile(orgId, profileId);
      resolvedProfileId = profile.id;
    }

    if (input.accessMode && input.accessMode !== existing.accessMode) {
      console.log(
        JSON.stringify({
          action: "channel_access_mode_changed",
          channel: "discord",
          nextMode: input.accessMode,
          orgId,
          previousMode: existing.accessMode,
          timestamp: new Date().toISOString(),
        })
      );
    }

    return saveDiscordConfig(
      {
        ...(input.accessMode === undefined
          ? {}
          : { accessMode: input.accessMode }),
        ...(botToken ? { botToken } : {}),
        ...(input.allowedUserIds === undefined
          ? existing.allowedUserIds.length > 0
            ? { allowedUserIds: existing.allowedUserIds.join(",") }
            : {}
          : { allowedUserIds: input.allowedUserIds }),
        ...(input.blockedUserIds === undefined
          ? existing.blockedUserIds.length > 0
            ? { blockedUserIds: existing.blockedUserIds.join(",") }
            : {}
          : { blockedUserIds: input.blockedUserIds }),
        ...(input.profileId === undefined
          ? {}
          : { profileId: resolvedProfileId }),
      },
      orgId
    );
  }

  async regenerateDiscordHandshake(
    orgId: string,
    handshakeUserId: string
  ): Promise<DiscordSettingsResponse> {
    await this.ensureLegacyChannelMigrated("discord", orgId);
    const pairingAssertion = await this.identityService.issuePairingAssertion({
      channel: "discord",
      orgId,
      userId: handshakeUserId,
    });
    return regenerateDiscordHandshake(orgId, handshakeUserId, pairingAssertion);
  }

  async getComposioSettings(): Promise<ComposioSettingsResponse> {
    const settings = await loadComposioSettingsPublic();
    return {
      ...settings,
      composioReachable: settings.configured
        ? await (this.composioService?.isReachable() ?? false)
        : false,
    };
  }

  async setComposioSettings(
    input: UpdateComposioSettingsRequest
  ): Promise<ComposioSettingsResponse> {
    const existing = await loadComposioSettingsPublic();
    const apiKey =
      input.apiKey !== undefined && input.apiKey.trim()
        ? input.apiKey.trim()
        : undefined;

    if (!(apiKey || existing.configured)) {
      throw new Error("Composio API key is required.");
    }

    if (apiKey) {
      await this.composioService?.validateConfiguration(apiKey);
      await saveComposioConfig({ apiKey });
      this.composioService?.reloadConfiguration();
    }

    return this.getComposioSettings();
  }

  async getErrorTrackingSettings(): Promise<ErrorTrackingSettingsResponse> {
    return loadErrorTrackingSettingsPublic();
  }

  async setErrorTrackingSettings(
    input: UpdateErrorTrackingSettingsRequest
  ): Promise<ErrorTrackingSettingsResponse> {
    const dsn = input.dsn?.trim() ?? "";

    if (dsn && !parseSentryDsn(dsn)) {
      throw new AtlasApiError(
        "That does not look like a Sentry-compatible DSN.",
        400
      );
    }

    await saveErrorTrackingDsn(dsn || null);
    await refreshErrorTrackingEnabled();
    return this.getErrorTrackingSettings();
  }

  /** Sends a test directly so a failed test never enters the crash retry queue. */
  async sendErrorTrackingTest(): Promise<SendErrorTrackingTestResponse> {
    const { configured } = await loadErrorTrackingSettingsPublic();

    if (!configured) {
      throw new AtlasApiError("Save a DSN first.", 400);
    }

    const delivered = await createErrorTrackingSink()(
      buildErrorReport(new Error("Test event from Atlas"), {
        kind: "test",
        source: "settings",
      })
    );

    return { delivered };
  }

  async getEmailSettings(): Promise<EmailSettingsResponse> {
    return loadEmailSettingsPublic();
  }

  async setEmailSettings(
    input: UpdateEmailSettingsRequest
  ): Promise<EmailSettingsResponse> {
    return saveEmailConfig(input);
  }

  async sendEmailTest(recipient: string): Promise<SendEmailTestResponse> {
    const config = await loadEmailConfig();

    if (!isEmailConfigComplete(config)) {
      throw new Error("Complete email settings before sending a test message.");
    }

    const to = recipient.trim();

    if (!to) {
      throw new Error("Recipient email is required.");
    }

    const sender = createSmtpSender(emailConfigToMailboxConfig(config!));
    const result = await sender.send({
      subject: "Atlas test email",
      text: "This is a test email from your Atlas deployment.",
      to,
    });

    return {
      messageId: result.messageId,
      ok: true,
      to,
    };
  }

  async getAgentBrowserStatus(): Promise<AgentBrowserStatusResponse> {
    return getAgentBrowserStatus();
  }

  async getWhatsAppSettings(orgId: string): Promise<WhatsAppSettingsResponse> {
    await this.ensureLegacyChannelMigrated("whatsapp", orgId);
    return loadWhatsAppSettingsPublic(orgId);
  }

  async setWhatsAppSettings(
    orgId: string,
    input: UpdateWhatsAppSettingsRequest
  ): Promise<WhatsAppSettingsResponse> {
    await this.ensureLegacyChannelMigrated("whatsapp", orgId);
    const existing = await loadWhatsAppSettingsPublic(orgId);
    const profileId = input.profileId?.trim();
    let resolvedProfileId = profileId;
    if (profileId) {
      const profile = await this.requireProfile(orgId, profileId);
      resolvedProfileId = profile.id;
    }

    const nextPhoneNumber = input.phoneNumber?.trim();
    if (
      nextPhoneNumber &&
      (await whatsAppPhoneUsedByAnotherWorkspace(orgId, nextPhoneNumber))
    ) {
      throw new AtlasApiError(WHATSAPP_PHONE_IN_USE_MESSAGE, 409);
    }

    if (input.accessMode && input.accessMode !== existing.accessMode) {
      console.log(
        JSON.stringify({
          action: "channel_access_mode_changed",
          channel: "whatsapp",
          nextMode: input.accessMode,
          orgId,
          previousMode: existing.accessMode,
          timestamp: new Date().toISOString(),
        })
      );
    }

    return saveWhatsAppConfig(
      {
        ...(input.accessMode === undefined
          ? {}
          : { accessMode: input.accessMode }),
        ...(input.allowedNumbers === undefined
          ? {}
          : { allowedNumbers: input.allowedNumbers }),
        ...(input.blockedNumbers === undefined
          ? {}
          : { blockedNumbers: input.blockedNumbers }),
        ...(input.phoneNumber === undefined
          ? {}
          : { phoneNumber: input.phoneNumber.trim() }),
        ...(input.profileId === undefined
          ? {}
          : { profileId: resolvedProfileId }),
      },
      orgId
    );
  }

  async regenerateWhatsAppPairingCode(
    orgId: string,
    pairingUserId: string
  ): Promise<WhatsAppSettingsResponse> {
    await this.ensureLegacyChannelMigrated("whatsapp", orgId);
    const pairingAssertion = await this.identityService.issuePairingAssertion({
      channel: "whatsapp",
      orgId,
      userId: pairingUserId,
    });
    return regenerateWhatsAppPairingCode(
      orgId,
      pairingUserId,
      pairingAssertion
    );
  }

  async runAutomationPrompt(
    orgId: string,
    profileId: string,
    prompt: string,
    automationId?: string,
    automationRunId?: string,
    principal?: CanonicalPrincipal
  ): Promise<string> {
    const actor = runAsPrincipal(principal, (value) => value);
    if (actor.orgId !== orgId) {
      throw new AtlasApiError(
        "Automation principal belongs to another workspace.",
        403
      );
    }
    const userConfig = await this.getOrgUserConfig(orgId);
    const toolConfigurationVersion =
      this.sessionInvalidationVersions.get(orgId) ?? 0;
    if (!isProviderConfigured(userConfig)) {
      throw new Error("Provider is not configured.");
    }

    const profile = await this.requireProfile(orgId, profileId);
    const beforeToolCall = this.createToolExecutionGuard(
      orgId,
      profile.id,
      toolConfigurationVersion,
      actor
    );
    await beforeToolCall();
    const profileTools = await this.resolveProfileTools(
      profile,
      {
        includeAutomationTools: false,
        includeTodoTools: false,
        userId: actor.userId,
      },
      userConfig
    );
    const tools = [...profileTools, ...this.automationRunHistoryTools];
    const { systemPrompt, soulActive } = await this.resolveProfileSystemPrompt(
      orgId,
      profileId,
      profile.systemPrompt,
      actor.orgRole,
      undefined,
      actor.userId
    );
    const resolvedSystemPrompt = appendRuntimeProfileRules(
      profile.isSuper,
      systemPrompt
    );
    const userTimezone = userConfig?.timezone ?? DEFAULT_TIMEZONE;
    const userContext = await this.loadUserContextForUser(orgId, actor.userId);
    const harness = this.createHarnessForProfile(profile, userConfig);

    const session = harness.createChatSession({
      channel: "automation",
      enableToolLoop: true,
      soul: soulActive,
      systemPrompt: resolvedSystemPrompt,
      toolContext: buildToolExecutionContext({
        automationId,
        automationRunId,
        beforeToolCall,
        forbidProfileSkillMarkdownWrites:
          await this.shouldForbidProfileSkillMarkdownWrites(profile.id),
        isPlatformAdmin: actor.isPlatformAdmin,
        orgId,
        orgRole: actor.orgRole,
        profileId,
        recordToolOutputSavings: this.savingsRecorderFor(orgId),
        recordTurnUsage: this.turnUsageRecorderFor(
          orgId,
          this.buildUsageAttribution({
            channel: "automation",
            orgId,
            profileId,
            userConfig,
            userId: actor.userId,
          })
        ),
        userId: actor.userId,
      }),
      tools,
      userContext,
      userTimezone,
    });

    return session.send(prompt);
  }

  async runSubAgentPrompt(input: SubAgentRunInput): Promise<SubAgentRunResult> {
    const startedAt = Date.now();

    if (!input.userId?.trim()) {
      return failSubAgentResult("Canonical principal is required.");
    }

    const userConfig = await this.getOrgUserConfig(input.orgId);
    const toolConfigurationVersion =
      this.sessionInvalidationVersions.get(input.orgId) ?? 0;
    if (!isProviderConfigured(userConfig)) {
      return failSubAgentResult("Provider is not configured.");
    }

    const task = input.task.trim();

    if (!task) {
      return failSubAgentResult("task is required.");
    }

    const timeoutMs = clampSubAgentTimeout(input.timeoutMs);
    const profile = await this.requireProfile(input.orgId, input.profileId);
    const beforeToolCall = this.createToolExecutionGuard(
      input.orgId,
      profile.id,
      toolConfigurationVersion,
      input
    );
    try {
      await beforeToolCall();
    } catch (error) {
      return failSubAgentResult(
        error instanceof Error ? error.message : String(error)
      );
    }
    if (
      profile.isSuper &&
      !canAccessSuperAgentProfile({
        isPlatformAdmin: input.isPlatformAdmin,
        orgRole: input.orgRole,
      })
    ) {
      return failSubAgentResult(
        "Super Agent is only available to Workspace Admins and Superadmins."
      );
    }
    const tools = await this.resolveProfileTools(
      profile,
      {
        includeAutomationTools: false,
        includeQuestionTools: false,
        includeSubAgentTool: false,
        includeTodoTools: false,
        userId: input.userId,
      },
      userConfig
    );
    const { systemPrompt, soulActive } = await this.resolveProfileSystemPrompt(
      input.orgId,
      input.profileId,
      profile.systemPrompt,
      "member",
      undefined,
      input.userId
    );
    const resolvedSystemPrompt = appendRuntimeProfileRules(
      profile.isSuper,
      systemPrompt
    );
    const childSystemPrompt = [
      resolvedSystemPrompt.trim(),
      "",
      "You are running as a focused sub-agent delegated from a parent conversation.",
      "Complete the assigned task and return a clear final answer.",
      "Do not spawn sub-agents.",
    ].join("\n");
    const userTimezone = userConfig?.timezone ?? DEFAULT_TIMEZONE;
    const userContext = await this.loadUserContextForUser(
      input.orgId,
      input.userId
    );
    const harness = this.createHarnessForProfile(profile, userConfig);
    const prompt = buildSubAgentPrompt(task, input.context);

    const session = harness.createChatSession({
      channel: "subagent",
      enableToolLoop: true,
      soul: soulActive,
      systemPrompt: childSystemPrompt,
      toolContext: buildToolExecutionContext({
        agentDepth: input.agentDepth,
        beforeToolCall,
        clientOrigin: input.clientOrigin,
        forbidProfileSkillMarkdownWrites:
          await this.shouldForbidProfileSkillMarkdownWrites(input.profileId),
        orgId: input.orgId,
        orgRole: input.orgRole ?? "member",
        profileId: input.profileId,
        recordToolOutputSavings: this.savingsRecorderFor(input.orgId),
        recordTurnUsage: this.turnUsageRecorderFor(
          input.orgId,
          this.buildUsageAttribution({
            channel: "subagent",
            orgId: input.orgId,
            profileId: input.profileId,
            userConfig,
            userId: input.userId,
          })
        ),
        sessionId: input.executionId
          ? `subagent:${input.orgId}:${input.executionId}`
          : input.sessionId,
        userId: input.userId,
      }),
      tools,
      userContext,
      userTimezone,
    });

    let sawPlanning = false;
    let sawWriting = false;

    const emitActivity = (label: string) => {
      input.onActivity?.(label);
    };

    emitActivity("Starting…");

    const abort = new AbortController();
    const onParentAbort = () => abort.abort();
    input.signal?.addEventListener("abort", onParentAbort, { once: true });
    const timeoutTimer = setTimeout(() => abort.abort(), timeoutMs);

    try {
      const reply = await session.sendStream(
        prompt,
        {
          onChunk: () => {
            if (sawWriting) {
              return;
            }

            sawWriting = true;
            emitActivity("Writing answer…");
          },
          onThinking: () => {
            if (sawPlanning) {
              return;
            }

            sawPlanning = true;
            emitActivity("Planning…");
          },
          onToolStart: (event) => {
            emitActivity(formatToolActivityLabel(event.tool, event.input));
          },
        },
        { signal: abort.signal }
      );
      const durationMs = Date.now() - startedAt;

      if (abort.signal.aborted) {
        if (input.signal?.aborted) {
          return failSubAgentResult("Sub-agent cancelled.");
        }
        console.info(
          `[sub_agent] timeout org=${input.orgId} profile=${input.profileId} durationMs=${durationMs}`
        );
        return buildSubAgentResult("timeout", "", "Sub-agent timed out.");
      }

      if (!reply.trim()) {
        console.info(
          `[sub_agent] fail org=${input.orgId} profile=${input.profileId} durationMs=${durationMs} reason=empty_reply`
        );
        return buildSubAgentResult(
          "fail",
          "",
          "Sub-agent returned no final reply."
        );
      }

      console.info(
        `[sub_agent] success org=${input.orgId} profile=${input.profileId} durationMs=${durationMs}`
      );
      return buildSubAgentResult("success", reply.trim());
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      if (abort.signal.aborted) {
        if (input.signal?.aborted) {
          return failSubAgentResult("Sub-agent cancelled.");
        }
        console.info(
          `[sub_agent] timeout org=${input.orgId} profile=${input.profileId} durationMs=${durationMs}`
        );
        return buildSubAgentResult("timeout", "", "Sub-agent timed out.");
      }
      const message = error instanceof Error ? error.message : String(error);
      return failSubAgentResult(message);
    } finally {
      clearTimeout(timeoutTimer);
      input.signal?.removeEventListener("abort", onParentAbort);
    }
  }

  async runTaskPrompt(
    taskId: string,
    profileId: string,
    prompt: string,
    principal: CanonicalPrincipal,
    options?: {
      onToolLoopStop?: (reason: ToolLoopStopReason) => void | Promise<void>;
    }
  ): Promise<string> {
    const task = await this.db.getTask(taskId);

    if (!task?.orgId || task.profileId !== profileId) {
      throw new Error("Task not found.");
    }

    if (!isProviderConfigured(await this.getOrgUserConfig(task.orgId))) {
      throw new Error("Provider is not configured.");
    }

    const sessionId = await this.ensureTaskSession(
      taskId,
      profileId,
      task.orgId,
      principal
    );
    const session = await this.resolveSession(task.orgId, sessionId, {
      userId: principal.userId,
    });

    if (!session) {
      throw new Error("Session not found.");
    }

    return session.send(prompt, options);
  }

  async ensureTaskSession(
    taskId: string,
    profileId: string,
    orgId: string,
    principal?: CanonicalPrincipal
  ): Promise<string> {
    const record = await this.db.getTask(taskId);

    if (!record || record.orgId !== orgId || record.profileId !== profileId) {
      throw new Error("Task not found.");
    }

    const actor = await this.resolveTaskPrincipal(record, principal);

    if (record.sessionId) {
      const existing = await this.db.getSession(record.sessionId);

      if (
        existing?.channel === "task" &&
        existing.orgId === orgId &&
        existing.profileId === profileId &&
        existing.userId === actor.userId
      ) {
        return record.sessionId;
      }
    }

    const sessionId = await this.createSession(
      orgId,
      "task",
      profileId,
      actor.userId,
      {
        isPlatformAdmin: actor.isPlatformAdmin,
        orgRole: actor.orgRole,
      }
    );

    await this.db.upsertTask({
      ...record,
      sessionId,
      updatedAt: new Date().toISOString(),
    });

    return sessionId;
  }

  private async resolveTaskPrincipal(
    task: StoredTaskRecord,
    explicit?: CanonicalPrincipal
  ): Promise<CanonicalPrincipal> {
    const ownerId = task.createdByUserId?.trim();
    const orgId = task.orgId?.trim();
    if (!(ownerId && orgId)) {
      throw new AtlasApiError(
        "Task has no canonical owner and cannot be run.",
        403
      );
    }

    if (explicit) {
      const actor = runAsPrincipal(explicit, (value) => value);
      if (actor.orgId !== orgId || actor.userId !== ownerId) {
        throw new AtlasApiError("Only the task owner can run this task.", 403);
      }
    }

    let actor: CanonicalPrincipal;
    try {
      actor = await this.identityService.resolveForUser(orgId, ownerId);
    } catch (error) {
      if (error instanceof PrincipalRequiredError) {
        throw new AtlasApiError(error.message, 403);
      }
      throw error;
    }
    if (actor.orgRole === "viewer" && !actor.isPlatformAdmin) {
      throw new AtlasApiError("Viewers cannot run tasks.", 403);
    }
    return actor;
  }

  async getTaskChatMessages(
    taskId: string,
    orgId: string,
    actor: SessionActor
  ): Promise<{ sessionId: string; messages: ChatMessage[] } | null> {
    const record = await this.db.getTask(taskId);

    if (
      !record ||
      record.orgId !== orgId ||
      !(await this.canReadTaskRecord(record, orgId, actor))
    ) {
      return null;
    }

    let sessionId = record.sessionId;

    if (sessionId) {
      const existing = await this.db.getSession(sessionId);

      if (!existing) {
        sessionId = null;
      }
    }

    if (!sessionId) {
      const orgId = record.orgId?.trim();

      if (!orgId) {
        throw new Error("Task organization is missing.");
      }

      sessionId = await this.ensureTaskSession(taskId, record.profileId, orgId);
    }

    if (!(await this.canAccessSession(orgId, sessionId, actor, "read"))) {
      return null;
    }

    let messages = await loadSessionHistory(this.db, sessionId);

    if (messages.length === 0) {
      const runs = await this.db.listTaskRuns(taskId, 1);
      const latestRun = runs[0];

      if (latestRun && latestRun.status !== "running") {
        await this.seedTaskSessionFromRun(record.prompt, latestRun, sessionId);
        messages = await loadSessionHistory(this.db, sessionId);
      }
    }

    return { messages, sessionId };
  }

  async canReadTask(
    taskId: string,
    orgId: string,
    actor: SessionActor
  ): Promise<boolean> {
    const record = await this.db.getTask(taskId);
    return record?.orgId === orgId
      ? this.canReadTaskRecord(record, orgId, actor)
      : false;
  }

  private async canReadTaskRecord(
    record: StoredTaskRecord,
    orgId: string,
    actor: SessionActor
  ): Promise<boolean> {
    if (record.sessionId) {
      const linkedSession = await this.db.getSession(record.sessionId);
      if (linkedSession) {
        return this.canAccessSession(orgId, record.sessionId, actor, "read");
      }
    }

    if (actor.workspaceWorkerChannel) {
      return false;
    }
    const actorUserId = actor.userId.trim();
    if (!actorUserId) {
      return false;
    }
    const [orgRole, isPlatformAdmin] = await Promise.all([
      this.resolveOrgRole(orgId, actorUserId),
      this.resolveIsPlatformAdmin(actorUserId),
    ]);
    return (
      isPlatformAdmin ||
      orgRole === "admin" ||
      (Boolean(orgRole) && record.createdByUserId === actorUserId)
    );
  }

  private async seedTaskSessionFromRun(
    prompt: string,
    run: StoredTaskRunRecord,
    sessionId: string
  ): Promise<void> {
    const history: ChatMessage[] = [{ content: prompt, role: "user" }];

    if (run.status === "failed") {
      history.push({
        content: run.error ?? "Task run failed.",
        role: "assistant",
      });
    } else if (run.output) {
      history.push({
        content: run.output,
        role: "assistant",
      });
    }

    await replaceSessionHistory(this.db, sessionId, history);
    this.sessions.delete(sessionId);
  }

  async runAutomation(
    automationId: string,
    options?: { fireId?: string; principal?: CanonicalPrincipal }
  ) {
    if (!this.automationRunner) {
      throw new Error("Automation runner is not configured.");
    }

    return this.automationRunner.run(automationId, options);
  }

  async runTask(taskId: string, principal?: CanonicalPrincipal) {
    if (!this.taskRunner) {
      throw new Error("Task runner is not configured.");
    }

    return this.taskRunner.run(taskId, principal);
  }

  get providerConfigured(): boolean {
    return this._providerConfigured;
  }

  async createSession(
    orgId: string,
    channel: AgentChannel,
    profileId?: string,
    userId?: string | null,
    access?: SessionAccessOptions
  ): Promise<string> {
    const resolvedProfileId = await this.resolveSessionProfile(
      orgId,
      profileId
    );
    const profile = await this.requireProfile(orgId, resolvedProfileId);

    const sessionId = nanoid();
    const modelOverride = await this.normalizeSessionModelOverride(
      orgId,
      access?.model
    );
    let principalUserId = userId ?? null;
    let sessionOrgRole = access?.orgRole ?? null;
    let sessionIsPlatformAdmin = access?.isPlatformAdmin === true;
    if (
      channel === "telegram" ||
      channel === "whatsapp" ||
      channel === "discord"
    ) {
      const principal = await this.identityService.resolveForChannelSession({
        authUserId: userId ?? "",
        channel,
        channelUserAliases: access?.externalPrincipal?.channelUserAliases,
        channelUserId: access?.externalPrincipal?.channelUserId,
        isPlatformAdmin: access?.isPlatformAdmin === true,
        orgId,
        orgRole: access?.orgRole ?? "member",
      });
      principalUserId = principal.userId;
      sessionOrgRole = principal.orgRole;
      sessionIsPlatformAdmin = principal.isPlatformAdmin;
      if (sessionOrgRole === "viewer" && !sessionIsPlatformAdmin) {
        throw new AtlasApiError("Viewer access is read-only", 403);
      }
    } else if (
      principalUserId &&
      isServiceAccountUserId(principalUserId) &&
      channel !== "cli" &&
      channel !== "automation" &&
      channel !== "task"
    ) {
      throw new PrincipalRequiredError(
        "Service-account identity cannot create this session."
      );
    }

    if (
      profile.isSuper &&
      (access?.excludeSuperAgent ||
        !canAccessSuperAgentProfile({
          isPlatformAdmin: sessionIsPlatformAdmin,
          orgRole: sessionOrgRole,
        }))
    ) {
      throw new AtlasApiError(
        "Super Agent is only available to Workspace Admins and Superadmins.",
        403
      );
    }

    await this.db.upsertSession({
      agentQuestionnaire: null,
      agentTodos: [],
      channel,
      createdAt: new Date().toISOString(),
      id: sessionId,
      modelOverride,
      orgId,
      profileId: resolvedProfileId,
      title: null,
      userId: principalUserId,
    });

    const mcpAvailabilityVersion = this.mcpAvailabilityVersions.get(orgId) ?? 0;
    const session = await this.buildChatSession(
      channel,
      orgId,
      resolvedProfileId,
      sessionId,
      modelOverride,
      principalUserId,
      sessionOrgRole,
      sessionIsPlatformAdmin
    );

    this.rememberSession(
      sessionId,
      {
        channel,
        isPlatformAdmin: sessionIsPlatformAdmin,
        modelOverride,
        orgId,
        orgRole: sessionOrgRole,
        profileId: resolvedProfileId,
        session,
        userId: principalUserId,
      },
      mcpAvailabilityVersion
    );

    return sessionId;
  }

  async getSessionTodos(
    orgId: string,
    sessionId: string
  ): Promise<AgentTodo[] | null> {
    const record = await this.getSessionRecordForOrg(orgId, sessionId);

    if (!record) {
      return null;
    }
    return this.agentTodoState.listActive(sessionId);
  }

  async getSessionQuestionnaire(
    orgId: string,
    sessionId: string
  ): Promise<AgentQuestionnaire | null> {
    const record = await this.getSessionRecordForOrg(orgId, sessionId);

    if (!record) {
      return null;
    }

    return this.agentQuestionnaireState.get(sessionId);
  }

  async consumeSessionQuestionnaire(
    orgId: string,
    sessionId: string,
    expected: AgentQuestionnaire
  ): Promise<void> {
    if (!(await this.getSessionRecordForOrg(orgId, sessionId))) {
      throw new AtlasApiError("Session not found", 404);
    }
    await this.agentQuestionnaireState.consume(sessionId, expected);
  }

  async getSessionMessages(
    orgId: string,
    sessionId: string,
    actor?: SessionActor
  ): Promise<{
    canUpdateModel: boolean;
    channel: AgentChannel;
    messages: ChatMessage[];
    messageMeta: Array<{ id: string; seq: number; createdAt: string }>;
    contextUsage: ChatContextUsage | null;
    model: string | null;
  } | null> {
    const record = await this.getSessionRecordForOrg(orgId, sessionId);

    if (!record) {
      return null;
    }
    if (
      actor &&
      !(await this.canActorAccessSessionRecord(orgId, record, actor, "read"))
    ) {
      return null;
    }
    // History remains readable even when its selected model was removed.
    const modelOverride = record.modelOverride?.trim() || null;

    const channel = parseAgentChannel(record.channel);

    if (!channel) {
      return null;
    }

    const canUpdateModel = actor
      ? await this.canActorUpdateSessionModel(orgId, record, actor)
      : false;

    if (sessionTurnRegistry.isActive(sessionId)) {
      const liveSession = await this.resolveSession(orgId, sessionId);

      if (liveSession) {
        const history = liveSession.getHistory();
        const startedAt =
          sessionTurnRegistry.getStatus(sessionId).startedAt ??
          new Date().toISOString();

        return {
          canUpdateModel,
          channel,
          contextUsage: liveSession.getContextUsage(),
          messageMeta: history.map((_, index) => ({
            createdAt: startedAt,
            id: `live-${index}`,
            seq: index,
          })),
          messages: [...history],
          model: modelOverride,
        };
      }
    }

    const storedMessages = await this.db.listMessagesForSession(sessionId);
    const cached = this.sessions.get(sessionId)?.session;
    const contextUsage = cached
      ? cached.getContextUsage()
      : ((await this.resolveSession(orgId, sessionId))?.getContextUsage() ??
        null);

    return {
      canUpdateModel,
      channel,
      contextUsage,
      messageMeta: storedMessages.map((message) => ({
        createdAt: message.createdAt,
        id: message.id,
        seq: message.seq,
      })),
      messages: storedMessages.map((message) => message.payload as ChatMessage),
      model: modelOverride,
    };
  }

  async getSessionAttachment(
    orgId: string,
    sessionId: string,
    attachmentId: string,
    actor: SessionActor
  ): Promise<{
    bytes: Buffer;
    filename: string | null;
    kind: "image" | "document";
    mediaType: string;
  } | null> {
    const sessionRecord = await this.getSessionRecordForOrg(orgId, sessionId);

    if (!sessionRecord) {
      return null;
    }
    if (
      !(await this.canActorAccessSessionRecord(
        orgId,
        sessionRecord,
        actor,
        "read"
      ))
    ) {
      return null;
    }

    const attachment = await this.db.getAttachment(attachmentId);

    if (
      !attachment ||
      attachment.orgId !== orgId ||
      attachment.profileId !== sessionRecord.profileId ||
      !(await this.sessionReferencesAttachment(sessionId, attachmentId))
    ) {
      return null;
    }

    const bytes = await readAttachmentBytes(
      orgId,
      sessionRecord.profileId,
      attachmentId
    );

    if (!bytes || bytes.byteLength !== attachment.sizeBytes) {
      return null;
    }

    return {
      bytes,
      filename: attachment.filename,
      kind: attachment.kind,
      mediaType: attachment.mediaType,
    };
  }

  async branchSession(
    orgId: string,
    sessionId: string,
    messageIndex: number,
    actor?: SessionActor
  ): Promise<BranchSessionResponse | null> {
    const record = await this.getSessionRecordForOrg(orgId, sessionId);

    if (!record) {
      return null;
    }
    if (
      actor &&
      !(await this.canActorAccessSessionRecord(orgId, record, actor, "manage"))
    ) {
      return null;
    }
    const modelOverride = await this.resolveApprovedStoredSessionModelOverride(
      orgId,
      record
    );

    if (!Number.isInteger(messageIndex) || messageIndex < 0) {
      throw new Error("messageIndex must be a non-negative integer.");
    }

    const branchUserId = actor?.userId.trim() || record.userId || null;
    const [branchOrgRole, branchIsPlatformAdmin] = await Promise.all([
      this.resolveOrgRole(orgId, branchUserId),
      this.resolveIsPlatformAdmin(branchUserId),
    ]);
    if (
      actor &&
      !(
        branchIsPlatformAdmin ||
        branchOrgRole === "admin" ||
        branchOrgRole === "member"
      )
    ) {
      throw new AtlasApiError(
        "You do not have permission to branch this session.",
        403
      );
    }

    const sourceMessages = await loadSessionHistory(this.db, sessionId);

    if (messageIndex >= sourceMessages.length) {
      throw new Error("messageIndex is out of bounds.");
    }

    const nextSessionId = nanoid();
    const sourceTitle = record.title?.trim();
    const branchTitle = sourceTitle
      ? `${sourceTitle} (Branch)`
      : "Untitled (Branch)";

    await this.db.upsertSession({
      agentQuestionnaire: null,
      agentTodos: [],
      channel: record.channel,
      createdAt: new Date().toISOString(),
      id: nextSessionId,
      modelOverride,
      orgId,
      profileId: record.profileId,
      title: null,
      userId: branchUserId,
    });

    await replaceSessionHistory(
      this.db,
      nextSessionId,
      sourceMessages.slice(0, messageIndex + 1)
    );
    await this.db.updateSessionTitle(nextSessionId, branchTitle);

    const channel = parseAgentChannel(record.channel);

    if (!channel) {
      throw new Error("Session channel is invalid.");
    }

    const mcpAvailabilityVersion = this.mcpAvailabilityVersions.get(orgId) ?? 0;
    const session = await this.buildChatSession(
      channel,
      orgId,
      record.profileId,
      nextSessionId,
      modelOverride,
      branchUserId,
      branchOrgRole,
      branchIsPlatformAdmin
    );
    this.rememberSession(
      nextSessionId,
      {
        channel,
        isPlatformAdmin: branchIsPlatformAdmin,
        modelOverride,
        orgId,
        orgRole: branchOrgRole,
        profileId: record.profileId,
        session,
        userId: branchUserId,
      },
      mcpAvailabilityVersion
    );

    return { sessionId: nextSessionId };
  }

  async listSessions(
    orgId: string,
    profileId: string,
    channel: AgentChannel,
    actor: SessionActor
  ): Promise<ListSessionsResponse> {
    const profile = await this.requireProfile(orgId, profileId);

    if (actor.workspaceWorkerChannel) {
      return { sessions: [] };
    }
    const actorUserId = actor.userId.trim();
    const [orgRole, isPlatformAdmin] = await Promise.all([
      this.resolveOrgRole(orgId, actorUserId),
      this.resolveIsPlatformAdmin(actorUserId),
    ]);
    if (!(isPlatformAdmin || orgRole)) {
      return { sessions: [] };
    }
    const ownerUserId =
      isPlatformAdmin || orgRole === "admin" ? undefined : actorUserId;
    const sessions = await this.db.listSessionSummaries(
      profile.id,
      channel,
      ownerUserId
    );

    return {
      sessions: sessions.map((session) => ({
        channel: parseAgentChannel(session.channel) ?? channel,
        createdAt: session.createdAt,
        id: session.id,
        messageCount: session.messageCount,
        preview: session.preview,
        profileId: session.profileId,
        title: session.title,
        updatedAt: session.updatedAt,
      })),
    };
  }

  scheduleSessionTitleGeneration(sessionId: string): void {
    this.sessionTitleService.scheduleSessionTitleGeneration(sessionId);
  }

  schedulePostTurnSkillReview(sessionId: string): void {
    this.skillPostTurnReviewService.schedulePostTurnSkillReview(sessionId);
  }

  getSkillPostTurnReviewService(): SkillPostTurnReviewService {
    return this.skillPostTurnReviewService;
  }

  async purgeSession(
    orgId: string,
    sessionId: string,
    actor?: SessionActor
  ): Promise<boolean> {
    const record = await this.getSessionRecordForOrg(orgId, sessionId);

    if (!record) {
      return false;
    }
    if (
      actor &&
      !(await this.canActorAccessSessionRecord(orgId, record, actor, "manage"))
    ) {
      return false;
    }

    sessionTurnRegistry.cancelTurn(sessionId);
    await deleteSubscriptionConversation(sessionId);
    this.sessions.delete(sessionId);
    this.superAgentSessionState.clearSession(sessionId);
    this.agentTodoState.clearSession(sessionId);
    this.agentQuestionnaireState.clearSession(sessionId);
    await this.db.deleteSession(sessionId);
    return true;
  }

  /** Fresh authenticated HTTP turn authority; never retained in the session cache. */
  async prepareAuthenticatedSessionTurnOptions(
    orgId: string,
    sessionId: string,
    actor: SessionActor
  ): Promise<
    Readonly<
      Pick<
        NonNullable<Parameters<AgentChatSession["send"]>[1]>,
        "toolExecutionGuard"
      >
    >
  > {
    const principal = await createPublicationTurnPrincipal({
      actor,
      agent: this,
      db: this.db,
      orgId,
      sessionId,
    });
    // Context validation includes a fresh current-access check. This installs
    // no publication lifecycle, private store, or process admission policy.
    return Object.freeze({
      toolExecutionGuard: (context: Readonly<ToolContext>) =>
        principal.validateContext(context),
    });
  }

  async resolveSession(
    orgId: string,
    sessionId: string,
    actor?: SessionActor
  ): Promise<AgentChatSession | null> {
    await this.getOrgUserConfig(orgId);
    const invalidationVersion =
      this.sessionInvalidationVersions.get(orgId) ?? 0;
    const record = await this.getSessionRecordForOrg(orgId, sessionId);

    if (!record) {
      return null;
    }
    if (
      actor &&
      !(await this.canActorAccessSessionRecord(orgId, record, actor, "invoke"))
    ) {
      return null;
    }
    const modelOverride = await this.resolveApprovedStoredSessionModelOverride(
      orgId,
      record
    );

    const channel = parseAgentChannel(record.channel);

    if (!channel) {
      return null;
    }

    const isExternalChannel =
      channel === "telegram" || channel === "whatsapp" || channel === "discord";
    const recordedUserId = record.userId?.trim() || null;
    if (
      isExternalChannel &&
      (!recordedUserId || isServiceAccountUserId(recordedUserId))
    ) {
      throw new PrincipalRequiredError(
        "Channel session is missing a canonical user principal. Re-pair the channel."
      );
    }

    // A local-token worker authenticates transport to Atlas; it is never the
    // actor for a channel turn. External channel sessions are created only
    // after resolving the sender to a canonical Atlas user, so every later
    // turn must retain that persisted principal and its current workspace role.
    const actorUserId = isExternalChannel
      ? recordedUserId
      : actor?.userId?.trim() || recordedUserId;
    const orgRole = await this.resolveOrgRole(orgId, actorUserId);
    const isPlatformAdmin = await this.resolveIsPlatformAdmin(actorUserId);
    const profile = await this.db.getProfileForOrg(record.profileId, orgId);
    if (
      profile?.isSuper &&
      !canAccessSuperAgentProfile({
        isPlatformAdmin,
        orgRole,
      })
    ) {
      throw new AtlasApiError(
        "Super Agent is only available to Workspace Admins and Superadmins.",
        403
      );
    }

    const stored = this.sessions.get(sessionId);

    if (
      stored &&
      stored.profileId === record.profileId &&
      stored.modelOverride === modelOverride &&
      stored.userId === actorUserId &&
      stored.orgRole === orgRole &&
      stored.isPlatformAdmin === isPlatformAdmin
    ) {
      return stored.session;
    }

    const mcpAvailabilityVersion = this.mcpAvailabilityVersions.get(orgId) ?? 0;
    const session = await this.buildChatSession(
      channel,
      orgId,
      record.profileId,
      sessionId,
      modelOverride,
      actorUserId,
      orgRole,
      isPlatformAdmin
    );

    await this.requireActiveOrganizationForTurn(orgId);
    if (
      (this.sessionInvalidationVersions.get(orgId) ?? 0) !== invalidationVersion
    ) {
      throw new AtlasApiError(
        "Session configuration changed. Retry the request.",
        409
      );
    }

    this.rememberSession(
      sessionId,
      {
        channel,
        isPlatformAdmin,
        modelOverride,
        orgId,
        orgRole,
        profileId: record.profileId,
        session,
        userId: actorUserId,
      },
      mcpAvailabilityVersion
    );

    return session;
  }

  async updateSessionModel(
    orgId: string,
    sessionId: string,
    model: string | null,
    actor: SessionActor
  ): Promise<boolean> {
    const record = await this.getSessionRecordForOrg(orgId, sessionId);

    if (!record) {
      return false;
    }

    if (!(await this.canActorUpdateSessionModel(orgId, record, actor))) {
      throw new AtlasApiError(
        "You do not have permission to change this session model.",
        403
      );
    }

    await this.requireActiveOrganizationForTurn(orgId);
    const turn = sessionTurnRegistry.beginTurn(sessionId, orgId);
    if (!turn.started) {
      throw new AtlasApiError(
        "Wait for the current response before changing models.",
        409
      );
    }

    try {
      const modelOverride = await this.normalizeSessionModelOverride(
        orgId,
        model
      );
      if (record.modelOverride === modelOverride) {
        return true;
      }

      const updated = await this.db.updateSessionModelOverride(
        sessionId,
        modelOverride
      );
      if (updated) {
        this.sessions.delete(sessionId);
      }
      return updated;
    } finally {
      sessionTurnRegistry.cancelTurn(sessionId);
    }
  }

  async beginSessionTurn(
    orgId: string,
    sessionId: string,
    actor?: SessionActor
  ): Promise<boolean | null> {
    const record = await this.getSessionRecordForOrg(orgId, sessionId);
    if (!record) {
      return null;
    }
    if (
      actor &&
      !(await this.canActorAccessSessionRecord(orgId, record, actor, "invoke"))
    ) {
      return null;
    }

    await this.requireActiveOrganizationForTurn(orgId);
    return sessionTurnRegistry.beginTurn(sessionId, orgId).started;
  }

  async clearSession(
    orgId: string,
    sessionId: string,
    actor?: SessionActor
  ): Promise<boolean> {
    const record = await this.getSessionRecordForOrg(orgId, sessionId);

    if (!record) {
      return false;
    }
    if (
      actor &&
      !(await this.canActorAccessSessionRecord(orgId, record, actor, "manage"))
    ) {
      return false;
    }

    this.chatToolApprovals.cancelSession(sessionId);
    sessionTurnRegistry.cancelTurn(sessionId);
    await deleteSubscriptionConversation(sessionId);

    const stored = this.sessions.get(sessionId);

    if (stored) {
      stored.session.clear();
    }

    await this.db.deleteMessagesForSession(sessionId);
    await this.agentQuestionnaireState.clear(sessionId);
    return true;
  }

  async compactSession(
    orgId: string,
    sessionId: string,
    options: { force?: boolean } = {},
    actor?: SessionActor
  ): Promise<CompactionResponse | null> {
    if (
      actor &&
      !(await this.canAccessSession(orgId, sessionId, actor, "invoke"))
    ) {
      return null;
    }
    const session = await this.resolveSession(orgId, sessionId, actor);

    if (!session) {
      return null;
    }

    if (sessionTurnRegistry.isActive(sessionId)) {
      throw new AtlasApiError(
        "A response is already in progress for this session.",
        409
      );
    }

    return session.compact(options);
  }

  async deleteSession(orgId: string, sessionId: string): Promise<boolean> {
    if (!(await this.getSessionRecordForOrg(orgId, sessionId))) {
      return false;
    }
    this.chatToolApprovals.cancelSession(sessionId);
    sessionTurnRegistry.cancelTurn(sessionId);
    await deleteSubscriptionConversation(sessionId);
    this.sessions.delete(sessionId);
    this.agentTodoState.clearSession(sessionId);
    this.agentQuestionnaireState.clearSession(sessionId);
    await this.db.deleteSession(sessionId);
    return true;
  }

  private async sessionReferencesAttachment(
    sessionId: string,
    attachmentId: string
  ): Promise<boolean> {
    const storedMessages = await this.db.listMessagesForSession(sessionId);
    const messages = storedMessages.map(
      (message) => message.payload as ChatMessage
    );
    const liveSession = this.sessions.get(sessionId)?.session;

    if (liveSession) {
      messages.push(...liveSession.getHistory());
    }

    return messages.some((message) => {
      if (message.role !== "user" || !Array.isArray(message.content)) {
        return false;
      }

      return message.content.some(
        (part) =>
          (part.type === "image_ref" || part.type === "document_ref") &&
          part.attachmentId === attachmentId
      );
    });
  }

  private async getSessionRecordForOrg(
    orgId: string,
    sessionId: string
  ): Promise<StoredSessionRecord | null> {
    const record = await this.db.getSession(sessionId);

    if (!record) {
      return null;
    }

    if (record.orgId) {
      return record.orgId === orgId ? record : null;
    }

    const profile = await this.db.getProfile(record.profileId);
    return profile?.orgId === orgId ? record : null;
  }

  private async resolveCapabilityAttribution(
    orgId: string,
    sessionId: string | null | undefined,
    actor?: {
      allowPersistedSessionPrincipal?: boolean;
      expectedChannel?: AgentChannel;
      userId?: string | null;
    }
  ): Promise<{
    channel: AgentChannel | typeof UNKNOWN_USAGE_DIMENSION;
    profileId: string;
    userId: string;
  }> {
    const actorUserId = actor?.userId?.trim() || UNKNOWN_USAGE_DIMENSION;
    const normalizedSessionId = sessionId?.trim();
    if (!normalizedSessionId) {
      if (actor?.expectedChannel) {
        throw new PrincipalRequiredError(
          "A canonical session principal is required for channel capability usage."
        );
      }
      return {
        channel: UNKNOWN_USAGE_DIMENSION,
        profileId: UNKNOWN_USAGE_DIMENSION,
        userId: actorUserId,
      };
    }

    const record = await this.getSessionRecordForOrg(
      orgId,
      normalizedSessionId
    );
    if (!record) {
      throw new AtlasApiError("Session not found", 404);
    }

    const sessionUserId = record.userId?.trim();
    if (!sessionUserId || isServiceAccountUserId(sessionUserId)) {
      throw new PrincipalRequiredError(
        "Session is missing a canonical user principal."
      );
    }
    if (
      !actor?.allowPersistedSessionPrincipal &&
      actorUserId !== sessionUserId
    ) {
      throw new AtlasApiError("Session not found", 404);
    }

    const channel = parseAgentChannel(record.channel);
    if (actor?.expectedChannel && channel !== actor.expectedChannel) {
      throw new AtlasApiError("Session not found", 404);
    }
    if (actor?.allowPersistedSessionPrincipal) {
      const isExternalChannel =
        channel === "discord" ||
        channel === "telegram" ||
        channel === "whatsapp";
      const [member, profile] = await Promise.all([
        this.db.getOrgMember(orgId, sessionUserId),
        this.db.getProfileForOrg(record.profileId, orgId),
      ]);
      if (
        !(isExternalChannel && member) ||
        member.role === "viewer" ||
        !profile ||
        profile.isSuper
      ) {
        throw new AtlasApiError("Session not found", 404);
      }
    }

    return {
      channel: channel ?? UNKNOWN_USAGE_DIMENSION,
      profileId: record.profileId,
      userId: sessionUserId,
    };
  }

  async draftAutomation(orgId: string, prompt: string, channel: AgentChannel) {
    const userConfig = await this.getOrgUserConfig(orgId);
    const active = getActiveProviderInstance(userConfig);
    const modelId = active ? resolveDefaultModelForInstance(active) : null;
    const provider =
      active && modelId
        ? createProviderForInstance(
            active,
            modelId,
            process.env,
            this.providerAdapterRegistry
          )
        : null;
    if (!(isProviderConfigured(userConfig) && active && modelId && provider)) {
      throw new Error("Provider is not configured.");
    }

    const chatCapabilityPolicy = this.resolveChatCapabilityPolicyForTarget(
      userConfig,
      active,
      modelId
    );
    const harness = this.createHarness({
      chatCapabilityPolicy,
      modelId,
      provider,
      providerInstance: active,
      thinking: this.resolveWorkspaceThinkingDefaults(userConfig),
    });
    return harness.createAutomationFromPrompt({ channel, prompt });
  }

  async draftTaskPrompt(
    orgId: string,
    title: string,
    description?: string
  ): Promise<string> {
    const userConfig = await this.getOrgUserConfig(orgId);
    const active = getActiveProviderInstance(userConfig);
    const modelId = active ? resolveDefaultModelForInstance(active) : null;
    const provider =
      active && modelId
        ? this.createCapabilityAwareProvider(active, modelId, userConfig)
        : null;

    return draftTaskPromptFromFields(
      { description, title },
      { provider: provider ?? undefined }
    );
  }

  async discoverModels(
    orgId: string,
    request: DiscoverModelsRequest,
    options: { signal?: AbortSignal } = {}
  ): Promise<ModelsResponse> {
    const userConfig = await this.getOrgUserConfig(orgId);
    const providerId = request.providerId?.trim();
    if (providerId) {
      return this.discoverModelsForProvider(
        providerId,
        {
          apiKey: request.apiKey,
          baseUrl: request.baseUrl?.trim() || undefined,
          hostMode: request.hostMode,
        },
        userConfig,
        options
      );
    }
    const probeType = request.provider ?? "openai_compatible";
    const probeInstance: ProviderInstance = {
      apiKey: request.apiKey ?? "",
      ...(request.baseUrl?.trim() ? { baseUrl: request.baseUrl.trim() } : {}),
      createdAt: new Date(0).toISOString(),
      ...(request.hostMode ? { hostMode: request.hostMode } : {}),
      id: "discover",
      label: "Discover",
      type: probeType,
    };
    return this.runProviderModelDiscovery(
      probeInstance,
      {
        apiKey: request.apiKey,
        baseUrl: request.baseUrl,
        hostMode: request.hostMode,
      },
      null,
      options
    );
  }

  async discoverModelsForProvider(
    providerId: string,
    overrides?: {
      baseUrl?: string;
      apiKey?: string;
      hostMode?: DiscoverModelsRequest["hostMode"];
    },
    userConfig: UserConfig | null = this.userConfig,
    options: { signal?: AbortSignal } = {}
  ): Promise<ModelsResponse> {
    const instance = findProviderInstance(
      userConfig ?? { defaultProviderId: null, providers: [] },
      providerId
    );

    if (!instance) {
      throw new Error("Provider not found.");
    }

    return this.runProviderModelDiscovery(
      instance,
      overrides,
      providerId,
      options
    );
  }

  private async runProviderModelDiscovery(
    instance: ProviderInstance,
    overrides:
      | {
          apiKey?: string;
          baseUrl?: string;
          hostMode?: DiscoverModelsRequest["hostMode"];
        }
      | undefined,
    currentProviderId: string | null,
    options: { signal?: AbortSignal }
  ): Promise<ModelsResponse> {
    const requestedBaseUrl = overrides?.baseUrl?.trim() || undefined;
    requireCredentialForProviderEndpointChange(
      instance,
      requestedBaseUrl,
      overrides?.apiKey
    );
    const apiKey =
      overrides?.apiKey?.trim() ||
      readApiKeyForInstance(instance, process.env)?.trim() ||
      "";
    const hostMode = overrides?.hostMode ?? instance.hostMode;
    const discovered = await this.providerAdapterRegistry.discoverModels(
      instance.type,
      {
        apiKey,
        ...(requestedBaseUrl || instance.baseUrl?.trim()
          ? { baseUrl: requestedBaseUrl || instance.baseUrl?.trim() }
          : {}),
        configured: currentProviderId !== null,
        ...(hostMode ? { hostMode } : {}),
        instance,
        ...(options.signal ? { signal: options.signal } : {}),
      }
    );

    return {
      ...discovered,
      currentProviderId,
      provider: instance.type,
      providers: [],
    };
  }

  async listProviders(orgId: string): Promise<ListProvidersResponse> {
    const userConfig = await this.getOrgUserConfig(orgId);
    const providers = userConfig?.providers ?? [];

    return {
      defaultProviderId: userConfig?.defaultProviderId ?? null,
      providers: providers.map((instance) =>
        toProviderInstanceSummary(instance, countModelsForInstance(instance))
      ),
    };
  }

  async testProvider(
    request: TestProviderRequest
  ): Promise<TestProviderResponse> {
    await validateProviderConnection(request);
    return {
      message: "Connection verified successfully.",
      ok: true,
    };
  }

  async createProvider(
    orgId: string,
    request: CreateProviderRequest
  ): Promise<CreateProviderResponse> {
    return this.runSerializedOrgConfigMutation(orgId, () =>
      this.performCreateProvider(orgId, request)
    );
  }

  private async performCreateProvider(
    orgId: string,
    request: CreateProviderRequest
  ): Promise<CreateProviderResponse> {
    const userConfig = await this.getOrgUserConfig(orgId);
    const existing = userConfig?.providers ?? [];
    let instance = buildProviderInstanceFromCreateRequest(request, existing);
    const shouldSkipValidation =
      !isSubscriptionProvider(instance.type) &&
      (request.skipValidation === true ||
        process.env.ATLAS_SKIP_PROVIDER_VALIDATION === "true" ||
        process.env.NODE_ENV === "test");

    if (!shouldSkipValidation) {
      const validatedModels = await validateProviderConnection(
        providerValidationRequest(instance, request.model)
      );
      if (validatedModels) {
        instance = {
          ...instance,
          customModels: validatedModels,
        };
      }
    }

    const model = resolveInitialModel(instance, request.model);

    const providers = [...existing, instance];
    const isFirst = providers.length === 1;
    const thinking = await this.resolveThinkingSettings();
    const baseConfig = userConfig ?? {
      defaultProviderId: null,
      providers: [],
      thinkingEffort: thinking.effort,
      thinkingEnabled: thinking.enabled,
    };

    const updatedConfig: UserConfig = {
      ...baseConfig,
      defaultProviderId:
        isFirst || !baseConfig.defaultProviderId
          ? instance.id
          : baseConfig.defaultProviderId,
      providers,
    };

    await this.saveOrgUserConfig(orgId, updatedConfig);

    if (isFirst) {
      await this.ensureSoulScaffolded(orgId);
    }

    return {
      defaultProviderId: updatedConfig.defaultProviderId!,
      initialModel: model,
      provider: toProviderInstanceSummary(
        instance,
        countModelsForInstance(instance)
      ),
    };
  }

  async updateProvider(
    orgId: string,
    providerId: string,
    request: UpdateProviderRequest
  ): Promise<UpdateProviderResponse> {
    return this.runSerializedOrgConfigMutation(orgId, () =>
      this.performUpdateProvider(orgId, providerId, request)
    );
  }

  private async performUpdateProvider(
    orgId: string,
    providerId: string,
    request: UpdateProviderRequest
  ): Promise<UpdateProviderResponse> {
    const userConfig = await this.getOrgUserConfig(orgId);
    if (!userConfig) {
      throw new Error("Provider is not configured.");
    }

    const current = findProviderInstance(userConfig, providerId);

    if (!current) {
      throw new Error("Provider not found.");
    }

    requireCredentialForProviderEndpointChange(
      current,
      request.baseUrl,
      request.apiKey
    );
    validateAdminCapabilityOverridePatch(
      this.providerAdapterRegistry,
      current,
      request.capabilityOverrides
    );
    const updated = applyProviderInstanceUpdate(current, request);

    const shouldSkipValidation =
      request.skipValidation === true ||
      process.env.ATLAS_SKIP_PROVIDER_VALIDATION === "true" ||
      process.env.NODE_ENV === "test";
    const connectionSemanticsChanged =
      request.apiKey !== undefined ||
      request.baseUrl !== undefined ||
      request.customModels !== undefined ||
      request.hostMode !== undefined ||
      request.wireApi !== undefined;

    if (!shouldSkipValidation && connectionSemanticsChanged) {
      await validateProviderConnection(
        providerValidationRequest(updated, resolveInitialModel(updated))
      );
    }

    const providers = userConfig.providers.map((instance) =>
      instance.id === providerId ? updated : instance
    );

    await this.saveOrgUserConfig(orgId, { ...userConfig, providers });

    return {
      provider: toProviderInstanceSummary(
        updated,
        countModelsForInstance(updated)
      ),
    };
  }

  async deleteProvider(
    orgId: string,
    providerId: string
  ): Promise<DeleteProviderResponse> {
    return this.runSerializedOrgConfigMutation(orgId, () =>
      this.performDeleteProvider(orgId, providerId)
    );
  }

  private async performDeleteProvider(
    orgId: string,
    providerId: string
  ): Promise<DeleteProviderResponse> {
    const userConfig = await this.getOrgUserConfig(orgId);
    if (!userConfig) {
      throw new Error("Provider is not configured.");
    }

    const providers = userConfig.providers.filter(
      (instance) => instance.id !== providerId
    );

    if (providers.length === userConfig.providers.length) {
      throw new Error("Provider not found.");
    }

    let defaultProviderId = userConfig.defaultProviderId;

    if (defaultProviderId === providerId) {
      defaultProviderId = providers[0]?.id ?? null;
    }

    const updatedConfig = {
      ...userConfig,
      defaultProviderId,
      providers,
    };

    await this.saveOrgUserConfig(orgId, updatedConfig);

    return { defaultProviderId };
  }

  private runSerializedOrgConfigMutation<T>(
    orgId: string,
    mutate: () => Promise<T>
  ): Promise<T> {
    const previous =
      this.orgConfigMutationLocks.get(orgId) ?? Promise.resolve();
    const next = previous.then(mutate, mutate);
    const tail = next.then(
      () => undefined,
      () => undefined
    );
    this.orgConfigMutationLocks.set(orgId, tail);
    void tail.then(() => {
      if (this.orgConfigMutationLocks.get(orgId) === tail) {
        this.orgConfigMutationLocks.delete(orgId);
      }
    });
    return next;
  }

  async getModels(
    orgId?: string,
    options: { source?: "catalog" | "remote" } = {}
  ): Promise<ModelsResponse> {
    const userConfig = orgId
      ? await this.getOrgUserConfig(orgId)
      : this.userConfig;
    const active = getActiveProviderInstance(userConfig);
    const currentProviderId = userConfig?.defaultProviderId ?? null;
    const configuredProviders = userConfig?.providers ?? [];
    const providers = configuredProviders.map((instance) =>
      toProviderInstanceSummary(instance, countModelsForInstance(instance))
    );
    const catalog = await withLiveOpenCodeGoCatalog(AVAILABLE_MODELS);

    if (configuredProviders.length === 0) {
      return this.buildModelsResponse({
        active: null,
        catalog,
        currentProviderId: null,
        models: [],
        providers: [],
      });
    }

    const activeAdapter = active
      ? this.providerAdapterRegistry.get(active.type)
      : undefined;
    if (
      options.source === "remote" &&
      active?.baseUrl &&
      activeAdapter?.modelDiscoveryOnCatalogRefresh
    ) {
      const discovered = await this.runProviderModelDiscovery(
        active,
        undefined,
        active.id,
        {}
      );
      const remote = discovered.customModels ?? [];
      const remoteInstance = { ...active, customModels: remote };
      const effectiveProviders = (userConfig?.providers ?? []).map(
        (instance) => (instance.id === active.id ? remoteInstance : instance)
      );
      const models = mergeModelsForConfig(effectiveProviders);

      return this.buildModelsResponse({
        active,
        catalog: discovered.catalog,
        currentProviderId,
        customModels: remote,
        models: this.withEffectiveCapabilityClaims(models, {
          ...userConfig,
          defaultProviderId: userConfig?.defaultProviderId ?? null,
          providers: effectiveProviders,
        }),
        providers,
      });
    }

    const models = await this.mergeConfiguredProviderModels(
      orgId,
      userConfig?.providers ?? [],
      true
    );
    const liveUserConfig = orgId
      ? await this.getOrgUserConfig(orgId)
      : userConfig;
    const liveConfiguredProviders = liveUserConfig?.providers ?? [];
    const liveActive = getActiveProviderInstance(liveUserConfig);
    const liveModelCountByProvider = new Map<string, number>(
      liveConfiguredProviders.map((instance) => [instance.id, 0])
    );
    for (const model of models) {
      if (model.providerId) {
        liveModelCountByProvider.set(
          model.providerId,
          (liveModelCountByProvider.get(model.providerId) ?? 0) + 1
        );
      }
    }
    const liveProviders = liveConfiguredProviders.map((instance) =>
      toProviderInstanceSummary(
        instance,
        liveModelCountByProvider.get(instance.id) ??
          countModelsForInstance(instance)
      )
    );

    return this.buildModelsResponse({
      active: liveActive,
      catalog,
      currentProviderId,
      models: this.withEffectiveCapabilityClaims(models, liveUserConfig),
      providers: liveProviders,
    });
  }

  private async mergeConfiguredProviderModels(
    orgId: string | undefined,
    providers: ProviderInstance[],
    tolerateUnavailableSubscriptions = false
  ): Promise<ModelsResponse["models"]> {
    const models: ModelsResponse["models"] = [];

    for (const instance of providers) {
      if (!isProviderInstanceUsable(instance)) {
        continue;
      }
      let providerModels: ModelsResponse["models"];
      try {
        providerModels =
          await this.providerAdapterRegistry.listModelsForInstance(
            instance,
            () => getModelsForProviderInstance(instance)
          );
      } catch (error) {
        const unavailableSubscription =
          tolerateUnavailableSubscriptions &&
          isSubscriptionProvider(instance.type) &&
          error instanceof AtlasApiError &&
          (error.status === 409 || error.status === 503);
        if (unavailableSubscription) {
          continue;
        }
        throw error;
      }
      models.push(...providerModels);

      if (orgId && isSubscriptionProvider(instance.type)) {
        const preferredModelId = instance.customModels?.find(
          (model) => model.default
        )?.id;
        await this.persistSubscriptionModelSnapshot(
          orgId,
          instance.id,
          canonicalSubscriptionModelSnapshot(providerModels, preferredModelId)
        );
      }
    }

    return models;
  }

  private async persistSubscriptionModelSnapshot(
    orgId: string,
    providerId: string,
    snapshot: NonNullable<ProviderInstance["customModels"]>
  ): Promise<void> {
    await this.runSerializedOrgConfigMutation(orgId, async () => {
      const config = await this.getOrgUserConfig(orgId);
      const current = config?.providers.find(
        (instance) => instance.id === providerId
      );
      if (!(config && current && isSubscriptionProvider(current.type))) {
        return;
      }
      if (JSON.stringify(current.customModels) === JSON.stringify(snapshot)) {
        return;
      }

      await this.saveOrgUserConfig(
        orgId,
        {
          ...config,
          providers: config.providers.map((instance) =>
            instance.id === providerId
              ? { ...instance, customModels: snapshot }
              : instance
          ),
        },
        { invalidateSessions: false }
      );
    });
  }

  private async refreshSubscriptionModelSnapshots(
    orgId: string,
    config: UserConfig | null,
    providerIds?: ReadonlySet<string>
  ): Promise<UserConfig | null> {
    const subscriptionProviders = (config?.providers ?? []).filter(
      (instance) =>
        isSubscriptionProvider(instance.type) &&
        (providerIds === undefined || providerIds.has(instance.id))
    );
    if (subscriptionProviders.length === 0) {
      return config;
    }

    for (const instance of subscriptionProviders) {
      const liveModels =
        await this.providerAdapterRegistry.listModelsForInstance(
          instance,
          () => {
            throw new AtlasApiError(
              `The ${instance.label} subscription adapter cannot load live models.`,
              503
            );
          }
        );
      if (liveModels.length === 0) {
        throw new AtlasApiError(
          `No live models are available for the ${instance.label} subscription on this Atlas host.`,
          503
        );
      }
      const preferredModelId = instance.customModels?.find(
        (model) => model.default
      )?.id;
      await this.persistSubscriptionModelSnapshot(
        orgId,
        instance.id,
        canonicalSubscriptionModelSnapshot(liveModels, preferredModelId)
      );
    }

    return await this.getOrgUserConfig(orgId);
  }

  private withEffectiveCapabilityClaims(
    models: ModelsResponse["models"],
    config: UserConfig | null | undefined
  ): ModelsResponse["models"] {
    return models.map((model) => {
      if (!model.providerId) {
        return model;
      }
      const instance = findProviderInstance(config, model.providerId);
      const adapter = instance
        ? this.providerAdapterRegistry.get(instance.type)
        : undefined;
      if (!(instance && adapter)) {
        return model;
      }
      const capabilities = { ...model.capabilities };

      for (const capabilityId of Object.keys(adapter.manifest.capabilities)) {
        const effective = evaluateCapabilityTarget(
          {
            capabilityId,
            config,
            readApiKey: (provider) =>
              readApiKeyForInstance(provider, process.env),
            registry: this.providerAdapterRegistry,
          },
          { modelId: model.id, providerId: instance.id },
          modelClaimsForCapability(capabilityId, model)
        );
        capabilities[capabilityId] = effective.claim;
      }

      return { ...model, capabilities };
    });
  }

  private buildModelsResponse(options: {
    active: ReturnType<typeof getActiveProviderInstance>;
    catalog?: ModelsResponse["catalog"];
    currentProviderId: string | null;
    providers: ReturnType<typeof toProviderInstanceSummary>[];
    models: ModelsResponse["models"];
    customModels?: ModelsResponse["customModels"];
  }): ModelsResponse {
    const {
      active,
      catalog,
      currentProviderId,
      providers,
      models,
      customModels,
    } = options;

    return {
      baseUrl:
        active?.type === "openai_compatible" ? (active.baseUrl ?? null) : null,
      catalog: catalog ?? AVAILABLE_MODELS,
      currentProviderId,
      customModels:
        customModels ??
        (active &&
        (active.type === "openrouter" || active.type === "openai_compatible")
          ? active.customModels
          : undefined),
      displayName: active?.type === "openai_compatible" ? active.label : null,
      models,
      provider: active?.type ?? null,
      providers,
    };
  }

  getLlmUsageStats() {
    return (
      this.llmUsageTracker?.getStats() ?? {
        estimatedCostUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        requestCount: 0,
        totalTokens: 0,
        trackedSince: new Date().toISOString(),
      }
    );
  }

  getLlmUsageStatsByModel() {
    return this.llmUsageTracker?.getStatsByModel() ?? [];
  }

  async configureProvider(
    orgId: string,
    request: ConfigureProviderRequest
  ): Promise<ConfigureProviderResponse> {
    const createRequest: CreateProviderRequest = isSubscriptionProvider(
      request.provider
    )
      ? { model: request.model, type: request.provider }
      : {
          apiKey: request.apiKey ?? "",
          baseUrl: request.baseUrl,
          customModels: request.customModels,
          hostMode: request.hostMode,
          label: request.displayName,
          model: request.model,
          type: request.provider,
          wireApi: request.wireApi,
        };
    const result = await this.createProvider(orgId, createRequest);

    const instance = findProviderInstance(
      await this.getOrgUserConfig(orgId),
      result.defaultProviderId
    );

    return {
      currentModel: result.initialModel,
      displayName:
        instance?.type === "openai_compatible"
          ? (instance.label ?? null)
          : null,
      provider: result.provider.type,
    };
  }

  private refreshHarness(): void {
    const provider = createProviderFromActiveConfig(
      this.userConfig,
      process.env,
      this.providerAdapterRegistry
    );
    this._providerConfigured =
      isProviderConfigured(this.userConfig) && provider !== null;
    this.sessions.clear();
  }

  private async ensureLegacyChannelMigrated(
    channel: "telegram" | "discord" | "whatsapp",
    orgId: string
  ): Promise<void> {
    const organizations = (await this.db.listOrganizations()).filter(
      (organization) => !organization.archivedAt
    );
    const bootstrapOrg = organizations
      .slice()
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];

    if (bootstrapOrg?.id === orgId) {
      await migrateLegacyChannelToWorkspace(channel, orgId);
    }
  }

  private async getOrgUserConfig(orgId: string): Promise<UserConfig | null> {
    if (this.orgUserConfigs.has(orgId)) {
      return this.orgUserConfigs.get(orgId) ?? null;
    }

    const stored = await this.db.getOrgAiConfig(orgId);
    const storedConfig = parseStoredUserConfig(stored?.config);

    if (storedConfig) {
      this.orgUserConfigs.set(orgId, storedConfig);
      return storedConfig;
    }

    const organizations = (await this.db.listOrganizations()).filter(
      (organization) => !organization.archivedAt
    );
    const bootstrapOrg = organizations
      .slice()
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];

    if (bootstrapOrg?.id === orgId && this.userConfig) {
      const migratedConfig: UserConfig = {
        capabilityConfig: migrateLegacyCapabilityConfig(
          this.userConfig,
          this.userConfig.capabilityConfig
        ),
        defaultProviderId: this.userConfig.defaultProviderId,
        imageModel: this.userConfig.imageModel,
        providers: this.userConfig.providers,
        thinkingEffort: this.userConfig.thinkingEffort,
        thinkingEnabled: this.userConfig.thinkingEnabled,
        timezone: this.userConfig.timezone,
        transcriptionModel: this.userConfig.transcriptionModel,
        visionModel: this.userConfig.visionModel,
      };
      await this.saveOrgUserConfig(orgId, migratedConfig);
      return migratedConfig;
    }

    this.orgUserConfigs.set(orgId, null);
    return null;
  }

  private async saveOrgUserConfig(
    orgId: string,
    config: UserConfig,
    options: { invalidateSessions?: boolean } = {}
  ): Promise<void> {
    await this.db.upsertOrgAiConfig({
      config,
      orgId,
      updatedAt: new Date().toISOString(),
    });
    this.orgUserConfigs.set(orgId, config);
    if (isProviderConfigured(config)) {
      this._providerConfigured = true;
    } else {
      this._providerConfigured = await this.checkAnyProviderConfigured();
    }
    if (options.invalidateSessions !== false) {
      this.invalidateSessionsForOrg(orgId);
    }
  }

  private async getOrgConfigForUpdate(orgId: string): Promise<UserConfig> {
    return (
      (await this.getOrgUserConfig(orgId)) ?? {
        defaultProviderId: null,
        providers: [],
      }
    );
  }

  private async transcribeAudioWithConfig(
    input: TranscribeAudioRequest,
    config: UserConfig | null,
    attribution?: {
      channel?: AgentChannel | typeof UNKNOWN_USAGE_DIMENSION;
      orgId?: string | null;
      profileId?: string | null;
      userId?: string | null;
    }
  ): Promise<TranscribeAudioResponse> {
    const data = input.data?.trim();
    const mediaType = input.mediaType?.trim();
    if (!(data && mediaType)) {
      throw new AtlasApiError("Audio data and media type are required.", 400);
    }
    const bytes = decodeAudioTranscriptionData(data);
    const env = attribution?.orgId?.trim() ? {} : process.env;
    const selection = resolveTranscriptionProviderSelection(
      config,
      env,
      this.providerAdapterRegistry
    );
    if (!selection) {
      throw new AtlasApiError(TRANSCRIPTION_MODEL_REQUIRED_MESSAGE, 400);
    }
    const text = await transcribeAudio(
      selection.instance,
      selection.model,
      {
        bytes,
        filename: input.filename?.trim() || "audio.ogg",
        mediaType,
      },
      env,
      this.providerAdapterRegistry
    );
    const orgId = attribution?.orgId?.trim();
    if (orgId) {
      // Transcription providers do not report token usage; the request count
      // is the Atlas-observed signal.
      this.recordCapabilityUsageDaily({
        capability: PROVIDER_CAPABILITY_IDS.audioTranscription,
        channel:
          attribution?.channel === UNKNOWN_USAGE_DIMENSION
            ? undefined
            : attribution?.channel,
        instance: selection.instance,
        modelId: selection.model,
        orgId,
        profileId: attribution?.profileId,
        userId: attribution?.userId,
      });
    }
    return { text };
  }

  private async generateImageWithConfig(
    input: GenerateImageRequest,
    config: UserConfig | null,
    orgId?: string | null,
    attribution?: {
      channel?: AgentChannel | typeof UNKNOWN_USAGE_DIMENSION;
      profileId?: string | null;
      userId?: string | null;
    }
  ): Promise<GenerateImageResponse> {
    const prompt = input.prompt?.trim();
    if (!prompt) {
      throw new AtlasApiError("Image prompt is required.", 400);
    }
    const selection = resolveImageGenerationSelection(config, {
      registry: this.providerAdapterRegistry,
    });
    if (!selection) {
      throw new AtlasApiError(IMAGE_MODEL_REQUIRED_MESSAGE, 400);
    }
    const result = await generateImage(
      selection,
      {
        prompt,
        size: input.size,
      },
      this.providerAdapterRegistry
    );
    const usage = result.usage ?? { inputTokens: 0, outputTokens: 0 };
    this.llmUsageTracker?.record(
      result.model,
      usage.inputTokens,
      usage.outputTokens,
      {
        provider: selection.instance.type,
        providerInstance: selection.instance,
      }
    );
    if (orgId) {
      this.recordCapabilityUsageDaily({
        capability: PROVIDER_CAPABILITY_IDS.imageGeneration,
        channel:
          attribution?.channel === UNKNOWN_USAGE_DIMENSION
            ? undefined
            : attribution?.channel,
        instance: selection.instance,
        modelId: result.model,
        orgId,
        profileId: attribution?.profileId,
        usage,
        userId: attribution?.userId,
      });
    }
    return {
      data: Buffer.from(result.data).toString("base64"),
      mediaType: result.mediaType,
      model: result.model,
      size: result.size,
      sizeBytes: result.data.byteLength,
      ...(result.revisedPrompt ? { revisedPrompt: result.revisedPrompt } : {}),
    };
  }

  /** After a data-root restore, reload provider config and clear in-memory session state. */
  async reloadAfterDataRestore(): Promise<void> {
    this.userConfig = await loadUserConfig();
    this.orgUserConfigs.clear();
    this.refreshHarness();
    this.composioService?.reloadConfiguration();
    await this.llmUsageTracker?.reloadFromDatabase();
    this.visionSettingsPromise = null;
    this.transcriptionSettingsPromise = null;
    this.providerSettingsPromise = null;
    await this.ensureVisionSettingsLoaded();
    await this.ensureTranscriptionSettingsLoaded();
    await this.ensureProviderSettingsLoaded();
  }

  async listProfiles(orgId: string): Promise<ListProfilesResponse> {
    return this.profileService.listProfiles(orgId);
  }

  async getProfile(orgId: string, profileId: string): Promise<ProfileResponse> {
    return this.profileService.getProfile(orgId, profileId);
  }

  async createProfile(
    orgId: string,
    request: CreateProfileRequest
  ): Promise<ProfileResponse> {
    return this.profileService.createProfile(orgId, request);
  }

  async cloneProfile(
    orgId: string,
    sourceId: string,
    request: CloneProfileRequest = {}
  ): Promise<ProfileResponse> {
    return this.profileService.cloneProfile(orgId, sourceId, request);
  }

  async updateProfile(
    orgId: string,
    profileId: string,
    request: UpdateProfileRequest,
    changeMeta?: ProfileChangeMeta
  ): Promise<ProfileResponse> {
    const response = await this.profileService.updateProfile(
      orgId,
      profileId,
      request,
      changeMeta
    );

    this.invalidateProfileSessions(profileId);

    return response;
  }

  async deleteProfile(orgId: string, profileId: string): Promise<void> {
    await this.profileService.deleteProfile(orgId, profileId);
    this.invalidateProfileSessions(profileId);
  }

  async listTools(orgId: string): Promise<ListToolsResponse> {
    return this.profileService.listTools(orgId);
  }

  async getTool(orgId: string, toolId: string): Promise<ToolResponse> {
    return this.profileService.getTool(orgId, toolId);
  }

  async getToolSource(
    orgId: string,
    toolId: string
  ): Promise<ToolSourceResponse> {
    return this.profileService.getToolSource(orgId, toolId);
  }

  async createTool(orgId: string, request: CreateToolRequest) {
    const tool = await this.profileService.createTool(orgId, request);
    return { tool };
  }

  async deleteTool(orgId: string, toolId: string): Promise<void> {
    await this.profileService.deleteTool(orgId, toolId);
    this.invalidateSessionsForOrg(orgId);
  }

  async runToolPlayground(
    toolId: string,
    parameters: Record<string, unknown>,
    context: { orgId: string; userId: string }
  ): Promise<RunToolResponse> {
    const [orgRole, isPlatformAdmin] = await Promise.all([
      this.resolveOrgRole(context.orgId, context.userId),
      this.resolveIsPlatformAdmin(context.userId),
    ]);
    if (!isPlatformAdmin && orgRole !== "admin") {
      throw new AtlasApiError("Workspace admin access is required.", 403);
    }
    const { tool } = await this.profileService.getTool(context.orgId, toolId);

    if (tool.handlerType !== "javascript") {
      throw new Error(
        "Only custom JavaScript tools can be run in the playground."
      );
    }

    const record = await this.db.getTool(toolId);

    if (!record || (record.orgId != null && record.orgId !== context.orgId)) {
      throw new Error("Tool not found.");
    }

    const profileId = await this.resolvePlaygroundProfileId(
      context.orgId,
      toolId
    );

    const handlerConfig =
      typeof record.handlerConfig === "object" && record.handlerConfig !== null
        ? (record.handlerConfig as { modulePath?: string })
        : null;

    let reloadSucceeded = false;
    if (handlerConfig?.modulePath) {
      try {
        await validateJavascriptToolModule(handlerConfig.modulePath);
        reloadSucceeded = true;
      } catch {
        // Invalid module paths fail when loading the tool.
      }
    }

    const loaded = await loadJavascriptTool(record);

    if (!loaded) {
      throw new Error(`Failed to load tool "${tool.name}".`);
    }

    if (reloadSucceeded) {
      this.invalidateSessionsForOrg(context.orgId);
    }

    const toolContext = buildToolExecutionContext({
      beforeToolCall: this.createToolExecutionGuard(
        context.orgId,
        profileId,
        this.sessionInvalidationVersions.get(context.orgId) ?? 0,
        { isPlatformAdmin, orgRole, userId: context.userId }
      ),
      isPlatformAdmin,
      orgId: context.orgId,
      orgRole: orgRole ?? undefined,
      profileId,
      userId: context.userId,
    });

    const raw = await executeToolCall(
      [loaded],
      {
        arguments: parameters,
        id: `playground_${Date.now()}`,
        name: loaded.name,
      },
      toolContext
    );

    if (
      raw !== null &&
      typeof raw === "object" &&
      "error" in raw &&
      typeof (raw as { error?: unknown }).error === "string"
    ) {
      return { error: (raw as { error: string }).error, ok: false };
    }

    return { ok: true, result: raw };
  }

  async suggestToolPlaygroundParams(
    orgId: string,
    toolId: string,
    prompt: string
  ): Promise<SuggestToolParamsResponse> {
    const { tool } = await this.profileService.getTool(orgId, toolId);

    if (tool.handlerType !== "javascript") {
      throw new Error(
        "Only custom JavaScript tools support parameter suggestions."
      );
    }

    const record = await this.db.getTool(toolId);

    if (!record || (record.orgId != null && record.orgId !== orgId)) {
      throw new Error("Tool not found.");
    }

    const loaded = await loadJavascriptTool(record);
    const userConfig = await this.getOrgUserConfig(orgId);
    const active = getActiveProviderInstance(userConfig);
    const modelId = active ? resolveDefaultModelForInstance(active) : null;
    const provider =
      active && modelId
        ? this.createCapabilityAwareProvider(active, modelId, userConfig)
        : null;
    const parameters = await suggestToolParamsFromPrompt(
      {
        description: tool.description,
        parameters: loaded?.parameters,
        prompt,
        toolName: tool.name,
      },
      { provider: provider ?? undefined }
    );

    return { parameters };
  }

  async listProfileTools(
    orgId: string,
    profileId: string
  ): Promise<ListToolsResponse> {
    return this.profileService.listProfileTools(orgId, profileId);
  }

  async assignTool(
    orgId: string,
    profileId: string,
    request: AssignToolRequest
  ): Promise<ProfileResponse> {
    const response = await this.profileService.assignTool(
      orgId,
      profileId,
      request
    );
    this.invalidateProfileSessions(profileId);
    return response;
  }

  async unassignTool(
    orgId: string,
    profileId: string,
    toolId: string
  ): Promise<ProfileResponse> {
    const response = await this.profileService.unassignTool(
      orgId,
      profileId,
      toolId
    );
    this.invalidateProfileSessions(profileId);
    return response;
  }

  async assignMcpServer(
    orgId: string,
    profileId: string,
    request: { serverId: string }
  ): Promise<ProfileResponse> {
    const response = await this.profileService.assignMcpServer(
      orgId,
      profileId,
      request
    );
    this.invalidateProfileSessions(profileId);
    return response;
  }

  async unassignMcpServer(
    orgId: string,
    profileId: string,
    serverId: string
  ): Promise<ProfileResponse> {
    const response = await this.profileService.unassignMcpServer(
      orgId,
      profileId,
      serverId
    );
    this.invalidateProfileSessions(profileId);
    return response;
  }

  async listSkills(orgId: string): Promise<ListSkillsResponse> {
    return this.requireSkillsService().listSkills(orgId);
  }

  async getSkill(orgId: string, skillId: string): Promise<SkillResponse> {
    return this.requireSkillsService().getSkillForOrg(orgId, skillId);
  }

  async createSkill(
    orgId: string,
    request: CreateSkillRequest,
    options?: { allowGlobal?: boolean }
  ): Promise<SkillResponse> {
    const response = await this.requireSkillsService().createSkill(
      orgId,
      request,
      options
    );
    this.sessions.clear();
    return response;
  }

  async installSkillFromGitHub(
    orgId: string,
    request: InstallSkillRequest,
    changeMeta?: ProfileChangeMeta
  ): Promise<SkillResponse> {
    const response = await this.requireSkillsService().installSkillFromGitHub(
      orgId,
      request,
      changeMeta
    );
    this.sessions.clear();
    return response;
  }

  async patchSkill(
    orgId: string,
    skillId: string,
    request: PatchSkillRequest,
    options?: {
      allowGlobalMutation?: boolean;
      changeMeta?: ProfileChangeMeta;
      profileId?: string;
    }
  ): Promise<SkillResponse> {
    const response = await this.requireSkillsService().patchSkill(
      orgId,
      skillId,
      request,
      options
    );
    this.sessions.clear();
    return response;
  }

  async deleteSkill(
    orgId: string,
    skillId: string,
    options?: { allowGlobalMutation?: boolean }
  ): Promise<void> {
    await this.requireSkillsService().deleteSkill(orgId, skillId, options);
    this.sessions.clear();
  }

  async syncSkills(orgId: string): Promise<SyncSkillsResponse> {
    const response =
      await this.requireSkillsService().syncDiscoveredSkills(orgId);
    this.sessions.clear();
    return response;
  }

  async assignSkill(
    orgId: string,
    profileId: string,
    request: AssignSkillRequest
  ): Promise<ProfileResponse> {
    const response = await this.profileService.assignSkill(
      orgId,
      profileId,
      request
    );
    this.invalidateProfileSessions(profileId);
    return response;
  }

  async unassignSkill(
    orgId: string,
    profileId: string,
    skillId: string
  ): Promise<ProfileResponse> {
    const response = await this.profileService.unassignSkill(
      orgId,
      profileId,
      skillId
    );
    this.invalidateProfileSessions(profileId);
    return response;
  }

  async uploadProfileAvatar(
    orgId: string,
    profileId: string,
    attachment: ImageAttachment
  ): Promise<ProfileResponse> {
    return this.profileService.uploadProfileAvatar(
      orgId,
      profileId,
      attachment
    );
  }

  async getProfileAvatar(
    orgId: string,
    profileId: string
  ): Promise<{ mediaType: string; bytes: Buffer }> {
    return this.profileService.getProfileAvatar(orgId, profileId);
  }

  async getProfileAvatarByProfileId(
    profileId: string
  ): Promise<{ mediaType: string; bytes: Buffer }> {
    return this.profileService.getProfileAvatarByProfileId(profileId);
  }

  async deleteProfileAvatar(orgId: string, profileId: string): Promise<void> {
    return this.profileService.deleteProfileAvatar(orgId, profileId);
  }

  async listKnowledgeBase(
    orgId: string,
    profileId: string
  ): Promise<ListKnowledgeBaseResponse> {
    return this.profileService.listKnowledgeBase(orgId, profileId);
  }

  async uploadKnowledgeBaseDocument(
    orgId: string,
    profileId: string,
    document: DocumentAttachment,
    onDuplicate?: KnowledgeBaseDuplicateAction
  ): Promise<UploadKnowledgeBaseResponse> {
    const response = await this.profileService.uploadKnowledgeBaseDocument(
      orgId,
      profileId,
      document,
      onDuplicate
    );
    this.invalidateProfileSessions(profileId);
    return response;
  }

  async deleteKnowledgeBaseDocument(
    orgId: string,
    profileId: string,
    documentId: string
  ): Promise<DeleteKnowledgeBaseResponse> {
    const response = await this.profileService.deleteKnowledgeBaseDocument(
      orgId,
      profileId,
      documentId
    );
    this.invalidateProfileSessions(profileId);
    return response;
  }

  async readKnowledgeBaseDocument(
    orgId: string,
    profileId: string,
    documentId: string,
    options: { render?: "text" } = {}
  ): Promise<{ bytes: Buffer; contentType: string; filename: string }> {
    return this.profileService.readKnowledgeBaseDocument(
      orgId,
      profileId,
      documentId,
      options
    );
  }

  async getProfileSoulStatus(
    orgId: string,
    profileId: string,
    includeContents = false
  ): Promise<SoulStatusResponse> {
    return withProfileSoulMutationLock(orgId, profileId, async () => {
      const profile = await this.requireProfile(orgId, profileId);
      const status = await getResolvedSoulStatus(orgId, profileId);

      if (!includeContents) {
        return { ...status, profileId };
      }

      const stack = await loadSoulStack(getProfileSoulDir(orgId, profileId));
      return { ...status, contents: stack.files, profileId };
    });
  }

  async ensureSoulScaffolded(orgId?: string): Promise<void> {
    const activeOrgIds = new Set(
      (await this.db.listOrganizations())
        .filter((organization) => !organization.archivedAt)
        .map((organization) => organization.id)
    );
    const profiles = await this.db.listProfiles();

    for (const profile of profiles) {
      const profileOrgId = profile.orgId;
      if (
        !(profileOrgId && activeOrgIds.has(profileOrgId)) ||
        (orgId && profileOrgId !== orgId)
      ) {
        continue;
      }

      await withProfileSoulMutationLock(profileOrgId, profile.id, async () => {
        await initSoulDirectory(getProfileSoulDir(profileOrgId, profile.id));
      });
    }
  }

  async initProfileSoul(
    orgId: string,
    profileId: string
  ): Promise<InitSoulResponse> {
    const result = await withProfileSoulMutationLock(
      orgId,
      profileId,
      async () => {
        await this.requireProfile(orgId, profileId);
        return initSoulDirectory(getProfileSoulDir(orgId, profileId));
      }
    );
    this.invalidateProfileSessions(profileId);
    return { ...result, profileId };
  }

  async getProfileSoulStack(
    orgId: string,
    profileId: string
  ): Promise<SoulStackResponse> {
    return withProfileSoulMutationLock(orgId, profileId, async () => {
      await this.requireProfile(orgId, profileId);
      const stack = await loadSoulStack(getProfileSoulDir(orgId, profileId));
      return { ...stack, profileId };
    });
  }

  async writeProfileSoulFile(
    orgId: string,
    profileId: string,
    key: string,
    request: UpdateSoulFileRequest,
    changeMeta?: ProfileChangeMeta
  ): Promise<void> {
    if (!isWritableSoulFileKey(key)) {
      throw new Error(`Invalid soul file key: ${key}`);
    }

    await withProfileSoulMutationLock(orgId, profileId, async () => {
      await this.requireProfile(orgId, profileId);
      const soulDir = getProfileSoulDir(orgId, profileId);
      const beforeValue = changeMeta
        ? ((await loadSoulStack(soulDir)).files[key] ?? null)
        : null;
      await writeSoulFile(soulDir, key, request.content);

      const field = soulFieldFromKey(key);
      if (changeMeta && field) {
        await new ProfileChangeHistoryService(this.db).recordBestEffort({
          actorUserId: changeMeta.actorUserId,
          afterValue: request.content,
          beforeValue,
          field,
          orgId,
          profileId,
          source: changeMeta.source,
        });
      }
    });
    this.invalidateProfileSessions(profileId);
  }

  async listProfileArtifacts(
    orgId: string,
    profileId: string,
    options: ListArtifactsOptions = {}
  ): Promise<ListArtifactsResponse> {
    await this.requireProfile(orgId, profileId);
    return listArtifacts(orgId, profileId, options);
  }

  private async readProfileArtifactFile(
    orgId: string,
    profileId: string,
    filename: string,
    options: { render?: "markdown" } = {}
  ): Promise<{
    bytes: Buffer;
    contentType: string;
    filePath: string;
    relativePath: string;
  }> {
    try {
      return await readArtifactFile({
        filename,
        orgId,
        profileId,
        render: options.render,
      });
    } catch (error) {
      const mapped = mapArtifactReadError(error, filename);
      throw new AtlasApiError(mapped.message, mapped.status);
    }
  }

  async readProfileArtifact(
    orgId: string,
    profileId: string,
    filename: string,
    options: { render?: "markdown" } = {}
  ) {
    await this.requireProfile(orgId, profileId);
    return this.readProfileArtifactFile(orgId, profileId, filename, options);
  }

  async getProfileArtifactPreview(
    orgId: string,
    profileId: string,
    filename: string,
    options: PreviewOptions = {}
  ): Promise<ArtifactPreview> {
    await this.requireProfile(orgId, profileId);
    const { bytes, contentType, filePath, relativePath } =
      await this.readProfileArtifactFile(orgId, profileId, filename);
    return previewService.generate(
      {
        filename: path.basename(filePath),
        mimeType: contentType,
        path: relativePath,
        revision: options.revision,
        sizeBytes: bytes.length,
      },
      bytes,
      options,
      { orgId, profileId }
    );
  }

  async inspectProfileArtifactPreview(
    orgId: string,
    profileId: string,
    filename: string
  ): Promise<PreviewMetadata> {
    await this.requireProfile(orgId, profileId);
    const { bytes, contentType, filePath, relativePath } =
      await this.readProfileArtifactFile(orgId, profileId, filename);
    return previewService.inspect(
      {
        filename: path.basename(filePath),
        mimeType: contentType,
        path: relativePath,
        sizeBytes: bytes.length,
      },
      bytes,
      { orgId, profileId }
    );
  }

  async getProfileArtifactManifest(
    orgId: string,
    profileId: string,
    filename: string,
    options: PreviewOptions = {}
  ): Promise<PreviewManifest> {
    await this.requireProfile(orgId, profileId);
    const { bytes, contentType, filePath, relativePath } =
      await this.readProfileArtifactFile(orgId, profileId, filename);
    return previewService.generateManifest(
      {
        artifactId: relativePath,
        filename: path.basename(filePath),
        mimeType: contentType,
        path: relativePath,
        revision: options.revision,
        sizeBytes: bytes.length,
      },
      bytes,
      options,
      { orgId, profileId }
    );
  }

  getPreviewJob(jobId: string): PreviewJob | undefined {
    return previewService.getJob(jobId);
  }

  async getProfileArtifactDerivedPdf(
    orgId: string,
    profileId: string,
    filename: string,
    options: PreviewOptions = {}
  ): Promise<{ bytes: Buffer; pageCount: number }> {
    await this.requireProfile(orgId, profileId);
    const { bytes, contentType, filePath, relativePath } =
      await this.readProfileArtifactFile(orgId, profileId, filename);
    return previewService.getOrGenerateDerivedPdf(
      {
        filename: path.basename(filePath),
        mimeType: contentType,
        path: relativePath,
        revision: options.revision,
        sizeBytes: bytes.length,
      },
      bytes,
      options,
      { orgId, profileId }
    );
  }

  async getProfileArtifactThumbnail(
    orgId: string,
    profileId: string,
    filename: string
  ): Promise<{ bytes: Buffer; mimeType: string } | null> {
    await this.requireProfile(orgId, profileId);
    const { bytes, contentType, filePath, relativePath } =
      await this.readProfileArtifactFile(orgId, profileId, filename);
    return previewService.getOrGenerateThumbnail(
      {
        filename: path.basename(filePath),
        mimeType: contentType,
        path: relativePath,
        sizeBytes: bytes.length,
      },
      bytes,
      { orgId, profileId }
    );
  }

  async deleteProfileArtifact(
    orgId: string,
    profileId: string,
    filename: string
  ): Promise<DeleteArtifactResponse> {
    await this.requireProfile(orgId, profileId);
    previewService.invalidate(orgId, profileId, filename);
    return deleteArtifactFile({ filename, orgId, profileId });
  }

  async getUserContext(
    orgId: string,
    userId: string,
    includeContent = false
  ): Promise<UserContextStatusResponse> {
    const raw = await this.db.getUserContext(orgId, userId);
    return buildUserContextStatus(raw, includeContent);
  }

  async initUserContext(
    orgId: string,
    userId: string
  ): Promise<InitUserContextResponse> {
    const existing = normalizeUserContextContent(
      await this.db.getUserContext(orgId, userId)
    );
    if (existing !== undefined) {
      return { created: false };
    }

    await this.db.setUserContext(
      orgId,
      userId,
      USER_CONTEXT_TEMPLATE,
      new Date().toISOString()
    );
    return { created: true };
  }

  async writeUserContext(
    orgId: string,
    userId: string,
    request: UpdateUserContextRequest
  ): Promise<void> {
    await this.db.setUserContext(
      orgId,
      userId,
      request.content,
      new Date().toISOString()
    );
  }

  private async loadUserContextForUser(
    orgId: string,
    userId?: string | null
  ): Promise<string | undefined> {
    if (!userId) {
      return;
    }

    return normalizeUserContextContent(
      await this.db.getUserContext(orgId, userId)
    );
  }

  private createHarness(options: {
    chatCapabilityPolicy?: ChatCapabilityPolicy;
    provider: ProviderClient | null;
    providerInstance?: ReturnType<typeof getActiveProviderInstance>;
    modelId?: string | null;
    thinking: ThinkingSettings;
  }): AgentHarness {
    const providerInstance = options.providerInstance ?? null;

    const trackedProvider =
      options.provider && this.llmUsageTracker && options.modelId
        ? wrapProviderWithUsageTracking(
            options.provider,
            this.llmUsageTracker,
            options.modelId,
            {
              provider: providerInstance?.type ?? null,
              providerInstance,
            }
          )
        : options.provider;

    return createAgentHarness({
      chatCapabilityPolicy: options.chatCapabilityPolicy,
      chatOptions: this.resolveChatProviderOptions(
        providerInstance,
        options.thinking,
        options.modelId
      ),
      provider: trackedProvider ?? undefined,
    });
  }

  getUsageStatusFields(): {
    displayName: string | null;
    costEstimated: boolean;
    currentModel: string | null;
  } {
    const active = getActiveProviderInstance(this.userConfig);
    const currentModel = active ? resolveDefaultModelForInstance(active) : null;

    return {
      costEstimated: isCostEstimated(
        active?.type ?? null,
        currentModel,
        active
      ),
      currentModel,
      displayName:
        active?.type === "openai_compatible" ? (active.label ?? null) : null,
    };
  }

  async getUsageStatusFieldsForOrg(orgId: string): Promise<{
    displayName: string | null;
    costEstimated: boolean;
    currentModel: string | null;
    providerConfigured: boolean;
  }> {
    const config = await this.getOrgUserConfig(orgId);
    const active = getActiveProviderInstance(config);
    const currentModel = active ? resolveDefaultModelForInstance(active) : null;
    return {
      costEstimated: isCostEstimated(
        active?.type ?? null,
        currentModel,
        active
      ),
      currentModel,
      displayName:
        active?.type === "openai_compatible" ? (active.label ?? null) : null,
      providerConfigured: isProviderConfigured(config),
    };
  }

  private async requireActiveOrganizationForTurn(orgId: string): Promise<void> {
    const organization = await this.db.getOrganizationById(orgId);
    if (organization && !organization.archivedAt) {
      return;
    }

    // Preserve the pre-tenant database shape while failing closed as soon as
    // organization rows exist. An archived tenant is therefore never treated
    // as legacy merely because it is the only tenant in the database.
    if (!organization && (await this.db.listOrganizations()).length === 0) {
      return;
    }

    throw new AtlasApiError("Organization not found.", 404);
  }

  private async requireCurrentToolConfiguration(
    orgId: string,
    expectedVersion: number
  ): Promise<void> {
    await this.requireActiveOrganizationForTurn(orgId);
    if (
      (this.sessionInvalidationVersions.get(orgId) ?? 0) === expectedVersion
    ) {
      return;
    }

    throw Object.assign(
      new Error("Tool configuration changed. Retry the request."),
      {
        code: "CANCELLED" as const,
        retryable: false,
      }
    );
  }

  private createToolExecutionGuard(
    orgId: string,
    profileId: string,
    expectedVersion: number,
    principal: {
      isPlatformAdmin?: boolean;
      orgRole?: OrgRole | null;
      userId?: string | null;
      allowChannelFileTools?: boolean;
    }
  ): () => Promise<void> {
    const profileVersion =
      this.profileToolInvalidationVersions.get(profileId) ?? 0;
    return async () => {
      await this.requireCurrentToolConfiguration(orgId, expectedVersion);
      if (
        (this.profileToolInvalidationVersions.get(profileId) ?? 0) !==
        profileVersion
      ) {
        throw Object.assign(
          new Error("Profile tools changed. Retry the request."),
          {
            code: "CANCELLED" as const,
            retryable: false,
          }
        );
      }
      const userId = principal.userId?.trim();
      if (
        !userId ||
        (isChannelGuestUserId(userId) && !principal.allowChannelFileTools)
      ) {
        throw Object.assign(
          new AtlasApiError(
            "A workspace principal is required to use tools.",
            403
          ),
          { code: "PERMISSION_DENIED" as const, retryable: false }
        );
      }
      const [user, member, profile] = await Promise.all([
        this.db.getUserById(userId),
        this.db.getOrgMember(orgId, userId),
        this.db.getProfileForOrg(profileId, orgId),
      ]);
      const isPlatformAdmin = user?.isPlatformAdmin === true;
      if (
        !(user && profile) ||
        (!isPlatformAdmin && (!member || member.role === "viewer")) ||
        isPlatformAdmin !== (principal.isPlatformAdmin === true) ||
        (!isPlatformAdmin &&
          (member?.role ?? null) !== (principal.orgRole ?? null)) ||
        (profile.isSuper &&
          !canAccessSuperAgentProfile({
            isPlatformAdmin,
            orgRole: member?.role,
          }))
      ) {
        throw Object.assign(
          new AtlasApiError("Tool access changed. Retry the request.", 403),
          { code: "PERMISSION_DENIED" as const, retryable: false }
        );
      }
    };
  }

  private async requireProfile(
    orgId: string,
    profileId: string
  ): Promise<StoredProfileRecord> {
    if (profileId === "default" || !profileId.trim()) {
      const defaultProfile = await this.db.getDefaultProfileForOrg(orgId);
      if (defaultProfile) {
        return defaultProfile;
      }
      throw new AtlasApiError("Profile not found.", 404);
    }

    const profile = await this.db.getProfileForOrg(profileId, orgId);

    if (!profile) {
      throw new AtlasApiError("Profile not found.", 404);
    }

    return profile;
  }

  private async resolveSessionProfile(
    orgId: string,
    profileId?: string
  ): Promise<string> {
    if (profileId?.trim()) {
      const requestedProfile = await this.db.getProfileForOrg(
        profileId.trim(),
        orgId
      );

      if (requestedProfile) {
        return profileId.trim();
      }
    }

    const defaultProfile = await this.db.getDefaultProfileForOrg(orgId);

    if (defaultProfile) {
      return defaultProfile.id;
    }

    throw new Error(
      "No profiles exist for this organization. Create a profile in the web dashboard first."
    );
  }

  private async resolveProfileTools(
    profile: StoredProfileRecord,
    options: {
      includeAutomationTools?: boolean;
      includeQuestionTools?: boolean;
      includeSkillManageTools?: boolean;
      includeSubAgentTool?: boolean;
      includeTodoTools?: boolean;
      sessionId?: string;
      userId?: string | null;
    } = {},
    userConfig: UserConfig | null = this.userConfig
  ): Promise<ToolDefinition[]> {
    const storedTools = (await this.db.listToolsForProfile(profile.id)).filter(
      (tool) => tool.orgId == null || tool.orgId === profile.orgId
    );
    const deepResearchOverride = createDeepResearchServerTool({
      resolveProvider: () =>
        this.resolveProviderClientForProfile(profile, userConfig),
    });
    const tools = await resolveProfileStoredTools(
      storedTools,
      this.db,
      [deepResearchOverride],
      {
        userConfig,
      }
    );
    const includeAutomationTools = options.includeAutomationTools ?? true;
    const includeTodoTools = options.includeTodoTools ?? true;
    const includeQuestionTools = options.includeQuestionTools ?? true;
    const includeSubAgentTool = options.includeSubAgentTool ?? true;
    // Default follows interactive automation-tool gate; messaging channels pass false.
    const includeSkillManageTools =
      options.includeSkillManageTools ?? includeAutomationTools;

    let resolved = [...tools];

    // Search activation is a session discovery hint, never an authorization
    // source. Only the profile's current assignments may populate its tools.

    if (this.mcpClientManager) {
      const orgId = profile.orgId;

      if (!orgId) {
        throw new Error("Profile organization is missing.");
      }

      const mcpServers = (
        await this.db.listMcpServersForProfile(profile.id)
      ).filter((server) => server.orgId === orgId);

      resolved = [
        ...resolved,
        ...buildMcpToolDefinitions(
          mcpServers,
          this.mcpClientManager,
          orgId,
          profile.id,
          () => this.db.listMcpServersForProfile(profile.id)
        ),
      ];
    }

    if (
      this.composioService &&
      this.mcpClientManager &&
      options.userId &&
      !isServiceAccountUserId(options.userId)
    ) {
      const orgId = profile.orgId;

      if (!orgId) {
        throw new Error("Profile organization is missing.");
      }

      resolved = [
        ...resolved,
        ...(await buildComposioConnectTools(
          orgId,
          options.userId,
          profile.id,
          this.composioService
        )),
        ...(await buildComposioToolDefinitions(
          orgId,
          options.userId,
          profile.id,
          this.composioService,
          this.mcpClientManager
        )),
      ];
    }

    if (includeAutomationTools && this.automationTools.length > 0) {
      resolved = [...resolved, ...this.automationTools];
    }

    if (includeTodoTools && this.todoTools.length > 0) {
      resolved = [...resolved, ...this.todoTools];
    }

    if (includeQuestionTools && this.questionTools.length > 0) {
      resolved = [...resolved, ...this.questionTools];
    }

    if (this.skillsService) {
      const orgId = profile.orgId;

      if (!orgId) {
        throw new Error("Profile organization is missing.");
      }

      const skillTools = await this.skillsService.loadToolsForProfile(
        orgId,
        profile.id
      );
      resolved = [...resolved, ...skillTools];

      // Interactive web/cli only: messaging, automation, task, and subagent omit this.
      if (includeSkillManageTools) {
        const assignedSkills = await this.skillsService.listSkillsForProfile(
          profile.id
        );
        if (assignedSkills.some((skill) => skill.name === "manage-skills")) {
          resolved = [
            ...resolved,
            ...createSkillManageTools({
              skillProposalService: this.skillProposalService,
              skillsService: this.skillsService,
            }),
          ];
        }
      }
    }

    if (profile.isSuper) {
      resolved = [...resolved, ...this.superAgentTools];
    }

    resolved = [...resolved, ...this.orgMemoryTools];

    if (!includeSubAgentTool) {
      resolved = resolved.filter((tool) => tool.name !== SUB_AGENT_TOOL_NAME);
    }

    return withToolSearchCatalog(resolved);
  }

  private async shouldForbidProfileSkillMarkdownWrites(
    profileId: string
  ): Promise<boolean> {
    if (!this.skillsService) {
      return false;
    }

    const assigned = await this.skillsService.listSkillsForProfile(profileId);
    return assignedSkillsForbidMarkdownWrites(
      assigned.map((skill) => skill.name)
    );
  }

  private invalidateProfileSessions(profileId: string): void {
    this.profileToolInvalidationVersions.set(
      profileId,
      (this.profileToolInvalidationVersions.get(profileId) ?? 0) + 1
    );
    for (const [sessionId, record] of this.sessions.entries()) {
      if (record.profileId === profileId) {
        this.chatToolApprovals.cancelSession(sessionId);
        this.sessions.delete(sessionId);
      }
    }
  }

  async invalidateSessionsForUser(
    orgId: string,
    userId: string
  ): Promise<void> {
    // A registered stream may still be building its uncached chat session.
    const sessionIds = new Set(
      (await this.db.listSessions())
        .filter((record) => record.orgId === orgId && record.userId === userId)
        .map((record) => record.id)
    );
    for (const [sessionId, record] of this.sessions) {
      if (record.orgId === orgId && record.userId === userId) {
        sessionIds.add(sessionId);
      }
    }
    for (const sessionId of sessionIds) {
      this.chatToolApprovals.cancelSession(sessionId);
      sessionTurnRegistry.cancelTurn(sessionId);
      this.sessions.delete(sessionId);
      this.superAgentSessionState.clearSession(sessionId);
      this.agentTodoState.clearSession(sessionId);
      this.agentQuestionnaireState.clearSession(sessionId);
    }
  }

  private rememberSession(
    sessionId: string,
    record: StoredSession,
    mcpAvailabilityVersion: number
  ): void {
    this.sessions.set(sessionId, record);
    if (
      (this.mcpAvailabilityVersions.get(record.orgId) ?? 0) !==
      mcpAvailabilityVersion
    ) {
      this.refreshSessionAfterTurn(sessionId, record);
    }
  }

  private refreshSessionAfterTurn(
    sessionId: string,
    record: StoredSession
  ): void {
    sessionTurnRegistry.afterTurn(sessionId, () => {
      if (this.sessions.get(sessionId) === record) {
        this.sessions.delete(sessionId);
      }
    });
  }

  invalidateSessionsForOrg(orgId: string): void {
    this.chatToolApprovals.cancelOrg(orgId);
    this.sessionInvalidationVersions.set(
      orgId,
      (this.sessionInvalidationVersions.get(orgId) ?? 0) + 1
    );
    const sessionIds = new Set(sessionTurnRegistry.cancelTurnsForOrg(orgId));

    for (const [sessionId, record] of this.sessions.entries()) {
      if (record.orgId === orgId) {
        sessionIds.add(sessionId);
        this.sessions.delete(sessionId);
      }
    }

    for (const sessionId of sessionIds) {
      this.superAgentSessionState.clearSession(sessionId);
      this.agentTodoState.clearSession(sessionId);
      this.agentQuestionnaireState.clearSession(sessionId);
    }
  }

  private async buildChatSession(
    channel: AgentChannel,
    orgId: string,
    profileId: string,
    sessionId: string,
    modelOverride: string | null,
    userId?: string | null,
    orgRole?: OrgRole | null,
    isPlatformAdmin?: boolean
  ): Promise<AgentChatSession> {
    let userConfig = await this.getOrgUserConfig(orgId);
    const profile = await this.requireProfile(orgId, profileId);
    const isGuestPrincipal = isChannelGuestUserId(userId);
    const selectedModel = modelOverride ?? profile.model;
    const decodedSelection = decodeStoredModelSelection(selectedModel);
    const selectedProviderId =
      decodedSelection && decodedSelection.providerId !== "__unknown__"
        ? decodedSelection.providerId
        : selectedModel?.trim()
          ? undefined
          : userConfig?.defaultProviderId;
    userConfig = await this.refreshSubscriptionModelSnapshots(
      orgId,
      userConfig,
      new Set(selectedProviderId ? [selectedProviderId] : [])
    );
    const toolConfigurationVersion =
      this.sessionInvalidationVersions.get(orgId) ?? 0;
    const beforeToolCall = this.createToolExecutionGuard(
      orgId,
      profileId,
      toolConfigurationVersion,
      {
        allowChannelFileTools: ["telegram", "whatsapp", "discord"].includes(
          channel
        ),
        isPlatformAdmin,
        orgRole,
        userId,
      }
    );
    const includeSkillManageTools = channel === "web" || channel === "cli";
    let tools = await resolveExecutableToolsForPrincipal(
      userId,
      () =>
        this.resolveProfileTools(
          profile,
          {
            includeSkillManageTools,
            sessionId,
            userId,
          },
          userConfig
        ),
      { channel }
    );
    if (channel === "discord" && !isGuestPrincipal) {
      tools = [...tools, ...createSendDiscordArtifactTools()];
    }
    const knowledgeBaseSearchAvailable = tools.some(
      (tool) => tool.name === "knowledge_base_search"
    );
    const skillUsageContext =
      channel === "web" || channel === "cli"
        ? { seenCatalogSkillIds: new Set<string>(), sessionId }
        : undefined;
    const { systemPrompt, soulActive } = await this.resolveProfileSystemPrompt(
      orgId,
      profileId,
      profile.systemPrompt,
      orgRole,
      skillUsageContext,
      userId
    );
    // Per-org override for the tool-output optimiser. Undefined leaves the
    // decision to the server's env var, so an operator who never opened the UI
    // keeps whatever they configured.
    const tokenOptimizerEnabled = (await this.db.getWorkspaceSettings(orgId))
      ?.tokenOptimizerEnabled;
    const resolvedSystemPrompt = isGuestPrincipal
      ? systemPrompt
      : appendRuntimeProfileRules(profile.isSuper, systemPrompt);
    const initialHistory = await loadSessionHistory(this.db, sessionId);
    const userTimezone = userConfig?.timezone ?? DEFAULT_TIMEZONE;
    const userContext = isGuestPrincipal
      ? undefined
      : await this.loadUserContextForUser(orgId, userId);
    const compaction = this.resolveCompactionConfig(
      profile,
      userConfig,
      selectedModel
    );
    const harness = this.createHarnessForProfile(
      profile,
      userConfig,
      selectedModel
    );
    const turnAttachments = createTurnAttachmentSaver(this.db, {
      channel,
      orgId,
      profileId,
      sessionId,
    });
    const loadAttachment = createAttachmentLoader(this.db, {
      orgId,
      profileId,
    });
    const primarySupportsVision = resolvePrimaryModelVisionSupport(
      userConfig,
      selectedModel,
      this.providerAdapterRegistry
    );
    const describeForNonVisionPrimary = async (
      images: ReturnType<typeof extractImageParts>
    ): Promise<string[]> =>
      describeImagesWithConfiguredVisionModel(userConfig, images, {
        recordUsage: (model, usage, instance) => {
          this.llmUsageTracker?.record(
            model,
            usage.inputTokens,
            usage.outputTokens,
            {
              provider: instance.type,
              providerInstance: instance,
            }
          );
          this.recordCapabilityUsageDaily({
            capability: PROVIDER_CAPABILITY_IDS.imageUnderstanding,
            channel,
            instance,
            modelId: model,
            orgId,
            profileId,
            usage,
            userId,
          });
        },
        registry: this.providerAdapterRegistry,
      });
    const forbidProfileSkillMarkdownWrites = isGuestPrincipal
      ? true
      : await this.shouldForbidProfileSkillMarkdownWrites(profile.id);
    const expandLearnCommand = shouldExpandLearnCommand(channel, tools);
    let forceSkillWriteProposal = false;

    const session = harness.createChatSession({
      channel,
      compaction,
      enableToolLoop: tools.length > 0,
      initialHistory,
      preprocessHistoryForTurn: async (messages) => {
        if (primarySupportsVision !== false) {
          return messages;
        }

        const rehydrated = await rehydrateAttachmentMessages(
          messages,
          loadAttachment
        );
        const missingImages = rehydrated.flatMap((message) =>
          message.role === "user"
            ? extractImageParts(message.content).filter(
                (image) => !image.description?.trim()
              )
            : []
        );
        if (missingImages.length === 0) {
          return messages;
        }

        const descriptions = await describeForNonVisionPrimary(missingImages);
        return addMissingImageDescriptionsToHistory(messages, descriptions);
      },
      preprocessUserContent: async (content) => {
        const commandText =
          typeof content === "string"
            ? content
            : content.find((part) => part.type === "text")?.text;
        forceSkillWriteProposal = Boolean(
          expandLearnCommand &&
            commandText &&
            tryParseLearnCommand(commandText) !== null
        );
        content = await persistInlineAttachmentsInContent(
          content,
          turnAttachments.save
        );

        if (!messageContentHasImages(content)) {
          return content;
        }

        const forVision = await rehydrateAttachmentRefsInContent(
          content,
          loadAttachment
        );

        if (primarySupportsVision !== false) {
          return content;
        }

        const descriptions = await describeForNonVisionPrimary(
          extractImageParts(forVision)
        );

        return replaceImagePartsWithDescriptions(content, descriptions);
      },
      rehydrateMessagesForProvider: async (messages) => {
        const rehydrated = await rehydrateAttachmentMessages(
          messages,
          loadAttachment
        );
        return expandLearnCommand
          ? expandLearnInLastUserMessage(rehydrated)
          : rehydrated;
      },
      resolvePromptContext: async (context) => {
        const parts: string[] = [];

        if (!isGuestPrincipal && userId && context?.userMessage?.trim()) {
          try {
            const memories = await this.memoryService.searchVisibleMemories(
              orgId,
              context.userMessage,
              {
                limit: 8,
                profileId,
                userId,
              }
            );
            const memoryContext = composeTurnMemoryContext(
              memories.map((item) => ({
                content: item.content,
                importance: item.importance,
                subject: item.subject,
                updatedAt: item.updatedAt,
              }))
            );
            if (memoryContext.trim()) {
              parts.push(memoryContext.trim());
            }
          } catch {
            // Memory retrieval must never fail the turn.
          }
        }

        if (knowledgeBaseSearchAvailable && context?.userMessage?.trim()) {
          const knowledgeBaseGrounding =
            await composeKnowledgeBaseTurnGrounding({
              orgId,
              profileId,
              userMessage: context.userMessage,
            });

          if (knowledgeBaseGrounding.trim()) {
            parts.push(knowledgeBaseGrounding.trim());
          }
        }

        const todoContext =
          await this.agentTodoState.formatForPrompt(sessionId);

        if (todoContext.trim()) {
          parts.push(todoContext.trim());
        }

        if (!isGuestPrincipal && this.composioService && userId) {
          const composioContext =
            await this.composioService.formatProfileConnectionsContext(
              orgId,
              userId,
              profileId
            );

          if (composioContext.trim()) {
            parts.push(composioContext.trim());
          }
        }

        if (
          !isGuestPrincipal &&
          this.skillsService &&
          context?.userMessage?.trim()
        ) {
          const skillContext =
            await this.skillsService.formatMatchedSkillsForPrompt(
              orgId,
              profileId,
              context.userMessage,
              {
                appendContext: async (matched) => {
                  const parts: string[] = [];

                  if (
                    profile.isSuper &&
                    matched.some((skill) => skill.name === "create-profile")
                  ) {
                    parts.push(
                      await this.formatProfileAuthoringToolContext(orgId)
                    );
                  }

                  if (matched.some((skill) => skill.name === "coding-agent")) {
                    parts.push(
                      await this.formatCodingDelegationContext(orgId, profileId)
                    );
                  }

                  return parts.filter(Boolean).join("\n\n");
                },
                usageContext: skillUsageContext,
              }
            );

          if (skillContext.trim()) {
            parts.push(skillContext.trim());
          }
        }

        return parts.join("\n\n");
      },
      soul: soulActive,
      systemPrompt: resolvedSystemPrompt,
      toolContext: buildToolExecutionContext({
        beforeToolCall: async (toolName) => {
          if (
            isGuestPrincipal &&
            !(toolName && isChannelWorkFileTool(toolName))
          ) {
            throw new AtlasApiError(
              "Channel guest tool is outside work-file scope",
              403
            );
          }
          await beforeToolCall();
          if (
            channel === "telegram" ||
            channel === "whatsapp" ||
            channel === "discord"
          ) {
            await this.channelNativeActions.authorizeTool(
              orgId,
              sessionId,
              channel,
              toolName
            );
          }
        },
        channel,
        forbidProfileSkillMarkdownWrites,
        forceSkillWriteProposal: () => forceSkillWriteProposal,
        isPlatformAdmin: isPlatformAdmin === true,
        loadAttachment,
        onToolTurnEnd: (runId, status, results) =>
          this.chatToolApprovals.complete(runId, status, results),
        orgId,
        orgRole: orgRole ?? undefined,
        profileId,
        recordToolOutputSavings: this.savingsRecorderFor(orgId),
        recordTurnUsage: this.turnUsageRecorderFor(
          orgId,
          this.buildUsageAttribution({
            channel,
            modelSelection: selectedModel,
            orgId,
            profileId,
            userConfig,
            userId,
          })
        ),
        requestChannelAction: (action, onPending, signal) =>
          this.channelNativeActions.request(
            {
              beforeToolCall,
              channel,
              orgId,
              profileId,
              sessionId,
              signal,
              userId: userId ?? undefined,
            },
            action,
            onPending
          ),
        requestToolApproval: async (request, onPending) => {
          if (!userId) {
            throw new AtlasApiError(
              "A session principal is required for approval.",
              403
            );
          }
          return this.chatToolApprovals.request(
            {
              ...request,
              beforeDecision: async () => {
                await beforeToolCall();
                if (
                  !(await this.canAccessSession(
                    orgId,
                    sessionId,
                    { userId },
                    "invoke"
                  ))
                ) {
                  throw new AtlasApiError(
                    "Session access has been revoked.",
                    403
                  );
                }
              },
              principal: {
                isPlatformAdmin: isPlatformAdmin === true,
                orgId,
                orgRole: orgRole ?? "member",
                userId,
              },
              sessionId,
            },
            onPending
          );
        },
        sessionId,
        tokenOptimizerEnabled: tokenOptimizerEnabled ?? undefined,
        userId: userId ?? undefined,
      }),
      tools,
      userContext,
      userTimezone,
    });

    return wrapPersistedSession(sessionId, session, this.db, {
      beforePersist: () => this.requireActiveOrganizationForTurn(orgId),
      onBeginTurn: (id, userMessage) => {
        const attachmentTurnId = turnAttachments.beginTurn();
        this.superAgentSessionState.beginTurn(id, userMessage);
        void this.agentQuestionnaireState.clear(id);
        return attachmentTurnId;
      },
      onSendRejected: (_id, _error, turnId) =>
        turnId ? turnAttachments.rollbackTurn(turnId) : Promise.resolve(),
      onSendResolved: (_id, turnId) => {
        if (turnId) {
          turnAttachments.commitTurn(turnId);
        }
      },
      onToolEvidenceRetained: (_id, turnId) => {
        if (turnId) {
          turnAttachments.commitTurn(turnId);
        }
      },
      runTurn: (turnId, operation) => {
        if (!turnId) {
          throw new Error("Attachment turn was not initialized.");
        }
        return turnAttachments.runTurn(turnId, operation);
      },
    });
  }

  private async formatProfileAuthoringToolContext(
    orgId: string
  ): Promise<string> {
    const { tools } = await this.profileService.listTools(orgId);
    const lines = tools
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((tool) => {
        const source = tool.handlerType === "builtin" ? "builtin" : "custom";
        return `- ${tool.name} (${source}, id: ${tool.id}) - ${tool.description}`;
      });

    if (lines.length === 0) {
      return "";
    }

    return [
      "# Available Tools for Profile Creation",
      "Use this current tool inventory to choose a small, relevant starter tool set. Do not assign every tool by default.",
      ...lines,
    ].join("\n");
  }

  private async formatCodingDelegationContext(
    orgId: string,
    profileId: string
  ): Promise<string> {
    const profile = await this.db.getProfile(profileId);
    const providerPassthroughEnabled =
      await loadCodingAgentProviderPassthroughForOrg(this.db, orgId);
    const probeContext = {
      profileModel: profile?.model ?? null,
      providerPassthroughEnabled,
      scopeKey: orgId,
      userConfig: await this.getOrgUserConfig(orgId),
    };
    const installed = await listInstalledCodingAgentHarnesses(
      this.db,
      probeContext
    );
    const workspaceRoot = getProfileSoulDir(orgId, profileId);

    if (installed.length === 0) {
      const installLines = [
        "# Coding Agent Harness",
        "No coding agent CLI is installed on this host.",
        "Install one with bash (shared host — confirm with the operator before global installs), then retry:",
        "",
        `- Codex: \`${getCodingHarnessInstallCommand("codex")}\``,
        `- Claude Code: \`${getCodingHarnessInstallCommand("claude_code")}\``,
        `- OpenCode: \`${getCodingHarnessInstallCommand("opencode")}\``,
        `- pi: \`${getCodingHarnessInstallCommand("pi")}\``,
        "",
        "Cursor Agent CLI (`agent`) cannot be auto-installed. Tell the user to install and authenticate it on the host themselves, then verify with `agent --version`.",
      ];
      return installLines.join("\n");
    }

    if (installed.length > 1) {
      const names = installed
        .map((harness) => `- ${harness.name} (\`${harness.command}\`)`)
        .join("\n");
      return [
        "# Coding Agent Harness",
        "Multiple coding agent CLIs are installed. Ask the user which one to use before running a coding task.",
        "Do not pick one silently.",
        "",
        "Installed:",
        names,
        "",
        "After the user chooses, run that CLI via `bash` with `codingAgent: true` (or a command that starts with the harness binary).",
      ].join("\n");
    }

    const harness = installed[0]!;
    return this.formatSingleCodingHarnessContext(
      harness,
      workspaceRoot,
      probeContext
    );
  }

  private async formatSingleCodingHarnessContext(
    harness: CodingAgentHarnessStatus,
    workspaceRoot: string,
    probeContext: {
      userConfig: UserConfig | null;
      profileModel: string | null;
      providerPassthroughEnabled: boolean;
    }
  ): Promise<string> {
    try {
      const template = await buildCodingAgentCommandTemplate(
        harness,
        "<task prompt>",
        workspaceRoot,
        probeContext
      );
      const backendSkillName = getBackendSkillName(harness.kind);
      const backendSkill = await readBundledSkillBody(backendSkillName);

      return [
        formatCodingAgentCommandContext(template),
        "",
        "# Backend Guidance",
        backendSkill,
      ].join("\n");
    } catch {
      return [
        "# Coding Agent Harness",
        `${harness.name} is installed (\`${harness.command}\`) but is not ready yet.`,
        probeContext.providerPassthroughEnabled
          ? "Check Settings → Provider for passthrough compatibility, or retry after the CLI finishes installing."
          : "Authenticate the CLI on the server host, then retry.",
      ].join("\n");
    }
  }

  private async resolveProfileSystemPrompt(
    orgId: string,
    profileId: string,
    profilePrompt: string,
    orgRole?: OrgRole | null,
    usageContext?: import("./skills-service").SkillUsageRecordingContext,
    userId?: string | null
  ): Promise<{ systemPrompt: string; soulActive: boolean }> {
    const isGuestPrincipal = isChannelGuestUserId(userId);
    const stack = await resolveSoulStackForProfile(orgId, profileId);
    let systemPrompt = stack
      ? composeSoulSystemPrompt(stack, {
          includeMemory: !isGuestPrincipal,
          profilePrompt,
        })
      : profilePrompt;

    if (!isGuestPrincipal && this.skillsService) {
      const skillsCatalog = await this.skillsService.composeCatalogForProfile(
        orgId,
        profileId,
        usageContext
      );

      if (skillsCatalog.trim()) {
        systemPrompt = `${systemPrompt.trim()}\n\n${skillsCatalog.trim()}`;
      }

      const agentBrowserCapability =
        await this.skillsService.composeAgentBrowserCapabilityForProfile(
          orgId,
          profileId
        );

      if (agentBrowserCapability.trim()) {
        systemPrompt = `${systemPrompt.trim()}\n\n${agentBrowserCapability.trim()}`;
      }
    }

    const kbCatalog = isGuestPrincipal
      ? ""
      : await composeKnowledgeBaseCatalog(orgId, profileId);

    if (kbCatalog.trim()) {
      systemPrompt = `${systemPrompt.trim()}\n\n${kbCatalog.trim()}`;
    }

    if (!isGuestPrincipal && orgRole !== "viewer") {
      const orgMemorySummary =
        await this.getOrgMemoryService().getSummary(orgId);
      systemPrompt = appendOrgMemorySection(
        systemPrompt,
        orgMemorySummary,
        orgRole
      );
    }

    if (!isGuestPrincipal) {
      try {
        const activeMemories = await this.memoryService.listVisibleMemories(
          orgId,
          {
            limit: 10,
            profileId,
            userId,
          }
        );
        if (activeMemories.length > 0) {
          const memLines = activeMemories.map(
            (m) =>
              `- [${m.scope.toUpperCase()}${m.subject ? `: ${m.subject}` : ""}] ${m.content}`
          );
          systemPrompt = `${systemPrompt.trim()}\n\n## Active Scoped Memories\n${memLines.join("\n")}`;
        }
      } catch {
        // Non-blocking
      }
    }

    return {
      soulActive: Boolean(stack),
      systemPrompt,
    };
  }

  getMemoryService(): MemoryService {
    return this.memoryService;
  }

  private requireSkillsService(): SkillsService {
    if (!this.skillsService) {
      throw new Error("Skills service is not configured.");
    }

    return this.skillsService;
  }

  private resolveConfiguredProviderSelection(
    userConfig: UserConfig | null,
    modelSelection: string | null | undefined
  ): ReturnType<typeof resolveProfileProviderSelection> {
    const resolved = resolveProfileProviderSelection({
      defaultProviderId: userConfig?.defaultProviderId,
      profileModel: modelSelection,
      providers: userConfig?.providers ?? [],
    });
    const explicit = decodeStoredModelSelection(modelSelection);
    const explicitModelId = explicit?.modelId.trim();

    if (
      resolved &&
      explicitModelId &&
      explicit?.providerId === resolved.instance.id &&
      !isSubscriptionProvider(resolved.instance.type)
    ) {
      return { ...resolved, model: explicitModelId };
    }

    return resolved;
  }

  private resolveProviderClientForProfile(
    profile: StoredProfileRecord,
    userConfig: UserConfig | null = this.userConfig
  ): ProviderClient | null {
    const resolved = this.resolveConfiguredProviderSelection(
      userConfig,
      profile.model
    );

    if (!resolved) {
      return null;
    }

    return this.createCapabilityAwareProvider(
      resolved.instance,
      resolved.model,
      userConfig
    );
  }

  private createCapabilityAwareProvider(
    instance: ProviderInstance,
    modelId: string,
    userConfig: UserConfig | null
  ): ProviderClient | null {
    return createChatCapabilityAwareProvider({
      config: userConfig,
      env: process.env,
      instance,
      modelId,
      registry: this.providerAdapterRegistry,
    });
  }

  private resolveChatCapabilityPolicyForTarget(
    userConfig: UserConfig | null,
    instance: ProviderInstance,
    modelId: string
  ): ChatCapabilityPolicy {
    const modelEvidence = getModelsForProviderInstance(instance).find(
      (model) => model.id === modelId
    );
    return resolveChatCapabilityPolicy({
      config: userConfig,
      instance,
      model: modelEvidence,
      modelId,
      readApiKey: (provider) => readApiKeyForInstance(provider, process.env),
      registry: this.providerAdapterRegistry,
    });
  }

  private createHarnessForProfile(
    profile: StoredProfileRecord,
    userConfig: UserConfig | null = this.userConfig,
    modelSelection: string | null = profile.model
  ): AgentHarness {
    const resolved = this.resolveConfiguredProviderSelection(
      userConfig,
      modelSelection
    );

    if (!resolved) {
      return this.createHarness({
        modelId: null,
        provider: null,
        providerInstance: null,
        thinking: this.resolveWorkspaceThinkingDefaults(userConfig),
      });
    }

    const provider = createProviderForInstance(
      resolved.instance,
      resolved.model,
      process.env,
      this.providerAdapterRegistry
    );
    const primarySupportsVision = resolvePrimaryModelVisionSupport(
      userConfig,
      modelSelection,
      this.providerAdapterRegistry
    );
    const resolvedProvider =
      primarySupportsVision === false && provider
        ? wrapProviderForNonVision(provider)
        : provider;
    const chatCapabilityPolicy = this.resolveChatCapabilityPolicyForTarget(
      userConfig,
      resolved.instance,
      resolved.model
    );

    return this.createHarness({
      chatCapabilityPolicy,
      modelId: resolved.model,
      provider: resolvedProvider,
      providerInstance: resolved.instance,
      thinking: this.resolveWorkspaceThinkingDefaults(userConfig),
    });
  }

  private async normalizeSessionModelOverride(
    orgId: string,
    model: string | null | undefined
  ): Promise<string | null> {
    const normalized = model?.trim();
    if (!normalized) {
      return null;
    }

    const decoded = decodeStoredModelSelection(normalized);
    const providerId = decoded?.providerId.trim();
    const modelId = decoded?.modelId.trim();
    if (!(providerId && modelId) || providerId === "__unknown__") {
      throw new AtlasApiError(
        "Select a model from a configured provider.",
        400
      );
    }

    const userConfig = await this.getOrgUserConfig(orgId);
    const provider = userConfig?.providers.find(
      (instance) => instance.id === providerId
    );
    if (!provider) {
      throw new AtlasApiError(
        "The selected model provider is not configured in this workspace.",
        400
      );
    }

    const modelIsApproved = (
      await this.mergeConfiguredProviderModels(orgId, [provider])
    ).some((entry) => entry.id === modelId);
    if (!modelIsApproved) {
      throw new AtlasApiError(
        "Select a model approved for this provider in the workspace.",
        400
      );
    }

    return `${provider.id}::${modelId}`;
  }

  private async resolveApprovedStoredSessionModelOverride(
    orgId: string,
    record: StoredSessionRecord
  ): Promise<string | null> {
    const storedOverride = record.modelOverride?.trim();
    if (!storedOverride) {
      return null;
    }

    const decoded = decodeStoredModelSelection(storedOverride);
    const providerId = decoded?.providerId.trim();
    const modelId = decoded?.modelId.trim();
    const userConfig = await this.getOrgUserConfig(orgId);
    const provider = userConfig?.providers.find(
      (instance) => instance.id === providerId
    );
    const isStillApproved = Boolean(
      provider &&
        modelId &&
        (await this.mergeConfiguredProviderModels(orgId, [provider])).some(
          (entry) => entry.id === modelId
        )
    );

    if (isStillApproved) {
      return storedOverride;
    }

    throw new AtlasApiError(
      "The selected session model is no longer available. Select an available model to continue this session.",
      409
    );
  }

  private async resolvePlaygroundProfileId(
    orgId: string,
    toolId: string
  ): Promise<string> {
    const profiles = await this.db.listProfilesForOrg(orgId);

    for (const profile of profiles) {
      const tools = await this.db.listToolsForProfile(profile.id);

      if (tools.some((tool) => tool.id === toolId)) {
        return profile.id;
      }
    }

    const defaultProfile = await this.db.getDefaultProfileForOrg(orgId);

    if (defaultProfile) {
      return defaultProfile.id;
    }

    if (profiles[0]) {
      return profiles[0].id;
    }

    throw new Error("No profile available for playground execution.");
  }

  private resolveCompactionConfig(
    profile: StoredProfileRecord,
    userConfig: UserConfig | null = this.userConfig,
    modelSelection: string | null = profile.model
  ): CompactionConfig | undefined {
    const resolved = this.resolveConfiguredProviderSelection(
      userConfig,
      modelSelection
    );

    if (!resolved) {
      return;
    }

    return resolveModelCompactionConfig(resolved.instance, resolved.model);
  }

  private resolveWorkspaceThinkingDefaults(
    userConfig: UserConfig | null = this.userConfig
  ): ThinkingSettings {
    return {
      effort: userConfig?.thinkingEffort ?? DEFAULT_THINKING_EFFORT,
      enabled: userConfig?.thinkingEnabled ?? DEFAULT_THINKING_ENABLED,
    };
  }
}

const LEGACY_CAPABILITY_SELECTION_FIELDS: Readonly<
  Partial<Record<string, "imageModel" | "transcriptionModel" | "visionModel">>
> = {
  [PROVIDER_CAPABILITY_IDS.audioTranscription]: "transcriptionModel",
  [PROVIDER_CAPABILITY_IDS.imageGeneration]: "imageModel",
  [PROVIDER_CAPABILITY_IDS.imageUnderstanding]: "visionModel",
};

function validateAdminCapabilityOverridePatch(
  registry: ProviderAdapterRegistry,
  instance: ProviderInstance,
  patch: UpdateProviderRequest["capabilityOverrides"]
): void {
  if (!patch) {
    return;
  }

  const manifest = registry.get(instance.type)?.manifest;
  for (const [rawCapabilityId, status] of Object.entries(patch)) {
    if (status === null) {
      continue;
    }

    const capabilityId = rawCapabilityId.trim();
    const definition = registry.getCapabilityDefinition(capabilityId);
    const isOverridable =
      Boolean(manifest?.capabilities[capabilityId]) &&
      definition?.routable === false;
    if (!isOverridable) {
      throw new AtlasApiError(
        `Capability "${capabilityId}" cannot be overridden for this provider.`,
        400
      );
    }
  }
}

function capabilityMappingRequestFromLegacySelection(
  selection: string | null
): UpdateCapabilityMappingRequest {
  const target = decodeStoredModelSelection(selection);
  if (
    selection &&
    (!(target?.providerId && target.modelId) ||
      target.providerId === "__unknown__")
  ) {
    throw new AtlasApiError(
      "Model selection must identify a configured provider instance and model.",
      400
    );
  }
  return {
    binding: {
      contractVersion: 1,
      enabled: target !== null,
      fallbacks: [],
      mode: "manual",
      ...(target ? { primary: target } : {}),
    },
  };
}

function capabilitySelectionForLegacyApi(
  config: UserConfig | null,
  capabilityId: string
): string | null {
  const migrated = migrateLegacyCapabilityConfig(
    {
      imageModel: config?.imageModel,
      transcriptionModel: config?.transcriptionModel,
      visionModel: config?.visionModel,
    },
    config?.capabilityConfig
  );
  const binding = migrated.bindings[capabilityId];
  if (!(binding?.enabled && binding.primary)) {
    return null;
  }
  return `${binding.primary.providerId}::${binding.primary.modelId}`;
}

function withLegacyCapabilitySelection(
  config: UserConfig | null,
  capabilityId: string,
  selection: string | null
): UserConfig {
  const base: UserConfig = config ?? {
    defaultProviderId: null,
    providers: [],
  };
  const request = capabilityMappingRequestFromLegacySelection(selection);
  const existing = migrateLegacyCapabilityConfig(base, base.capabilityConfig);
  return {
    ...base,
    ...legacyCapabilitySelectionPatch(
      capabilityId,
      request.binding.primary ?? null
    ),
    capabilityConfig: migrateCapabilityTargetProviderIds(
      validateCapabilityConfig({
        bindings: {
          ...existing.bindings,
          [capabilityId]: request.binding,
        },
        schemaVersion: 1,
      }),
      base.providers,
      base.defaultProviderId
    ),
  };
}

function legacyCapabilitySelectionPatch(
  capabilityId: string,
  target: { modelId: string; providerId: string } | null
): Partial<UserConfig> {
  const field = LEGACY_CAPABILITY_SELECTION_FIELDS[capabilityId];
  if (!field) {
    return {};
  }
  return {
    [field]: target ? `${target.providerId}::${target.modelId}` : null,
  };
}

function parseStoredUserConfig(value: unknown): UserConfig | null {
  if (!(value && typeof value === "object")) {
    return null;
  }

  const candidate = value as Partial<UserConfig>;
  const defaultProviderId = candidate.defaultProviderId;

  if (
    !(
      Array.isArray(candidate.providers) &&
      (defaultProviderId === null ||
        defaultProviderId === undefined ||
        typeof defaultProviderId === "string")
    )
  ) {
    return null;
  }

  const capabilityConfig = migrateCapabilityTargetProviderIds(
    migrateLegacyCapabilityConfig(candidate, candidate.capabilityConfig),
    candidate.providers,
    defaultProviderId ?? null
  );

  return {
    ...candidate,
    capabilityConfig,
    defaultProviderId: defaultProviderId ?? null,
    providers: candidate.providers,
  };
}

function providerValidationRequest(
  instance: ProviderInstance,
  model?: string
): TestProviderRequest {
  if (isSubscriptionProvider(instance.type)) {
    return { model, type: instance.type };
  }

  return {
    apiKey: instance.apiKey,
    baseUrl: instance.baseUrl,
    customModels: instance.customModels,
    hostMode: instance.hostMode,
    model,
    type: instance.type,
    wireApi: instance.wireApi,
  };
}

function addMissingImageDescriptionsToHistory(
  messages: readonly ChatMessage[],
  descriptions: readonly string[]
): readonly ChatMessage[] {
  let descriptionIndex = 0;
  let changed = false;
  const updated = messages.map((message) => {
    if (message.role !== "user" || typeof message.content === "string") {
      return message;
    }

    let contentChanged = false;
    const content = message.content.map((part) => {
      const needsDescription =
        (part.type === "image" || part.type === "image_ref") &&
        !part.description?.trim();
      if (!needsDescription) {
        return part;
      }

      const description = descriptions[descriptionIndex]?.trim();
      descriptionIndex += 1;
      if (!description) {
        throw new Error("Missing image description for historical image.");
      }
      changed = true;
      contentChanged = true;
      return { ...part, description };
    });

    return contentChanged ? { ...message, content } : message;
  });

  if (descriptionIndex !== descriptions.length) {
    throw new Error(
      "Historical image description count does not match image parts."
    );
  }

  return changed ? updated : messages;
}

function parseAgentChannel(value: string): AgentChannel | null {
  if (
    value === "cli" ||
    value === "web" ||
    value === "telegram" ||
    value === "whatsapp" ||
    value === "discord" ||
    value === "automation" ||
    value === "task" ||
    value === "subagent"
  ) {
    return value;
  }

  return null;
}

function clampSubAgentTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs == null || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_SUB_AGENT_TIMEOUT_MS;
  }

  return Math.min(Math.floor(timeoutMs), MAX_SUB_AGENT_TIMEOUT_MS);
}
