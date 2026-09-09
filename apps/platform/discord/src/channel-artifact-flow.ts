import type { AtlasClient, RemoteChatSession } from "@atlas/client";
import {
  type ChannelArtifactRef,
  type DeliverableChannelArtifact,
  extractTurnDeliverableArtifacts,
  formatArtifactShareFooter,
  formatMissingAttachArtifactMessage,
  isAttachOnlyCommand,
  mintDeliverableArtifacts,
  pushDeliverableArtifact,
  resolveArtifactForAttach,
} from "@atlas/core";
import { formatDiscordAttachmentSizeLimitMessage } from "@atlas/core/discord-attachment";
import type { TextBasedChannel } from "discord.js";
import type { DiscordMessenger } from "./messenger";
import { resolveDiscordNativeOrigin } from "./native-origin";
import {
  DISCORD_ARTIFACT_ATTACHMENT_MAX_BYTES,
  sendDiscordArtifactAttachment,
} from "./send-artifact-attachment";
import type { SessionStore } from "./session-store";

async function authorizeDiscordArtifactRead(input: {
  channel: TextBasedChannel;
  channelAddressed?: boolean;
  channelUserId: string;
  client: AtlasClient;
  profileId: string;
  sessionId: string;
}): Promise<void> {
  await input.client.authorizeChannelPrincipal({
    ...(await resolveDiscordNativeOrigin(
      input.channel,
      input.channelAddressed
    )),
    channel: "discord",
    channelUserId: input.channelUserId,
    intent: "read",
    profileId: input.profileId,
    sessionId: input.sessionId,
  });
}

async function canStillDeliver(
  authorize: () => Promise<void>
): Promise<boolean> {
  try {
    await authorize();
    return true;
  } catch {
    return false;
  }
}

export async function uploadDiscordArtifactFromToolResult(input: {
  channel: TextBasedChannel;
  channelAddressed?: boolean;
  channelUserId: string;
  client: AtlasClient;
  messenger: DiscordMessenger;
  profileId: string;
  result: unknown;
  sessionId: string;
}): Promise<string | null> {
  const artifact = parseSendDiscordArtifactResult(input.result);
  if (!artifact) {
    return null;
  }

  try {
    await authorizeDiscordArtifactRead(input);
    const { data } = await input.client.readProfileArtifactContent(
      input.profileId,
      artifact.path,
      { sessionId: input.sessionId }
    );
    await authorizeDiscordArtifactRead(input);
    const result = await sendDiscordArtifactAttachment(input.channel, {
      bytes: new Uint8Array(data),
      filename: artifact.filename,
      mimeType: artifact.mimeType,
    });

    if (!result.ok && result.error) {
      await authorizeDiscordArtifactRead(input);
      await input.messenger.send(
        `${result.error} Saved file: ${artifact.path.startsWith("artifacts/") ? artifact.path : `artifacts/${artifact.path}`}`
      );
      return null;
    }

    return result.ok ? artifact.path : null;
  } catch (error) {
    if (!(await canStillDeliver(() => authorizeDiscordArtifactRead(input)))) {
      return null;
    }
    await input.messenger.send(
      error instanceof Error
        ? error.message
        : "Failed to read the artifact for attachment."
    );
    return null;
  }
}

function parseSendDiscordArtifactResult(result: unknown): {
  filename: string;
  mimeType: string;
  path: string;
} | null {
  if (typeof result !== "object" || result === null) {
    return null;
  }

  const record = result as Record<string, unknown>;
  if (record.ok !== true) {
    return null;
  }

  if (
    typeof record.path !== "string" ||
    typeof record.filename !== "string" ||
    typeof record.mimeType !== "string"
  ) {
    return null;
  }

  return {
    filename: record.filename,
    mimeType: record.mimeType,
    path: record.path,
  };
}

export async function maybeSendRequestedDiscordArtifactAttachment(input: {
  channel: TextBasedChannel;
  channelAddressed?: boolean;
  channelUserId: string;
  client: AtlasClient;
  conversationKey: string;
  profileId: string;
  /** Raw user text before group-context prefixing. */
  attachUserText: string;
  sessionStore: SessionStore;
  messenger: DiscordMessenger;
}): Promise<boolean> {
  if (!isAttachOnlyCommand(input.attachUserText)) {
    return false;
  }

  await authorizeArtifactDelivery(input);

  const registry = input.sessionStore.getDeliverableArtifacts(
    input.conversationKey
  );
  const sessionId = input.sessionStore.get(input.conversationKey)?.sessionId;
  const deliveryInput = { ...input, sessionId };
  let listed: Awaited<
    ReturnType<AtlasClient["listProfileArtifacts"]>
  >["artifacts"] = [];

  if (registry.length === 0) {
    try {
      const response = await input.client.listProfileArtifacts(
        input.profileId,
        { sessionId }
      );
      listed = response.artifacts;
    } catch (error) {
      console.warn(
        "Discord artifact list failed during /attach; cannot fall back to profile artifacts.",
        error instanceof Error ? error.message : error
      );
    }
  }

  const artifact = resolveArtifactForAttach({
    listed,
    registry,
  });

  if (!artifact) {
    await authorizeArtifactDelivery(deliveryInput);
    await input.messenger.send(formatMissingAttachArtifactMessage());
    return false;
  }

  if (!registry.some((entry) => entry.path === artifact.path)) {
    const nextRegistry = pushDeliverableArtifact(registry, artifact);
    input.sessionStore.updateArtifactState(input.conversationKey, {
      deliverableArtifacts: nextRegistry,
    });
    await input.sessionStore.save();
  }

  try {
    await authorizeArtifactDelivery(deliveryInput);
    const { data } = await input.client.readProfileArtifactContent(
      input.profileId,
      artifact.path,
      { sessionId }
    );
    await authorizeArtifactDelivery(deliveryInput);
    const result = await sendDiscordArtifactAttachment(input.channel, {
      bytes: new Uint8Array(data),
      filename: artifact.filename,
      mimeType: artifact.mimeType,
    });

    if (!result.ok && result.error) {
      await authorizeArtifactDelivery(deliveryInput);
      await input.messenger.send(
        `${result.error} Saved file: ${artifact.path.startsWith("artifacts/") ? artifact.path : `artifacts/${artifact.path}`}`
      );
      return false;
    }

    return result.ok;
  } catch (error) {
    if (
      !(await canStillDeliver(() => authorizeArtifactDelivery(deliveryInput)))
    ) {
      return false;
    }
    await input.messenger.send(
      error instanceof Error
        ? error.message
        : "Failed to read the artifact for attachment."
    );
    return false;
  }
}

export async function deliverDiscordTurnArtifactShares(input: {
  channel: TextBasedChannel;
  channelAddressed?: boolean;
  channelUserId: string;
  client: AtlasClient;
  session: RemoteChatSession;
  conversationKey: string;
  profileId: string;
  sessionStore: SessionStore;
  messenger: DiscordMessenger;
  skipPaths?: Iterable<string>;
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

  let nextRegistry = input.sessionStore.getDeliverableArtifacts(
    input.conversationKey
  );
  for (const artifact of delivered) {
    nextRegistry = pushDeliverableArtifact(nextRegistry, artifact);
  }

  input.sessionStore.updateArtifactState(input.conversationKey, {
    artifactShareUrls: shareUrlCache,
    deliverableArtifacts: nextRegistry,
  });
  await input.sessionStore.save();

  const alreadyUploaded = new Set(input.skipPaths ?? []);

  for (const artifact of delivered) {
    await authorizeArtifactDelivery(input);
    if (alreadyUploaded.has(artifact.path)) {
      continue;
    }

    const uploaded = await tryUploadDiscordArtifact({
      artifact,
      authorize: () => authorizeArtifactDelivery(input),
      channel: input.channel,
      client: input.client,
      profileId: input.profileId,
      sessionId: input.session.id,
    });

    if (!(uploaded || artifact.shareUrl || artifact.sharePath)) {
      const error =
        artifact.sizeBytes > DISCORD_ARTIFACT_ATTACHMENT_MAX_BYTES
          ? formatDiscordAttachmentSizeLimitMessage(artifact.sizeBytes)
          : `Failed to send ${artifact.filename}.`;
      await authorizeArtifactDelivery(input);
      await input.messenger.send(
        `${error} Saved file: ${artifact.path.startsWith("artifacts/") ? artifact.path : `artifacts/${artifact.path}`}`
      );
    }
  }

  // Always post share links (like Telegram); attachment upload is additive.
  const footer = formatArtifactShareFooter(delivered, {
    webPublicUrlConfigured,
  });

  if (footer.trim()) {
    await authorizeArtifactDelivery(input);
    await input.messenger.send(footer);
  }
}

async function tryUploadDiscordArtifact(input: {
  authorize: () => Promise<void>;
  channel: TextBasedChannel;
  client: AtlasClient;
  profileId: string;
  sessionId: string;
  artifact: DeliverableChannelArtifact;
}): Promise<boolean> {
  await input.authorize();
  if (input.artifact.sizeBytes > DISCORD_ARTIFACT_ATTACHMENT_MAX_BYTES) {
    return false;
  }

  try {
    const { data } = await input.client.readProfileArtifactContent(
      input.profileId,
      input.artifact.path,
      { sessionId: input.sessionId }
    );
    const bytes = new Uint8Array(data);
    if (bytes.byteLength > DISCORD_ARTIFACT_ATTACHMENT_MAX_BYTES) {
      return false;
    }

    await input.authorize();
    const result = await sendDiscordArtifactAttachment(input.channel, {
      bytes,
      filename: input.artifact.filename,
      mimeType: input.artifact.mimeType,
    });

    if (!result.ok) {
      console.warn(
        `Discord artifact upload failed for ${input.artifact.filename}; falling back to share link.`,
        result.error ?? "unknown error"
      );
    }

    return result.ok;
  } catch (error) {
    await input.authorize();
    console.warn(
      `Discord artifact upload failed for ${input.artifact.filename}; falling back to share link.`,
      error instanceof Error ? error.message : error
    );
    return false;
  }
}

async function authorizeArtifactDelivery(input: {
  channel: TextBasedChannel;
  channelAddressed?: boolean;
  channelUserId: string;
  client: AtlasClient;
  session?: RemoteChatSession;
  sessionId?: string;
  conversationKey: string;
  profileId: string;
  sessionStore: SessionStore;
}): Promise<void> {
  const stored = input.sessionStore.get(input.conversationKey);
  const channelUserId = input.channelUserId.trim();
  if (
    !(stored && channelUserId) ||
    stored.channelUserId?.trim() !== channelUserId ||
    stored.profileId !== input.profileId ||
    (input.sessionId && input.sessionId !== stored.sessionId) ||
    (input.session && input.session.id !== stored.sessionId)
  ) {
    throw new Error("The saved conversation has no verified sender.");
  }
  await authorizeDiscordArtifactRead({
    channel: input.channel,
    channelAddressed: input.channelAddressed,
    channelUserId,
    client: input.client,
    profileId: input.profileId,
    sessionId: stored.sessionId,
  });
}
