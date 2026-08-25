import type { AtlasClient, RemoteChatSession } from "@atlas/client";
import {
  type ChannelArtifactRef,
  extractTurnDeliverableArtifacts,
  formatArtifactShareFooter,
  getMostRecentDeliverableArtifact,
  isAttachIntent,
  mintDeliverableArtifacts,
  pushDeliverableArtifact,
} from "@atlas/core";
import type { WASocket } from "@whiskeysockets/baileys";
import {
  formatWhatsAppArtifactTooLargeMessage,
  sendWhatsAppArtifact,
  WHATSAPP_ARTIFACT_MEDIA_MAX_BYTES,
} from "./send-artifact-media";
import type { SessionStore } from "./session-store";

export async function maybeSendRequestedWhatsAppArtifactAttachment(input: {
  client: AtlasClient;
  conversationKey: string;
  getSocket: () => WASocket | null;
  jid: string;
  profileId: string;
  sessionStore: SessionStore;
  sendText: (jid: string, text: string) => Promise<void>;
  attachUserText: string;
}): Promise<void> {
  if (!isAttachIntent(input.attachUserText)) {
    return;
  }

  const artifact = getMostRecentDeliverableArtifact(
    input.sessionStore.getDeliverableArtifacts(input.conversationKey)
  );
  if (!artifact) {
    return;
  }

  try {
    const { data } = await input.client.readProfileArtifactContent(
      input.profileId,
      artifact.path
    );
    const result = await sendWhatsAppArtifact(input.getSocket(), input.jid, {
      bytes: new Uint8Array(data),
      filename: artifact.filename,
      mimeType: artifact.mimeType,
    });

    if (!result.ok && result.error) {
      await input.sendText(input.jid, result.error);
    }
  } catch (error) {
    await input.sendText(
      input.jid,
      error instanceof Error ? error.message : "Failed to send the saved file."
    );
  }
}

export async function deliverWhatsAppTurnArtifactShares(input: {
  client: AtlasClient;
  conversationKey: string;
  getSocket: () => WASocket | null;
  jid: string;
  profileId: string;
  session: RemoteChatSession;
  sessionStore: SessionStore;
  sendText: (jid: string, text: string) => Promise<void>;
  streamedArtifacts?: ChannelArtifactRef[];
}): Promise<void> {
  const messages = await input.session.getMessages();
  const paired = extractTurnDeliverableArtifacts(
    messages,
    input.streamedArtifacts
  );
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
    if (artifact.sizeBytes > WHATSAPP_ARTIFACT_MEDIA_MAX_BYTES) {
      await input.sendText(
        input.jid,
        formatWhatsAppArtifactTooLargeMessage(artifact.sizeBytes)
      );
      continue;
    }

    try {
      const { data } = await input.client.readProfileArtifactContent(
        input.profileId,
        artifact.path
      );
      const result = await sendWhatsAppArtifact(input.getSocket(), input.jid, {
        bytes: new Uint8Array(data),
        filename: artifact.filename,
        mimeType: artifact.mimeType,
      });

      if (!result.ok && result.error) {
        await input.sendText(input.jid, result.error);
      }
    } catch (error) {
      await input.sendText(
        input.jid,
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
    await input.sendText(input.jid, footer);
  }
}
