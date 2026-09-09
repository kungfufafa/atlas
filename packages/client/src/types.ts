import type { Artifact } from "@atlas/core/artifact-types";
import type {
  ActivityEvent,
  AgentQuestionnaire,
  AgentTodo,
  ApprovalRequest,
  AutomationDefinition,
  ChatContextUsage,
  ChatMessage,
  Citation,
  CompactionResponse,
  ExecutionPolicy,
  SendMessageInput,
  SourceItem,
} from "@atlas/core/contract";

/** Fetch `credentials` option (same values as the standard `RequestCredentials` type). */
export type FetchCredentials = "omit" | "same-origin" | "include";

/** Binary buffer input (same values as the standard `BufferSource` type). */
export type BinaryBufferSource = ArrayBuffer | ArrayBufferView;

export interface AtlasClientOptions {
  authToken?: string;
  baseUrl?: string;
  /** Browser-style origin for OAuth callbacks when this client has no window (e.g. Telegram bridge). */
  clientOrigin?: string;
  credentials?: FetchCredentials;
  fetch?: typeof fetch;
  orgId?: string | null;
  /** Redirect handling for every request made by this client. */
  redirect?: RequestRedirect;
  /**
   * Native/mobile clients: request a session token in login/setup JSON,
   * send it as Bearer, skip cookie CSRF, and skip disk local-auth retries.
   */
  tokenAuth?: boolean;
}

export type StreamHandler = (delta: string) => void;

export interface StreamHandlers {
  onActivityComplete?: (activity: ActivityEvent) => void;
  onActivityStart?: (activity: ActivityEvent) => void;
  onActivityUpdate?: (activity: ActivityEvent) => void;
  onApprovalRequested?: (approval: ApprovalRequest) => void;
  onApprovalResolved?: (event: {
    approvalId: string;
    status: "approved" | "rejected";
  }) => void;
  onArtifactCreated?: (artifact: Artifact) => void;
  onChannelActionRequested?: (
    request: import("@atlas/core/channel-native-actions").ChannelNativeActionRequest
  ) => void;
  onChunk: StreamHandler;
  onCitationCreated?: (event: {
    citation: Citation;
    source?: SourceItem;
  }) => void;
  onContextUsage?: (usage: ChatContextUsage) => void;
  onMemorySaved?: (summary: string) => void;
  onPolicyResolved?: (policy: ExecutionPolicy) => void;
  onQuestionnaireUpdated?: (questionnaire: AgentQuestionnaire | null) => void;
  onRelatedQuestions?: (questions: string[]) => void;
  onSourcesUpdated?: (event: {
    sources: SourceItem[];
    citedCount: number;
    reviewedCount: number;
  }) => void;
  onSubAgentActivity?: (event: {
    parentToolCallId: string;
    label: string;
  }) => void;
  onThinking?: StreamHandler;
  onTodosUpdated?: (todos: AgentTodo[]) => void;
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

export type SendMessageArg = string | SendMessageInput;

export interface SendStreamOptions {
  signal?: AbortSignal;
}

export interface RemoteChatSession {
  clear(): Promise<void>;
  compact(options?: { force?: boolean }): Promise<CompactionResponse>;
  createAutomation(prompt: string): Promise<AutomationDefinition>;
  getMessages(): Promise<ChatMessage[]>;
  id: string;
  purge(): Promise<void>;
  send(input: SendMessageArg): Promise<string>;
  sendStream(
    input: SendMessageArg,
    handler: StreamHandler | StreamHandlers,
    options?: SendStreamOptions
  ): Promise<string>;
  subscribeStream(
    handler: StreamHandler | StreamHandlers,
    options?: SendStreamOptions
  ): Promise<{ reconnected: boolean; reply?: string }>;
}
