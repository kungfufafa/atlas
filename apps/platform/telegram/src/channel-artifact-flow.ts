import type { AtlasClient, RemoteChatSession } from "@atlas/client";
import {
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
import type { TelegramRichMessenger } from "./rich-message";
import {
  formatTelegramArtifactTooLargeMessage,
  sendTelegramArtifactDocument,
  TELEGRAM_ARTIFACT_DOCUMENT_MAX_BYTES,
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

  try {
    const { data } = await input.client.readProfileArtifactContent(
      input.profileId,
      artifact.path
    );
    const result = await sendTelegramArtifactDocument(input.ctx, {
      bytes: new Uint8Array(data),
      filename: artifact.filename,
    });

    if (!result.ok && result.error) {
      await input.messenger.sendPlain(result.error);
    }
  } catch (error) {
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
}): Promise<void> {
  const messages = await input.session.getMessages();
  const paired = extractTurnDeliverableArtifacts(messages);
  if (paired.length === 0) {
    return;
  }

  const shareUrlCache = input.sessionStore.getArtifactShareUrls(
    input.conversationKey
  );
  let webPublicUrlConfigured = true;
  const delivered = await mintDeliverableArtifacts({
    artifacts: paired,
    publish: async (path) => {
      const response = await input.client.publishProfileArtifactShare(
        input.profileId,
        path
      );
      webPublicUrlConfigured = response.webPublicUrlConfigured;
      return response;
    },
    shareUrlCache,
  });

  if (delivered.length === 0) {
    return;
  }

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
    if (artifact.sizeBytes > TELEGRAM_ARTIFACT_DOCUMENT_MAX_BYTES) {
      await input.messenger.sendPlain(
        formatTelegramArtifactTooLargeMessage(artifact.sizeBytes)
      );
      continue;
    }

    try {
      const { data } = await input.client.readProfileArtifactContent(
        input.profileId,
        artifact.path
      );
      const result = await sendTelegramArtifactDocument(input.ctx, {
        bytes: new Uint8Array(data),
        filename: artifact.filename,
      });

      if (!result.ok && result.error) {
        await input.messenger.sendPlain(result.error);
      }
    } catch (error) {
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
    // Raw: share tokens must not pass through markdown underscore stripping.
    await input.messenger.sendRaw(footer);
  }
}
