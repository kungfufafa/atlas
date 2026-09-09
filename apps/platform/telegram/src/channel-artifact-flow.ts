import type { AtlasClient, RemoteChatSession } from "@atlas/client";
import {
  type ChannelArtifactRef,
  extractTurnDeliverableArtifacts,
  formatArtifactShareFooter,
  formatMissingAttachArtifactMessage,
  getMostRecentDeliverableArtifact,
  isAttachIntent,
  isAttachOnlyCommand,
  mintDeliverableArtifacts,
  pushDeliverableArtifact,
} from "@atlas/core";
import type { Context } from "grammy";
import {
  explainGroupMessageHandling,
  isTelegramGroupChat,
} from "./group-message";
import type { TelegramRichMessenger } from "./rich-message";
import {
  formatTelegramArtifactTooLargeMessage,
  sendTelegramArtifact,
  TELEGRAM_ARTIFACT_MAX_BYTES,
} from "./send-artifact-document";
import type { SessionStore } from "./session-store";

export async function maybeSendRequestedTelegramArtifactAttachment(input: {
  ctx: Context;
  client: AtlasClient;
  conversationKey: string;
  profileId: string;
  /** Raw user text before group-context prefixing. */
  attachUserText: string;
  sessionStore: SessionStore;
  messenger: TelegramRichMessenger;
}): Promise<void> {
  if (!isAttachIntent(input.attachUserText)) {
    return;
  }

  const artifact = getMostRecentDeliverableArtifact(
    input.sessionStore.getDeliverableArtifacts(input.conversationKey)
  );
  if (!artifact) {
    if (isAttachOnlyCommand(input.attachUserText)) {
      await input.messenger.sendPlain(formatMissingAttachArtifactMessage());
    }
    return;
  }

  const delivery = {
    ...input,
    session: {
      id: input.sessionStore.get(input.conversationKey)?.sessionId ?? "",
    },
  };
  try {
    await authorizeArtifactDelivery(delivery);
    const sessionId = delivery.session.id;
    const { data } = await input.client.readProfileArtifactContent(
      input.profileId,
      artifact.path,
      { sessionId }
    );
    await authorizeArtifactDelivery(delivery);
    const result = await sendTelegramArtifact(input.ctx, {
      bytes: new Uint8Array(data),
      filename: artifact.filename,
      mimeType: artifact.mimeType,
    });

    if (!result.ok && result.error) {
      await authorizeArtifactDelivery(delivery);
      await input.messenger.sendPlain(
        `${result.error} Saved file: ${artifact.path.startsWith("artifacts/") ? artifact.path : `artifacts/${artifact.path}`}`
      );
    }
  } catch (error) {
    try {
      await authorizeArtifactDelivery(delivery);
    } catch {
      await input.messenger.sendPlain(
        "This saved file is no longer available to this conversation."
      );
      return;
    }
    await input.messenger.sendPlain(
      error instanceof Error ? error.message : "Failed to send the saved file."
    );
  }
}

export async function deliverTelegramTurnArtifactShares(input: {
  client: AtlasClient;
  ctx: Context;
  session: RemoteChatSession;
  conversationKey: string;
  profileId: string;
  sessionStore: SessionStore;
  messenger: TelegramRichMessenger;
  streamedArtifacts?: ChannelArtifactRef[];
  nativeMediaPaths?: ReadonlySet<string>;
}): Promise<void> {
  const messages = await input.session.getMessages();
  const paired = extractTurnDeliverableArtifacts(
    messages,
    input.streamedArtifacts
  );
  if (paired.length === 0) {
    return;
  }

  await authorizeArtifactDelivery(input);

  const shareUrlCache = input.sessionStore.getArtifactShareUrls(
    input.conversationKey
  );
  let webPublicUrlConfigured = true;
  const delivered = await mintDeliverableArtifacts({
    artifacts: paired,
    publish: async (path) => {
      await authorizeArtifactDelivery(input);
      const response = await input.client.publishProfileArtifactShare(
        input.profileId,
        path,
        { sessionId: input.session.id }
      );
      webPublicUrlConfigured = response.webPublicUrlConfigured;
      return response;
    },
    shareUrlCache,
  });

  if (delivered.length === 0) {
    return;
  }
  await authorizeArtifactDelivery(input);

  let registry = input.sessionStore.getDeliverableArtifacts(
    input.conversationKey
  );
  for (const artifact of delivered) {
    registry = pushDeliverableArtifact(registry, artifact);
  }

  input.sessionStore.updateArtifactState(input.conversationKey, {
    artifactShareUrls: shareUrlCache,
    deliverableArtifacts: registry,
  });
  await input.sessionStore.save();

  for (const artifact of delivered) {
    await authorizeArtifactDelivery(input);
    if (input.nativeMediaPaths?.has(artifact.path)) {
      continue;
    }
    if (artifact.sizeBytes > TELEGRAM_ARTIFACT_MAX_BYTES) {
      await input.messenger.sendPlain(
        `${formatTelegramArtifactTooLargeMessage(artifact.sizeBytes)} Saved file: ${artifact.path.startsWith("artifacts/") ? artifact.path : `artifacts/${artifact.path}`}`
      );
      continue;
    }

    try {
      const { data } = await input.client.readProfileArtifactContent(
        input.profileId,
        artifact.path,
        { sessionId: input.session.id }
      );
      await authorizeArtifactDelivery(input);
      const result = await sendTelegramArtifact(input.ctx, {
        bytes: new Uint8Array(data),
        filename: artifact.filename,
        mimeType: artifact.mimeType,
      });

      if (!result.ok && result.error) {
        await authorizeArtifactDelivery(input);
        await input.messenger.sendPlain(
          `${result.error} Saved file: ${artifact.path.startsWith("artifacts/") ? artifact.path : `artifacts/${artifact.path}`}`
        );
      }
    } catch (error) {
      await authorizeArtifactDelivery(input);
      await input.messenger.sendPlain(
        error instanceof Error
          ? error.message
          : "Failed to send the saved file."
      );
    }
  }

  const footer = formatArtifactShareFooter(delivered, {
    webPublicUrlConfigured,
  });

  if (footer.trim()) {
    await authorizeArtifactDelivery(input);
    // Raw: share tokens must not pass through markdown underscore stripping.
    await input.messenger.sendRaw(footer);
  }
}

async function authorizeArtifactDelivery(input: {
  ctx: Context;
  client: AtlasClient;
  session?: Pick<RemoteChatSession, "id">;
  conversationKey: string;
  profileId: string;
  sessionStore: SessionStore;
}): Promise<void> {
  const stored = input.sessionStore.get(input.conversationKey);
  const channelUserId = String(input.ctx.from?.id ?? "");
  if (
    !(stored && channelUserId) ||
    stored.channelUserId?.trim() !== channelUserId ||
    (input.session && input.session.id !== stored.sessionId)
  ) {
    throw new Error("The saved conversation has no verified sender.");
  }
  await input.client.authorizeChannelPrincipal({
    channel: "telegram",
    channelAddressed:
      !isTelegramGroupChat(input.ctx) ||
      explainGroupMessageHandling(input.ctx, input.ctx.me).shouldHandle,
    channelChatId: String(input.ctx.chat?.id ?? ""),
    channelIsGroup:
      input.ctx.chat?.type === "group" || input.ctx.chat?.type === "supergroup",
    channelThreadId:
      input.ctx.message?.message_thread_id === undefined
        ? undefined
        : String(input.ctx.message.message_thread_id),
    channelUserId,
    intent: "read",
    profileId: input.profileId,
    sessionId: stored.sessionId,
  });
}
