import { randomUUID } from "node:crypto";
import { chmod, lstat, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DeliverableChannelArtifact } from "@atlas/core/channel-artifact-delivery";
import { ensureDir, PRIVATE_FILE_MODE, readTextOrNull } from "@atlas/core/fs";
import {
  getWhatsAppConfigDir,
  normalizeWhatsAppUserJid,
} from "@atlas/core/whatsapp-config";

export interface ChatSessionRecord {
  artifactShareUrls?: Record<string, string>;
  channelUserId?: string;
  deliverableArtifacts?: DeliverableChannelArtifact[];
  discardMessagesThrough?: number;
  /** Chat controls apply only to this sender's session, including in groups. */
  paused?: boolean;
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
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(path = getChatSessionsPath()) {
    this.path = path;
  }

  async load(): Promise<void> {
    this.hotSessions.clear();
    this.map = {};
    const raw = await readTextOrNull(this.path);

    if (raw === null) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      await this.recoverCorruptStore();
      return;
    }

    const sessionMap = parseChatSessionMap(parsed);
    if (!sessionMap) {
      await this.recoverCorruptStore();
      return;
    }

    this.map = sessionMap;
  }

  get(jid: string): ChatSessionRecord | undefined {
    const key = normalizeSessionStoreKey(jid);
    return this.map[key] ?? this.map[jid];
  }

  set(jid: string, record: ChatSessionRecord): void {
    const key = normalizeSessionStoreKey(jid);
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
    const key = normalizeSessionStoreKey(jid);
    delete this.map[key];
    delete this.map[jid];
    this.hotSessions.delete(key);
    this.hotSessions.delete(jid);
  }

  getHotSession<T>(jid: string): T | undefined {
    const key = normalizeSessionStoreKey(jid);
    return (this.hotSessions.get(key) ?? this.hotSessions.get(jid)) as
      | T
      | undefined;
  }

  setHotSession(jid: string, session: unknown): void {
    const key = normalizeSessionStoreKey(jid);
    this.hotSessions.set(key, session);
  }

  deleteByChannelUserId(channelUserId: string): string[] {
    const normalizedChannelUserId = normalizeWhatsAppUserJid(channelUserId);
    const deletedSessionKeys = new Set<string>();

    for (const [key, record] of Object.entries(this.map)) {
      const recordChannelUserId = record.channelUserId?.trim()
        ? normalizeWhatsAppUserJid(record.channelUserId)
        : null;
      const directKeyMatches =
        !key.startsWith("group:") &&
        normalizeSessionStoreKey(key) === normalizedChannelUserId;

      if (
        recordChannelUserId !== normalizedChannelUserId &&
        !directKeyMatches
      ) {
        continue;
      }

      this.delete(key);
      deletedSessionKeys.add(normalizeSessionStoreKey(key));
    }

    return [...deletedSessionKeys];
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
    const snapshot = `${JSON.stringify(this.map, null, 2)}\n`;
    const write = this.writeQueue.then(
      () => this.writeSnapshot(snapshot),
      () => this.writeSnapshot(snapshot)
    );
    this.writeQueue = write.catch(() => undefined);
    await write;
  }

  private async recoverCorruptStore(): Promise<void> {
    const backupPath = `${this.path}.corrupt-${Date.now()}-${randomUUID()}`;
    let moved = false;
    try {
      await rename(this.path, backupPath);
      moved = true;
      const backupStat = await lstat(backupPath);
      if (backupStat.isFile()) {
        await chmod(backupPath, PRIVATE_FILE_MODE);
      } else {
        await unlink(backupPath);
        moved = false;
      }
    } catch {
      if (moved) {
        await unlink(backupPath).catch(() => undefined);
      }
      // The in-memory store is already empty; recovery must not stop the worker.
    }
    console.warn(
      "Ignored a corrupt WhatsApp chat session store and started with no cached sessions."
    );
  }

  private async writeSnapshot(snapshot: string): Promise<void> {
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await ensureDir(dirname(this.path));
    try {
      await writeFile(temporaryPath, snapshot, {
        encoding: "utf8",
        flag: "wx",
        mode: PRIVATE_FILE_MODE,
      });
      await chmod(temporaryPath, PRIVATE_FILE_MODE);
      await rename(temporaryPath, this.path);
      await chmod(this.path, PRIVATE_FILE_MODE);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

function parseChatSessionMap(input: unknown): ChatSessionMap | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }

  const map: ChatSessionMap = Object.create(null) as ChatSessionMap;
  for (const [key, value] of Object.entries(input)) {
    if (!isChatSessionRecord(value)) {
      return null;
    }
    map[key] = value;
  }
  return map;
}

function isChatSessionRecord(input: unknown): input is ChatSessionRecord {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }

  const record = input as Partial<ChatSessionRecord>;
  if (
    typeof record.profileId !== "string" ||
    typeof record.sessionId !== "string" ||
    typeof record.updatedAt !== "string" ||
    (record.paused !== undefined && typeof record.paused !== "boolean") ||
    (record.discardMessagesThrough !== undefined &&
      !(
        typeof record.discardMessagesThrough === "number" &&
        Number.isFinite(record.discardMessagesThrough)
      )) ||
    (record.channelUserId !== undefined &&
      typeof record.channelUserId !== "string") ||
    (record.deliverableArtifacts !== undefined &&
      !Array.isArray(record.deliverableArtifacts)) ||
    !isStringRecordOrUndefined(record.artifactShareUrls)
  ) {
    return false;
  }

  return true;
}

function isStringRecordOrUndefined(input: unknown): boolean {
  if (input === undefined) {
    return true;
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return false;
  }
  return Object.values(input).every((value) => typeof value === "string");
}

function normalizeSessionStoreKey(key: string): string {
  return key.startsWith("group:") ? key : normalizeWhatsAppUserJid(key);
}

function getChatSessionsPath(): string {
  return join(getWhatsAppConfigDir(), "chat-sessions.json");
}
