import { dirname, join } from "node:path";
import type { DeliverableChannelArtifact } from "@atlas/core/channel-artifact-delivery";
import { readTextOrNull, writePrivateTextFile } from "@atlas/core/fs";
import {
  getWhatsAppConfigDir,
  normalizeWhatsAppUserJid,
} from "@atlas/core/whatsapp-config";

export interface ChatSessionRecord {
  artifactShareUrls?: Record<string, string>;
  deliverableArtifacts?: DeliverableChannelArtifact[];
  profileId: string;
  /** True when /profile overrides the integration's configured reply profile. */
  profileOverride?: boolean;
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

  get(jid: string): ChatSessionRecord | undefined {
    const key = normalizeWhatsAppUserJid(jid);
    return this.map[key] ?? this.map[jid];
  }

  set(jid: string, record: ChatSessionRecord): void {
    const key = normalizeWhatsAppUserJid(jid);
    const previous = this.map[key] ?? this.map[jid];
    if (key !== jid) {
      delete this.map[jid];
    }
    this.map[key] = record;
    if (previous && previous.sessionId !== record.sessionId) {
      this.hotSessions.delete(key);
      this.hotSessions.delete(jid);
    }
  }

  delete(jid: string): void {
    const key = normalizeWhatsAppUserJid(jid);
    delete this.map[key];
    delete this.map[jid];
    this.hotSessions.delete(key);
    this.hotSessions.delete(jid);
  }

  getHotSession<T>(jid: string): T | undefined {
    const key = normalizeWhatsAppUserJid(jid);
    return (this.hotSessions.get(key) ?? this.hotSessions.get(jid)) as
      | T
      | undefined;
  }

  setHotSession(jid: string, session: unknown): void {
    const key = normalizeWhatsAppUserJid(jid);
    this.hotSessions.set(key, session);
  }

  getArtifactShareUrls(jid: string): Record<string, string> {
    return { ...(this.get(jid)?.artifactShareUrls ?? {}) };
  }

  getDeliverableArtifacts(jid: string): DeliverableChannelArtifact[] {
    return [...(this.get(jid)?.deliverableArtifacts ?? [])];
  }

  updateArtifactState(
    jid: string,
    update: {
      artifactShareUrls?: Record<string, string>;
      deliverableArtifacts?: DeliverableChannelArtifact[];
    }
  ): void {
    const existing = this.get(jid);
    if (!existing) {
      return;
    }

    this.set(jid, {
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
  return join(getWhatsAppConfigDir(), "chat-sessions.json");
}
