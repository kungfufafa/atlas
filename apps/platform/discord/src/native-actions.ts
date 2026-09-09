import { basename } from "node:path";
import type { AtlasClient } from "@atlas/client";
import type {
  ChannelActionReceipt,
  ChannelNativeAction,
  ChannelNativeActionRequest,
} from "@atlas/core/channel-native-actions";
import {
  AttachmentBuilder,
  type Channel,
  ChannelType,
  type Client,
  type GuildBasedChannel,
  type Message,
  MessageFlags,
  PermissionFlagsBits,
  type SendableChannels,
} from "discord.js";
import {
  prepareDiscordVoiceMessage,
  sendDiscordVoiceMessage,
} from "./native-audio";
import type { DiscordCallbackBinding } from "./native-callbacks";
import { DISCORD_ARTIFACT_ATTACHMENT_MAX_BYTES } from "./send-artifact-attachment";
import type { ThreadStore } from "./thread-store";

export class DiscordMessageOwners {
  private readonly messages = new Map<string, string>();
  record(messageId: string, binding: DiscordCallbackBinding): void {
    if (this.messages.size >= 10_000) {
      const oldest = this.messages.keys().next().value;
      if (oldest) {
        this.messages.delete(oldest);
      }
    }
    this.messages.set(messageId, this.key(binding));
  }
  owns(messageId: string, binding: DiscordCallbackBinding): boolean {
    return this.messages.get(messageId) === this.key(binding);
  }
  private key(binding: DiscordCallbackBinding): string {
    return JSON.stringify([
      binding.orgId,
      binding.sessionId,
      binding.channelId,
      binding.channelUserId,
    ]);
  }
}

export async function requireDiscordPermissions(
  channel: Channel,
  senderId: string,
  permissions: readonly bigint[]
): Promise<void> {
  if (channel.isDMBased()) {
    if (channel.type !== ChannelType.DM || channel.recipientId !== senderId) {
      throw new Error(
        "Discord action does not belong to this private conversation"
      );
    }
    return;
  }
  if (!("guild" in channel)) {
    throw new Error("Discord guild context is unavailable");
  }
  const guildChannel = channel as GuildBasedChannel;
  await guildChannel.guild.roles.fetch();
  const [sender, bot] = await Promise.all([
    guildChannel.guild.members.fetch({ force: true, user: senderId }),
    guildChannel.guild.members.fetchMe({ force: true }),
  ]);
  for (const member of [sender, bot]) {
    const resolved = guildChannel.permissionsFor(member);
    if (!resolved?.has([PermissionFlagsBits.ViewChannel, ...permissions])) {
      throw new Error(
        "Discord sender or bot lacks the required channel permission"
      );
    }
  }
}

function sendPermission(channel: Channel): bigint {
  return channel.isThread()
    ? PermissionFlagsBits.SendMessagesInThreads
    : PermissionFlagsBits.SendMessages;
}

function requiredPermissions(
  action: ChannelNativeAction,
  channel: Channel
): bigint[] {
  switch (action.kind) {
    case "react":
      return [
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AddReactions,
      ];
    case "pin":
    case "unpin":
      return [
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.PinMessages,
      ];
    case "delete":
      return [
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
      ];
    case "edit":
      return [PermissionFlagsBits.ReadMessageHistory, sendPermission(channel)];
    case "poll":
      return [sendPermission(channel), PermissionFlagsBits.SendPolls];
    case "topic_create":
      return [PermissionFlagsBits.SendMessages];
    case "topic_edit":
      return [PermissionFlagsBits.ManageThreads];
    case "thread_create":
      if (channel.type === ChannelType.GuildForum) {
        return [PermissionFlagsBits.SendMessages];
      }
      return [
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.CreatePublicThreads,
        ...(action.text ? [PermissionFlagsBits.SendMessagesInThreads] : []),
      ];
    case "send_media":
      return [
        sendPermission(channel),
        PermissionFlagsBits.AttachFiles,
        ...(action.mode === "voice"
          ? [PermissionFlagsBits.SendVoiceMessages]
          : []),
      ];
    default:
      throw new Error("Discord action is unsupported");
  }
}

interface ActionContext {
  binding: DiscordCallbackBinding;
  client: AtlasClient;
  discord: Client<true>;
  expiresAt?: string;
  inboundMessageId?: string;
  owners: DiscordMessageOwners;
  reauthorize(action: ChannelNativeAction): Promise<void>;
  signal?: AbortSignal;
  threadStore: ThreadStore;
}

async function actionChannel(
  context: ActionContext,
  action: ChannelNativeAction
): Promise<Channel> {
  const { binding } = context;
  const createAtParent =
    action.kind === "topic_create" || action.kind === "thread_create";
  const channelId = createAtParent ? binding.channelChatId : binding.channelId;
  const channel = await context.discord.channels.fetch(channelId, {
    force: true,
  });
  if (!channel || channel.id !== channelId) {
    throw new Error("Discord action channel is unavailable");
  }
  const guildId = "guildId" in channel ? channel.guildId : null;
  if (guildId !== binding.guildId) {
    throw new Error("Discord action crossed its guild boundary");
  }
  if (
    binding.channelThreadId &&
    !context.threadStore.hasThreadId(binding.channelThreadId)
  ) {
    throw new Error("Discord action thread is not owned by this bot");
  }
  if (channel.isThread() && channel.parentId !== binding.channelChatId) {
    throw new Error("Discord action crossed its parent channel boundary");
  }
  await requireDiscordPermissions(
    channel,
    binding.channelUserId,
    requiredPermissions(action, channel)
  );
  return channel;
}

async function authorizeFinalEffect(
  context: ActionContext,
  action: ChannelNativeAction
): Promise<void> {
  assertEffectActive(context);
  // Message lookup, artifact reads and audio conversion may outlive a role or
  // overwrite change. Refresh Discord permissions again at the effect boundary.
  await actionChannel(context, action);
  await context.reauthorize(action);
  assertEffectActive(context);
}

function assertEffectActive(context: ActionContext): void {
  context.signal?.throwIfAborted();
  if (!context.expiresAt || Date.parse(context.expiresAt) <= Date.now()) {
    throw new Error("Discord action claim expired before its effect");
  }
}

async function getActionMessage(
  channel: Channel,
  messageId: string
): Promise<Message> {
  if (!channel.isTextBased()) {
    throw new Error("Discord action requires a message channel");
  }
  const message = await channel.messages.fetch({
    force: true,
    message: messageId,
  });
  if (message.channelId !== channel.id) {
    throw new Error("Discord message belongs to another channel");
  }
  return message;
}

function requireSendable(channel: Channel): SendableChannels {
  if (!channel.isSendable()) {
    throw new Error("Discord channel does not support messages");
  }
  return channel;
}

async function executeMessageAction(
  context: ActionContext,
  channel: Channel,
  action: Extract<
    ChannelNativeAction,
    { kind: "react" | "edit" | "delete" | "pin" | "unpin" }
  >,
  effect: () => void
): Promise<string> {
  const messageId = action.messageId ?? context.inboundMessageId;
  if (!messageId) {
    throw new Error(
      "Discord action needs a message in the current conversation"
    );
  }
  const message = await getActionMessage(channel, messageId);
  if (
    action.kind !== "react" &&
    (message.author.id !== context.discord.user.id ||
      !context.owners.owns(message.id, context.binding))
  ) {
    throw new Error(
      "Discord message mutations require this session's own bot message"
    );
  }
  if (
    action.kind === "edit" &&
    (message.flags?.has(MessageFlags.IsVoiceMessage) ||
      action.text.length > 2000)
  ) {
    throw new Error(
      "Discord edits require this session's own bot message and at most 2000 characters"
    );
  }
  await authorizeFinalEffect(context, action);
  effect();
  switch (action.kind) {
    case "react":
      await message.react(action.emoji);
      break;
    case "edit":
      await message.edit({
        allowedMentions: { parse: [] },
        content: action.text,
      });
      break;
    case "delete":
      await message.delete();
      break;
    case "pin":
      await message.pin();
      break;
    case "unpin":
      await message.unpin();
      break;
    default:
      throw new Error("Discord message action is unsupported");
  }
  return message.id;
}

async function executeThreadAction(
  context: ActionContext,
  channel: Channel,
  action: Extract<
    ChannelNativeAction,
    { kind: "topic_create" | "topic_edit" | "thread_create" }
  >,
  effect: () => void
): Promise<string> {
  if (action.kind === "topic_edit") {
    if (!(channel.isThread() && context.threadStore.hasThreadId(channel.id))) {
      throw new Error("Discord can update only its owned conversation thread");
    }
    await authorizeFinalEffect(context, action);
    effect();
    await channel.edit({ archived: action.closed, name: action.name });
    return channel.id;
  }
  if (
    action.kind === "topic_create" &&
    channel.type !== ChannelType.GuildForum
  ) {
    throw new Error("Discord topics require a forum parent channel");
  }
  if (
    channel.type !== ChannelType.GuildForum &&
    channel.type !== ChannelType.GuildText
  ) {
    throw new Error(
      "Discord thread creation requires a forum or text parent channel"
    );
  }
  const content = action.kind === "thread_create" ? action.text : undefined;
  if (content && content.length > 2000) {
    throw new Error("Discord thread message exceeds 2000 characters");
  }
  await authorizeFinalEffect(context, action);
  effect();
  const thread =
    channel.type === ChannelType.GuildForum
      ? await channel.threads.create({
          message: {
            allowedMentions: { parse: [] },
            content: content ?? action.name,
          },
          name: action.name,
        })
      : await channel.threads.create({
          name: action.name,
          type: ChannelType.PublicThread,
        });
  context.threadStore.add(thread.id);
  await context.threadStore.save();
  if (content && channel.type === ChannelType.GuildText) {
    await authorizeFinalEffect(context, action);
    await thread.send({ allowedMentions: { parse: [] }, content });
  }
  return thread.id;
}

async function executeMediaAction(
  context: ActionContext,
  channel: Channel,
  action: Extract<ChannelNativeAction, { kind: "send_media" }>,
  effect: () => void
): Promise<string> {
  const { data, contentType: mediaType } =
    await context.client.readProfileArtifactContent(
      context.binding.profileId,
      action.path,
      { sessionId: context.binding.sessionId }
    );
  const bytes = new Uint8Array(data);
  if (
    bytes.length === 0 ||
    bytes.length > DISCORD_ARTIFACT_ATTACHMENT_MAX_BYTES
  ) {
    throw new Error("Discord media file exceeds attachment limits");
  }
  if (
    (action.mode === "audio" || action.mode === "voice") &&
    !mediaType?.startsWith("audio/")
  ) {
    throw new Error("Discord audio mode requires an audio artifact");
  }
  if (action.mode === "video" && !mediaType?.startsWith("video/")) {
    throw new Error("Discord video mode requires a video artifact");
  }
  const voice =
    action.mode === "voice"
      ? await prepareDiscordVoiceMessage(bytes, context.signal)
      : null;
  await authorizeFinalEffect(context, action);
  effect();
  const message = voice
    ? await sendDiscordVoiceMessage({
        channelId: channel.id,
        rest: context.discord.rest,
        voice,
      })
    : await requireSendable(channel).send({
        allowedMentions: { parse: [] },
        files: [
          new AttachmentBuilder(Buffer.from(bytes)).setName(
            basename(action.path)
          ),
        ],
      });
  context.owners.record(message.id, context.binding);
  return message.id;
}

async function executeAction(
  context: ActionContext,
  action: ChannelNativeAction,
  effect: () => void
): Promise<string> {
  const channel = await actionChannel(context, action);
  switch (action.kind) {
    case "react":
    case "edit":
    case "delete":
    case "pin":
    case "unpin":
      return await executeMessageAction(context, channel, action, effect);
    case "topic_create":
    case "topic_edit":
    case "thread_create":
      return await executeThreadAction(context, channel, action, effect);
    case "send_media":
      return await executeMediaAction(context, channel, action, effect);
    case "poll": {
      if (action.anonymous === true || action.openPeriodSeconds !== undefined) {
        throw new Error(
          "Discord polls do not support anonymous voting or second-based closing periods"
        );
      }
      await authorizeFinalEffect(context, action);
      effect();
      const message = await requireSendable(channel).send({
        allowedMentions: { parse: [] },
        poll: {
          allowMultiselect: action.allowMultiple ?? false,
          answers: action.options.map((text) => ({ text })),
          duration: action.durationHours ?? 24,
          question: { text: action.question },
        },
      });
      context.owners.record(message.id, context.binding);
      return message.id;
    }
    default:
      throw new Error("Discord action is unsupported");
  }
}

export async function dispatchDiscordNativeAction(
  context: ActionContext,
  event: ChannelNativeActionRequest
): Promise<ChannelActionReceipt> {
  const identity = {
    channel: "discord" as const,
    channelAddressed: context.binding.channelAddressed,
    channelChatId: context.binding.channelChatId,
    channelIsGroup: context.binding.guildId !== null,
    channelThreadId: context.binding.channelThreadId,
    channelUserId: context.binding.channelUserId,
    requestId: event.id,
    sessionId: context.binding.sessionId,
  };
  const claimed = await context.client.claimChannelAction(identity);
  let attempted = false;
  let receipt: ChannelActionReceipt;
  try {
    if (
      claimed.id !== event.id ||
      claimed.channel !== "discord" ||
      claimed.orgId !== context.binding.orgId ||
      claimed.profileId !== context.binding.profileId ||
      claimed.sessionId !== context.binding.sessionId ||
      claimed.channelChatId !== identity.channelChatId ||
      claimed.channelThreadId !== identity.channelThreadId ||
      !Number.isFinite(Date.parse(claimed.expiresAt)) ||
      Date.parse(claimed.expiresAt) <= Date.now()
    ) {
      throw new Error(
        "Discord action claim does not match the current conversation"
      );
    }
    const messageId = await executeAction(
      { ...context, expiresAt: claimed.expiresAt },
      claimed.action,
      () => {
        attempted = true;
      }
    );
    receipt = { messageId, status: "accepted" };
  } catch {
    receipt = {
      error:
        "Discord action was not confirmed. Check current access, capability, and transport status.",
      status: attempted ? "unknown" : "failed",
    };
  }
  await context.client.completeChannelAction({ ...identity, receipt });
  return receipt;
}
