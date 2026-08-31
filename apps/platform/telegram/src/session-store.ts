import { dirname, join } from "node:path";
import type { DeliverableChannelArtifact } from "@atlas/core/channel-artifact-delivery";
import { readTextOrNull, writePrivateTextFile } from "@atlas/core/fs";
import { getTelegramConfigDir } from "@atlas/core/telegram-config";

export interface ChatSessionRecord {
  artifactShareUrls?: Record<string, string>;
  channelUserId?: string;
  deliverableArtifacts?: DeliverableChannelArtifact[];
  profileId: string;
  sessionId: string;
  updatedAt: string;
}

type ChatSessionMap = Record<string, ChatSessionRecord>;

export class SessionStore {
  private readonly path: string;
  private map: ChatSessionMap = {};
  private readonly hotSessions = new Map<string, unknown>();

  constructor(path = getChatSessionsPath()) {
    this.path = path;
  }

  async load(): Promise<void> {
    this.hotSessions.clear();
    const raw = await readTextOrNull(this.path);

    if (raw === null) {
      this.map = {};
      return;
    }

    const parsed = JSON.parse(raw) as unknown;

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      this.map = {};
      return;
    }

    this.map = parsed as ChatSessionMap;
  }

  get(chatId: string): ChatSessionRecord | undefined {
    return this.map[chatId];
  }

  set(chatId: string, record: ChatSessionRecord): void {
    const previous = this.map[chatId];
    this.map[chatId] = record;
    if (previous && previous.sessionId !== record.sessionId) {
      this.hotSessions.delete(chatId);
    }
  }

  delete(chatId: string): void {
    delete this.map[chatId];
    this.hotSessions.delete(chatId);
  }

  getHotSession<T>(chatId: string): T | undefined {
    return this.hotSessions.get(chatId) as T | undefined;
  }

  setHotSession(chatId: string, session: unknown): void {
    this.hotSessions.set(chatId, session);
  }

  deleteByChannelUserId(channelUserId: string): string[] {
    const normalized = channelUserId.trim();
    const deleted: string[] = [];
    for (const [chatId, record] of Object.entries(this.map)) {
      if (record.channelUserId?.trim() !== normalized) {
        continue;
      }
      delete this.map[chatId];
      deleted.push(chatId);
    }
    return deleted;
  }

  getArtifactShareUrls(chatId: string): Record<string, string> {
    return { ...(this.get(chatId)?.artifactShareUrls ?? {}) };
  }

  getDeliverableArtifacts(chatId: string): DeliverableChannelArtifact[] {
    return [...(this.get(chatId)?.deliverableArtifacts ?? [])];
  }

  updateArtifactState(
    chatId: string,
    update: {
      artifactShareUrls?: Record<string, string>;
      deliverableArtifacts?: DeliverableChannelArtifact[];
    }
  ): void {
    const existing = this.get(chatId);
    if (!existing) {
      return;
    }

    this.set(chatId, {
      ...existing,
      artifactShareUrls: update.artifactShareUrls ?? existing.artifactShareUrls,
      deliverableArtifacts:
        update.deliverableArtifacts ?? existing.deliverableArtifacts,
    });
  }

  async save(): Promise<void> {
    await writePrivateTextFile(
      this.path,
      `${JSON.stringify(this.map, null, 2)}\n`,
      {
        ensureDir: dirname(this.path),
      }
    );
  }
}

function getChatSessionsPath(): string {
  return join(getTelegramConfigDir(), "chat-sessions.json");
}
