import { AtlasApiError, type ToolContext } from "@atlas/core";
import {
  assertChannelIntegrationPolicy,
  loadChannelIntegrationPolicy,
} from "@atlas/core/channel-integration-policy";
import {
  type ChannelActionActor,
  type ChannelActionReceipt,
  type ChannelNativeAction,
  type ChannelNativeActionRequest,
  type ClaimChannelActionInput,
  type CompleteChannelActionInput,
  channelActionReceiptSchema,
  channelNativeActionSchema,
  type NativeChannel,
} from "@atlas/core/channel-native-actions";
import type { DatabaseAdapter } from "@atlas/db";
import { authorizeChannelAction } from "./channel-action-authorization";
import { canGuestSearchKnowledgeBase } from "./channel-guest-knowledge-base-policy";
import { normalizeExternalActor } from "./channel-guest-principal-service";
import type { IdentityService } from "./identity-service";

interface BoundContext extends ChannelActionActor {
  channel: NativeChannel;
  orgId: string;
  profileId: string;
  updatedAt: number;
  userId: string;
}
interface PendingAction {
  beforeEffect: () => Promise<void>;
  binding: BoundContext;
  claimed: boolean;
  claimedActorId?: string;
  request: ChannelNativeActionRequest;
  resolve: (receipt: ChannelActionReceipt) => void;
}
const MAX_PENDING = 1000;
const MAX_CONTEXTS = 5000;
const MAX_CONTEXTS_PER_ORG = 500;
const MAX_PENDING_PER_ORG = 64;
const CONTEXT_TTL_MS = 24 * 60 * 60_000;

/** One live invocation -> one worker claim -> one acknowledged or uncertain result. */
export class ChannelNativeActionService {
  private readonly bindings = new Map<string, BoundContext>();
  private readonly pending = new Map<string, PendingAction>();
  private readonly uncertain = new Map<string, number>();

  constructor(
    private readonly db: DatabaseAdapter,
    private readonly identities: IdentityService,
    private readonly timeoutMs = 120_000
  ) {}

  /** KB reads need a current worker-bound sender, including automatic grounding. */
  async canGuestSearchKnowledgeBase(
    orgId: string,
    sessionId: string,
    profileId: string,
    userId: string
  ): Promise<boolean> {
    const binding = this.bindings.get(this.key(orgId, sessionId));
    if (
      !binding ||
      binding.channel !== "whatsapp" ||
      binding.profileId !== profileId ||
      binding.userId !== userId ||
      Date.now() - binding.updatedAt > CONTEXT_TTL_MS
    ) {
      return false;
    }
    if (
      !(await canGuestSearchKnowledgeBase(this.db, {
        actor: binding,
        channel: "whatsapp",
        orgId,
        profileId,
        userId,
      }))
    ) {
      return false;
    }
    try {
      await this.authorizeTool(
        orgId,
        sessionId,
        "whatsapp",
        "knowledge_base_search"
      );
      return true;
    } catch (error) {
      if (
        error instanceof AtlasApiError &&
        (error.status === 403 || error.status === 404)
      ) {
        return false;
      }
      throw error;
    }
  }

  async authorizeTool(
    orgId: string,
    sessionId: string,
    channel: NativeChannel,
    tool?: string
  ): Promise<void> {
    const policy = await loadChannelIntegrationPolicy(orgId, channel);
    const binding = this.bindings.get(this.key(orgId, sessionId));
    if (!binding) {
      if (Object.keys(policy).length > 1) {
        throw new AtlasApiError(
          "Channel tool context must be bound before execution",
          403
        );
      }
      return;
    }
    const principal = await authorizeChannelAction(this.db, this.identities, {
      ...binding,
      intent: "invoke",
    });
    const normalized = await normalizeExternalActor(binding);
    assertChannelIntegrationPolicy(
      policy,
      channel,
      {
        ...binding,
        channelUserAliases: normalized.channelUserIds.filter(
          (id) => id !== normalized.primaryChannelUserId
        ),
        channelUserId: normalized.primaryChannelUserId,
      },
      principal,
      { tool }
    );
  }

  assertBoundActor(
    orgId: string,
    channel: NativeChannel,
    actor: ChannelActionActor,
    userId: string
  ): void {
    const binding = this.bindings.get(this.key(orgId, actor.sessionId));
    if (
      !(
        binding &&
        this.sameRoom(binding, {
          ...actor,
          channel,
          orgId,
          profileId: binding.profileId,
          updatedAt: binding.updatedAt,
          userId,
        })
      ) ||
      (actor.channelUserId !== binding.channelUserId &&
        !binding.channelUserAliases?.includes(actor.channelUserId))
    ) {
      throw new AtlasApiError(
        "Native control does not match its bound conversation",
        403
      );
    }
  }

  async bind(
    orgId: string,
    channel: NativeChannel,
    actor: ChannelActionActor
  ): Promise<{ bound: true }> {
    const principal = await authorizeChannelAction(this.db, this.identities, {
      ...actor,
      channel,
      intent: "invoke",
      orgId,
    });
    const session = await this.db.getSession(actor.sessionId);
    if (!(session && actor.channelChatId.trim())) {
      throw new AtlasApiError("Channel context is missing", 400);
    }
    const key = this.key(orgId, actor.sessionId);
    const activeSessions = new Set(
      [...this.pending.values()].map((item) =>
        this.key(item.binding.orgId, item.binding.sessionId)
      )
    );
    for (const [contextKey, value] of this.bindings) {
      if (
        Date.now() - value.updatedAt > CONTEXT_TTL_MS &&
        !activeSessions.has(contextKey)
      ) {
        this.bindings.delete(contextKey);
      }
    }
    const previous = this.bindings.get(key);
    const binding: BoundContext = {
      ...actor,
      channel,
      orgId,
      profileId: session.profileId,
      updatedAt: Date.now(),
      userId: principal.userId,
    };
    if (previous && !this.sameRoom(previous, binding)) {
      throw new AtlasApiError(
        "Session belongs to a different channel conversation",
        409
      );
    }
    if (!previous && this.bindings.size >= MAX_CONTEXTS) {
      throw new AtlasApiError("Channel context capacity reached", 503);
    }
    if (
      !previous &&
      [...this.bindings.values()].filter((value) => value.orgId === orgId)
        .length >= MAX_CONTEXTS_PER_ORG
    ) {
      throw new AtlasApiError(
        "Workspace channel context capacity reached",
        429
      );
    }
    this.bindings.set(key, binding);
    return { bound: true };
  }

  async request(
    context: ToolContext,
    rawAction: ChannelNativeAction,
    publish?: (request: ChannelNativeActionRequest) => void
  ): Promise<ChannelActionReceipt> {
    if (!publish) {
      throw new AtlasApiError(
        "Native actions require a connected channel stream",
        409
      );
    }
    const action = channelNativeActionSchema.parse(rawAction);
    const binding = this.bindings.get(
      this.key(context.orgId ?? "", context.sessionId ?? "")
    );
    if (
      !binding ||
      binding.userId !== context.userId ||
      binding.profileId !== context.profileId ||
      binding.channel !== context.channel
    ) {
      throw new AtlasApiError("Native channel context is not bound", 403);
    }
    const actionKey = `${this.key(binding.orgId, binding.sessionId)}:${JSON.stringify(action)}`;
    for (const [key, until] of this.uncertain) {
      if (until <= Date.now()) {
        this.uncertain.delete(key);
      }
    }
    if (this.uncertain.has(actionKey)) {
      throw new AtlasApiError(
        "An identical action has an uncertain delivery; verify it before requesting it again",
        409
      );
    }
    const beforeEffect = async () => {
      context.signal?.throwIfAborted();
      await context.beforeToolCall?.();
      await this.authorizeTool(
        binding.orgId,
        binding.sessionId,
        binding.channel,
        "channel_action"
      );
      const principal = await authorizeChannelAction(this.db, this.identities, {
        ...binding,
        intent: "files",
        nativeAction: action.kind,
      });
      if (principal.userId !== binding.userId) {
        throw new AtlasApiError("Channel identity changed", 403);
      }
      const assigned = await this.db.listToolsForProfile(binding.profileId);
      if (
        !assigned.some(
          (tool) =>
            tool.name === "channel_action" &&
            tool.handlerType === "builtin" &&
            (!tool.orgId || tool.orgId === binding.orgId)
        )
      ) {
        throw new AtlasApiError(
          "Native channel tool is no longer assigned",
          403
        );
      }
      context.signal?.throwIfAborted();
    };
    await beforeEffect();
    if (this.pending.size >= MAX_PENDING) {
      throw new AtlasApiError("Channel action capacity reached", 503);
    }
    if (
      [...this.pending.values()].filter(
        (value) => value.binding.orgId === binding.orgId
      ).length >= MAX_PENDING_PER_ORG
    ) {
      throw new AtlasApiError(
        "Workspace pending channel action capacity reached",
        429
      );
    }
    const request: ChannelNativeActionRequest = {
      action: structuredClone(action),
      channel: binding.channel,
      channelAddressed: binding.channelAddressed,
      channelChatId: binding.channelChatId,
      channelIsGroup: binding.channelIsGroup,
      channelThreadId: binding.channelThreadId,
      expiresAt: new Date(Date.now() + this.timeoutMs).toISOString(),
      id: crypto.randomUUID(),
      orgId: binding.orgId,
      profileId: binding.profileId,
      sessionId: binding.sessionId,
    };
    const completion = Promise.withResolvers<ChannelActionReceipt>();
    const pending: PendingAction = {
      beforeEffect,
      binding: structuredClone(binding),
      claimed: false,
      request,
      resolve: completion.resolve,
    };
    this.pending.set(request.id, pending);
    const expire = () =>
      completion.resolve({
        error: pending.claimed
          ? "Worker receipt unavailable after claim; do not retry automatically."
          : "Channel action expired or was cancelled before execution.",
        status: pending.claimed ? "unknown" : "failed",
      });
    const timer = setTimeout(expire, this.timeoutMs);
    context.signal?.addEventListener("abort", expire, { once: true });
    try {
      context.signal?.throwIfAborted();
      publish(structuredClone(request));
      const receipt = await completion.promise;
      if (receipt.status === "unknown") {
        this.uncertain.set(actionKey, Date.now() + 10 * 60_000);
      }
      return receipt;
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", expire);
      this.pending.delete(request.id);
    }
  }

  async claim(
    orgId: string,
    channel: NativeChannel,
    input: ClaimChannelActionInput
  ): Promise<ChannelNativeActionRequest> {
    const pending = this.requirePending(orgId, channel, input);
    if (pending.claimed) {
      throw new AtlasApiError(
        "Channel action already claimed; do not repeat it",
        409
      );
    }
    // Reserve synchronously before async authority checks so concurrent deliveries cannot both claim.
    pending.claimed = true;
    try {
      await this.authorizeReceiptActor(pending, input);
      await pending.beforeEffect();
      if (
        this.pending.get(input.requestId) !== pending ||
        Date.parse(pending.request.expiresAt) <= Date.now()
      ) {
        throw new AtlasApiError("Channel action expired", 409);
      }
      pending.claimedActorId = input.channelUserId;
      return structuredClone(pending.request);
    } catch (error) {
      pending.resolve({
        error: "Channel action authorization failed before execution.",
        status: "failed",
      });
      throw error;
    }
  }

  async complete(
    orgId: string,
    channel: NativeChannel,
    input: CompleteChannelActionInput
  ): Promise<{ recorded: true }> {
    const pending = this.requirePending(orgId, channel, input);
    if (!pending.claimedActorId) {
      throw new AtlasApiError(
        "Channel action was not authorized for execution",
        409
      );
    }
    const receipt = channelActionReceiptSchema.parse(input.receipt);
    // A receipt reports a completed effect, and must survive later role/policy revocation.
    // Authenticate its original scoped worker, bound actor and room without granting another action.
    if (input.channelUserId !== pending.claimedActorId) {
      throw new AtlasApiError("Receipt sender does not match the claim", 403);
    }
    pending.resolve(receipt);
    this.pending.delete(input.requestId);
    return { recorded: true };
  }

  private async authorizeReceiptActor(
    pending: PendingAction,
    input: ChannelActionActor
  ): Promise<void> {
    const principal = await authorizeChannelAction(this.db, this.identities, {
      ...input,
      channel: pending.binding.channel,
      intent: "files",
      nativeAction: pending.request.action.kind,
      orgId: pending.binding.orgId,
      profileId: pending.binding.profileId,
    });
    if (principal.userId !== pending.binding.userId) {
      throw new AtlasApiError("Channel action belongs to another user", 403);
    }
  }

  private requirePending(
    orgId: string,
    channel: NativeChannel,
    input: ClaimChannelActionInput
  ): PendingAction {
    const pending = this.pending.get(input.requestId);
    if (
      !pending ||
      pending.binding.orgId !== orgId ||
      pending.binding.channel !== channel ||
      pending.binding.sessionId !== input.sessionId ||
      !this.sameRoom(pending.binding, {
        ...input,
        channel,
        orgId,
        profileId: pending.binding.profileId,
        updatedAt: pending.binding.updatedAt,
        userId: pending.binding.userId,
      })
    ) {
      throw new AtlasApiError("Channel action not found", 404);
    }
    if (
      input.channelUserId !== pending.binding.channelUserId &&
      !pending.binding.channelUserAliases?.includes(input.channelUserId)
    ) {
      throw new AtlasApiError("Channel action belongs to another sender", 403);
    }
    return pending;
  }

  private key(orgId: string, sessionId: string): string {
    return `${orgId}:${sessionId}`;
  }
  private sameRoom(left: BoundContext, right: BoundContext): boolean {
    return (
      left.orgId === right.orgId &&
      left.channel === right.channel &&
      left.sessionId === right.sessionId &&
      left.userId === right.userId &&
      left.channelChatId === right.channelChatId &&
      left.channelThreadId === right.channelThreadId &&
      left.channelIsGroup === right.channelIsGroup
    );
  }
}
