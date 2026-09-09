import type { AtlasClient, RemoteChatSession } from "@atlas/client";
import {
  type ChannelArtifactRef,
  type DeliverableChannelArtifact,
  extractTurnDeliverableArtifacts,
  formatArtifactShareFooter,
  formatMissingAttachArtifactMessage,
  isAttachIntent,
  isAttachOnlyCommand,
  mintDeliverableArtifacts,
  pushDeliverableArtifact,
  resolveArtifactForAttach,
} from "@atlas/core";
import type { WASocket } from "@whiskeysockets/baileys";
import {
  formatWhatsAppArtifactTooLargeMessage,
  sendWhatsAppArtifact,
  WHATSAPP_ARTIFACT_MEDIA_MAX_BYTES,
} from "./send-artifact-media";
import type { SessionStore } from "./session-store";

const ARTIFACT_TRANSFORM_INTENT_PATTERN =
  /\b(?:analy[sz]|build|change|clean|convert|create|edit|fix|format|generate|make|merge|modify|remove|rename|rewrite|split|summarize|translate|update)\w*\b/i;
const EXPLICIT_SHARE_LINK_PATTERN =
  /\b(?:(?:create|generate|give|make|send|share)\s+(?:me\s+)?(?:a\s+)?(?:download\s+|public\s+|share\s+)?link|(?:download|public|share)\s+link)\b/i;

export function isExplicitWhatsAppShareIntent(text: string): boolean {
  return EXPLICIT_SHARE_LINK_PATTERN.test(text.trim());
}

export function isPureWhatsAppAttachIntent(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return false;
  }

  if (isAttachOnlyCommand(normalized)) {
    return true;
  }

  const requestsDelivery =
    isAttachIntent(normalized) || isExplicitWhatsAppShareIntent(normalized);
  const instructionsWithoutShareRequest = normalized.replace(
    EXPLICIT_SHARE_LINK_PATTERN,
    ""
  );
  return (
    requestsDelivery &&
    !ARTIFACT_TRANSFORM_INTENT_PATTERN.test(instructionsWithoutShareRequest)
  );
}

export async function maybeSendRequestedWhatsAppArtifactAttachment(input: {
  beforeDelivery: () => Promise<void>;
  client: AtlasClient;
  conversationKey: string;
  getSocket: () => WASocket | null;
  jid: string;
  profileId: string;
  sessionStore: SessionStore;
  sendText: (jid: string, text: string) => Promise<void>;
  attachUserText: string;
}): Promise<boolean> {
  if (!isPureWhatsAppAttachIntent(input.attachUserText)) {
    return false;
  }

  const registry = input.sessionStore.getDeliverableArtifacts(
    input.conversationKey
  );
  const artifact = resolveArtifactForAttach({ listed: [], registry });
  if (!artifact) {
    await input.sendText(input.jid, formatMissingAttachArtifactMessage());
    return true;
  }

  const sessionId = input.sessionStore.get(input.conversationKey)?.sessionId;
  if (!sessionId) {
    await input.sendText(
      input.jid,
      "Could not verify the conversation for this saved file."
    );
    return true;
  }

  await deliverResolvedWhatsAppArtifacts({
    ...input,
    artifacts: [artifact],
    explicitShare: isExplicitWhatsAppShareIntent(input.attachUserText),
    sessionId,
  });
  return true;
}

export async function deliverWhatsAppTurnArtifactShares(input: {
  alreadyDeliveredPaths?: readonly string[];
  beforeDelivery: () => Promise<void>;
  client: AtlasClient;
  conversationKey: string;
  getSocket: () => WASocket | null;
  jid: string;
  profileId: string;
  session: RemoteChatSession;
  sessionStore: SessionStore;
  sendText: (jid: string, text: string) => Promise<void>;
  shareUserText?: string;
  streamedArtifacts?: ChannelArtifactRef[];
}): Promise<void> {
  const messages = await input.session.getMessages();
  const artifacts = extractTurnDeliverableArtifacts(
    messages,
    input.streamedArtifacts
  );
  if (artifacts.length === 0) {
    return;
  }

  await deliverResolvedWhatsAppArtifacts({
    ...input,
    artifacts,
    explicitShare: isExplicitWhatsAppShareIntent(input.shareUserText ?? ""),
    sessionId: input.session.id,
  });
}

async function deliverResolvedWhatsAppArtifacts(input: {
  alreadyDeliveredPaths?: readonly string[];
  beforeDelivery: () => Promise<void>;
  artifacts: ChannelArtifactRef[];
  client: AtlasClient;
  conversationKey: string;
  explicitShare: boolean;
  getSocket: () => WASocket | null;
  jid: string;
  profileId: string;
  sessionId: string;
  sendText: (jid: string, text: string) => Promise<void>;
  sessionStore: SessionStore;
}): Promise<void> {
  const shareUrlCache = input.sessionStore.getArtifactShareUrls(
    input.conversationKey
  );
  const shareCandidates: ChannelArtifactRef[] = [];
  let webPublicUrlConfigured = true;
  const alreadyDelivered = new Set(
    input.alreadyDeliveredPaths?.map((path) => path.replace(/^artifacts\//, ""))
  );
  for (const artifact of input.artifacts) {
    await verifyDeliveryAllowed(input.beforeDelivery);
    if (alreadyDelivered.has(artifact.path.replace(/^artifacts\//, ""))) {
      if (input.explicitShare) {
        shareCandidates.push(artifact);
      }
      continue;
    }
    let needsShare = input.explicitShare;
    if (artifact.sizeBytes > WHATSAPP_ARTIFACT_MEDIA_MAX_BYTES) {
      await input.sendText(
        input.jid,
        `${formatWhatsAppArtifactTooLargeMessage(artifact.sizeBytes)} Saved file: ${artifact.path.startsWith("artifacts/") ? artifact.path : `artifacts/${artifact.path}`}`
      );
      shareCandidates.push(artifact);
      continue;
    }

    try {
      const { data } = await input.client.readProfileArtifactContent(
        input.profileId,
        artifact.path,
        { sessionId: input.sessionId }
      );
      const result = await sendWhatsAppArtifact(input.getSocket(), input.jid, {
        beforeSend: () => verifyDeliveryAllowed(input.beforeDelivery),
        bytes: new Uint8Array(data),
        filename: artifact.filename,
        mimeType: artifact.mimeType,
      });

      if (result.ok) {
        if (needsShare) {
          shareCandidates.push(artifact);
        }
        continue;
      }

      needsShare = true;
      await verifyDeliveryAllowed(input.beforeDelivery);
      if (result.error) {
        await input.sendText(
          input.jid,
          `${result.error} Saved file: ${artifact.path.startsWith("artifacts/") ? artifact.path : `artifacts/${artifact.path}`}`
        );
      }
    } catch (error) {
      await verifyDeliveryAllowed(input.beforeDelivery);
      await input.sendText(
        input.jid,
        error instanceof Error
          ? error.message
          : "Failed to send the saved file."
      );
      needsShare = true;
    }

    if (needsShare) {
      shareCandidates.push(artifact);
    }
  }

  await verifyDeliveryAllowed(input.beforeDelivery);
  const shared = await mintDeliverableArtifacts({
    artifacts: shareCandidates,
    publish: async (path) => {
      await verifyDeliveryAllowed(input.beforeDelivery);
      const response = await input.client.publishProfileArtifactShare(
        input.profileId,
        path,
        { sessionId: input.sessionId }
      );
      webPublicUrlConfigured = response.webPublicUrlConfigured;
      return response;
    },
    shareUrlCache,
  });
  const sharedByPath = new Map(
    shared.map((artifact) => [artifact.path, artifact])
  );
  let registry = input.sessionStore.getDeliverableArtifacts(
    input.conversationKey
  );

  for (const artifact of input.artifacts) {
    const existing = registry.find((entry) => entry.path === artifact.path);
    const deliverable: DeliverableChannelArtifact = sharedByPath.get(
      artifact.path
    ) ?? {
      ...artifact,
      sharePath: existing?.sharePath ?? null,
      shareUrl: existing?.shareUrl ?? shareUrlCache[artifact.path] ?? null,
    };
    registry = pushDeliverableArtifact(registry, deliverable);
  }

  input.sessionStore.updateArtifactState(input.conversationKey, {
    artifactShareUrls: shareUrlCache,
    deliverableArtifacts: registry,
  });
  await input.sessionStore.save();

  const footer = formatArtifactShareFooter(shared, {
    webPublicUrlConfigured,
  });

  if (footer.trim()) {
    await verifyDeliveryAllowed(input.beforeDelivery);
    await input.sendText(input.jid, footer);
  }
}

async function verifyDeliveryAllowed(
  authorize: () => Promise<void>
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      authorize(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error("WhatsApp file delivery authorization timed out.")
            ),
          10_000
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
