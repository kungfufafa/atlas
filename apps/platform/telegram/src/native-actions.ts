import { isDeepStrictEqual } from "node:util";
import type { AtlasClient } from "@atlas/client";
import { inferArtifactMimeType } from "@atlas/core/artifact-mime";
import {
  type ChannelActionReceipt,
  type ChannelNativeActionRequest,
  channelNativeActionSchema,
} from "@atlas/core/channel-native-actions";
import type { Context } from "grammy";
import type { ReactionTypeEmoji } from "grammy/types";
import type { TelegramControlBinding } from "./native-controls";
import { sendTelegramArtifact } from "./send-artifact-document";

const MESSAGE_ID = /^[1-9]\d{0,9}$/;

/** Message ownership is scoped to the canonical session, never only to a chat. */
export class TelegramNativeActions {
  private readonly attempted = new Set<string>();
  private readonly sent = new Map<string, Set<string>>();

  recordMessage(
    binding: Pick<TelegramControlBinding, "orgId" | "profileId" | "sessionId">,
    messageId: string
  ): void {
    if (!MESSAGE_ID.test(messageId)) {
      return;
    }
    const key = this.key(binding);
    const ids = this.sent.get(key) ?? new Set<string>();
    ids.add(messageId);
    if (ids.size > 500) {
      ids.delete(ids.values().next().value!);
    }
    this.sent.set(key, ids);
    if (this.sent.size > 1000) {
      this.sent.delete(this.sent.keys().next().value!);
    }
  }

  async dispatch(input: {
    request: ChannelNativeActionRequest;
    binding: TelegramControlBinding;
    client: AtlasClient;
    ctx: Context;
    onMediaReceipt?: (path: string, receipt: ChannelActionReceipt) => void;
    signal?: AbortSignal;
  }): Promise<void> {
    const { request, binding, client, ctx } = input;
    if (
      request.channel !== "telegram" ||
      request.orgId !== binding.orgId ||
      request.profileId !== binding.profileId ||
      request.sessionId !== binding.sessionId ||
      request.channelChatId !== String(binding.chatId) ||
      request.channelIsGroup !== binding.isGroup ||
      request.channelThreadId !==
        (binding.threadId === undefined
          ? undefined
          : String(binding.threadId)) ||
      !Number.isFinite(Date.parse(request.expiresAt)) ||
      Date.parse(request.expiresAt) <= Date.now() ||
      this.attempted.has(request.id) ||
      ctx.chat?.id !== binding.chatId ||
      String(ctx.from?.id) !== binding.channelUserId ||
      ctx.message?.message_thread_id !== binding.threadId
    ) {
      throw new Error("Channel action does not belong to this Telegram turn.");
    }
    const actor = {
      channel: "telegram" as const,
      channelAddressed: binding.addressed,
      channelChatId: String(binding.chatId),
      channelIsGroup: binding.isGroup,
      channelThreadId:
        binding.threadId === undefined ? undefined : String(binding.threadId),
      channelUserId: binding.channelUserId,
      requestId: request.id,
      sessionId: binding.sessionId,
    };
    // Do not evict replay protection during a process lifetime; stop accepting at the bound.
    if (this.attempted.size >= 10_000) {
      throw new Error(
        "Telegram action replay registry is full. Restart the worker before issuing more actions."
      );
    }
    this.attempted.add(request.id);
    const claimed = await client.claimChannelAction(actor);
    if (!isDeepStrictEqual(claimed, request)) {
      throw new Error("Claimed action differs from the emitted request.");
    }
    let receipt: ChannelActionReceipt;
    let attemptedTransport = false;
    const call = async <T>(operation: () => Promise<T>): Promise<T> => {
      input.signal?.throwIfAborted();
      if (Date.parse(claimed.expiresAt) <= Date.now()) {
        throw new Error("Telegram action expired before delivery.");
      }
      attemptedTransport = true;
      return operation();
    };
    try {
      const action = channelNativeActionSchema.parse(claimed.action);
      const chatId = binding.chatId;
      const topicOptions =
        binding.threadId === undefined || binding.threadId === 1
          ? {}
          : { message_thread_id: binding.threadId };
      const ownMessage = (id: string): number => {
        if (
          !(MESSAGE_ID.test(id) && this.sent.get(this.key(binding))?.has(id))
        ) {
          throw new Error(
            "The target message was not sent in this authorized session."
          );
        }
        return Number(id);
      };
      let result: unknown;
      let messageId: string | undefined;
      let threadId: string | undefined;
      switch (action.kind) {
        case "react": {
          const id = action.messageId ?? String(ctx.message?.message_id ?? "");
          if (
            !(
              MESSAGE_ID.test(id) &&
              (id === String(ctx.message?.message_id) ||
                this.sent.get(this.key(binding))?.has(id))
            )
          ) {
            throw new Error(
              "Reaction target is outside the current conversation."
            );
          }
          result = await call(() =>
            ctx.api.setMessageReaction(
              chatId,
              Number(id),
              action.emoji
                ? [{ emoji: action.emoji, type: "emoji" } as ReactionTypeEmoji]
                : []
            )
          );
          messageId = id;
          break;
        }
        case "poll": {
          if (action.durationHours !== undefined) {
            throw new Error(
              "Telegram polls use openPeriodSeconds, not durationHours."
            );
          }
          result = await call(() =>
            ctx.api.sendPoll(
              chatId,
              action.question,
              action.options.map((text) => ({ text })),
              {
                ...topicOptions,
                allows_multiple_answers: action.allowMultiple,
                is_anonymous: action.anonymous ?? true,
                open_period: action.openPeriodSeconds,
              }
            )
          );
          messageId = this.sentMessageId(result);
          break;
        }
        case "edit":
          result = await call(() =>
            ctx.api.editMessageText(
              chatId,
              ownMessage(action.messageId),
              action.text
            )
          );
          messageId = action.messageId;
          break;
        case "delete":
          result = await call(() =>
            ctx.api.deleteMessage(chatId, ownMessage(action.messageId))
          );
          messageId = action.messageId;
          break;
        case "pin":
          result = await call(() =>
            ctx.api.pinChatMessage(chatId, ownMessage(action.messageId), {
              disable_notification: true,
            })
          );
          messageId = action.messageId;
          break;
        case "unpin":
          result = await call(() =>
            ctx.api.unpinChatMessage(chatId, ownMessage(action.messageId))
          );
          messageId = action.messageId;
          break;
        case "topic_create": {
          if (
            ctx.chat?.type !== "supergroup" ||
            !("is_forum" in ctx.chat && ctx.chat.is_forum)
          ) {
            throw new Error(
              "Topic creation requires the current chat to be a forum supergroup."
            );
          }
          result = await call(() =>
            ctx.api.createForumTopic(chatId, action.name)
          );
          const created = result as { message_thread_id?: unknown };
          if (
            typeof created.message_thread_id !== "number" ||
            !Number.isInteger(created.message_thread_id) ||
            created.message_thread_id <= 0
          ) {
            throw new Error(
              "Telegram did not acknowledge the created forum topic."
            );
          }
          threadId = String(created.message_thread_id);
          break;
        }
        case "topic_edit": {
          if (binding.threadId === undefined || binding.threadId === 1) {
            throw new Error(
              "Topic edits require a non-General current forum topic."
            );
          }
          if (action.name !== undefined && action.closed !== undefined) {
            throw new Error(
              "Rename and close/reopen a topic in separate actions."
            );
          }
          if (action.name !== undefined) {
            result = await call(() =>
              ctx.api.editForumTopic(chatId, binding.threadId!, {
                name: action.name,
              })
            );
          } else if (action.closed === true) {
            result = await call(() =>
              ctx.api.closeForumTopic(chatId, binding.threadId!)
            );
          } else if (action.closed === false) {
            result = await call(() =>
              ctx.api.reopenForumTopic(chatId, binding.threadId!)
            );
          } else {
            throw new Error("Topic edit did not specify a change.");
          }
          break;
        }
        case "send_media": {
          if (
            !action.path.startsWith("artifacts/") ||
            action.path.split("/").includes("..")
          ) {
            throw new Error(
              "Media must be an artifact in the current profile."
            );
          }
          await client.authorizeChannelPrincipal({
            channel: "telegram",
            channelAddressed: binding.addressed,
            channelChatId: String(binding.chatId),
            channelIsGroup: binding.isGroup,
            channelThreadId:
              binding.threadId === undefined
                ? undefined
                : String(binding.threadId),
            channelUserId: binding.channelUserId,
            intent: "read",
            profileId: binding.profileId,
            sessionId: binding.sessionId,
          });
          const content = await client.readProfileArtifactContent(
            binding.profileId,
            action.path,
            { sessionId: binding.sessionId }
          );
          input.signal?.throwIfAborted();
          await client.authorizeChannelPrincipal({
            channel: "telegram",
            channelAddressed: binding.addressed,
            channelChatId: String(binding.chatId),
            channelIsGroup: binding.isGroup,
            channelThreadId:
              binding.threadId === undefined
                ? undefined
                : String(binding.threadId),
            channelUserId: binding.channelUserId,
            intent: "files",
            nativeAction: "send_media",
            profileId: binding.profileId,
            sessionId: binding.sessionId,
          });
          const mimeType =
            content.contentType?.split(";")[0]?.trim() ||
            inferArtifactMimeType(action.path);
          if (action.mode === "audio" && !mimeType.startsWith("audio/")) {
            throw new Error("Audio delivery requires an audio artifact.");
          }
          if (action.mode === "video" && mimeType !== "video/mp4") {
            throw new Error("Video delivery requires an MP4 artifact.");
          }
          const sent = await call(() =>
            sendTelegramArtifact(ctx, {
              bytes: new Uint8Array(content.data),
              filename: action.path.split("/").at(-1)!,
              mimeType,
              presentation:
                action.mode === "voice" || action.mode === "document"
                  ? action.mode
                  : "auto",
            })
          );
          if (!sent.ok) {
            throw new Error(sent.error ?? "Media delivery failed.");
          }
          result = true;
          messageId = sent.messageId;
          break;
        }
        case "thread_create":
          throw new Error("Use topic_create for Telegram forum topics.");
      }
      if (result === undefined || result === false || result === null) {
        throw new Error("Telegram did not acknowledge the action.");
      }
      if (
        messageId &&
        (action.kind === "poll" || action.kind === "send_media")
      ) {
        this.recordMessage(binding, messageId);
      }
      receipt = {
        status: "accepted",
        ...(messageId ? { messageId } : {}),
        ...(threadId ? { threadId } : {}),
      };
    } catch (error) {
      receipt = {
        error:
          error instanceof Error
            ? error.message.slice(0, 1000)
            : "Telegram action failed.",
        status: attemptedTransport ? "unknown" : "failed",
      };
    }
    if (claimed.action.kind === "send_media") {
      input.onMediaReceipt?.(claimed.action.path, receipt);
    }
    // A missing completion acknowledgement must not replay the platform action.
    await client.completeChannelAction({ ...actor, receipt });
  }

  private key(
    binding: Pick<TelegramControlBinding, "orgId" | "profileId" | "sessionId">
  ): string {
    return JSON.stringify([
      binding.orgId,
      binding.profileId,
      binding.sessionId,
    ]);
  }
  private sentMessageId(result: unknown): string {
    const id =
      result && typeof result === "object" && "message_id" in result
        ? result.message_id
        : undefined;
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
      throw new Error(
        "Telegram did not return a message ID; delivery is unconfirmed."
      );
    }
    return String(id);
  }
}
