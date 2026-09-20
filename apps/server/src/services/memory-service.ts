import {
  type ContinuityMemoryFact,
  loadProfileMemoryArchiveFacts,
  nanoid,
} from "@atlas/core";
import { calculateTitleSimilarity } from "@atlas/core/tools/url-utils";
import {
  type DatabaseAdapter,
  type MemoryScope,
  memoryResultLimit,
  type StoredMemoryRecord,
  searchRankedMemories,
  tokenizeMemoryQuery,
} from "@atlas/db";

const SENSITIVE_PATTERNS = [
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/i,
  /sk-[a-zA-Z0-9_-]{20,}/i,
  /ghp_[a-zA-Z0-9_-]{30,}/i,
  /bearer\s+[a-zA-Z0-9_\-.]{25,}/i,
  /password\s*[:=]\s*["']?[^\s"']{6,}["']?/i,
  /client_secret\s*[:=]\s*["']?[^\s"']{10,}["']?/i,
  /api_key\s*[:=]\s*["']?[^\s"']{15,}["']?/i,
];

export interface WriteMemoryInput {
  confidence?: number;
  content: string;
  importance?: number;
  ownerId: string;
  scope: MemoryScope;
  source?: string;
  subject?: string;
}

export interface SearchMemoryOptions {
  /** When false, skip profile `memory-archive/` even if the service indexes it. */
  indexProfileArchive?: boolean;
  limit?: number;
  ownerId?: string;
  /** Profile whose `memory-archive/` should be searched (agent/visible path). */
  profileId?: string;
  scope?: MemoryScope;
}

export interface MemoryServiceOptions {
  /** Default true. Production `memory_search` ranks parsed archive files with DB rows. */
  indexProfileArchive?: boolean;
}

function normalizedSubject(subject: string | null | undefined): string | null {
  return subject?.normalize("NFKC").trim().toLowerCase() || null;
}

function archiveFactToStoredMemory(
  fact: ContinuityMemoryFact,
  orgId: string,
  profileId: string
): StoredMemoryRecord {
  return {
    confidence: 1,
    content: fact.content,
    createdAt: fact.updatedAt,
    id: fact.id,
    importance: fact.importance ?? 1,
    orgId,
    ownerId: profileId,
    scope: "agent",
    source: "memory-archive",
    subject: fact.subject ?? null,
    updatedAt: fact.updatedAt,
  };
}

function mergeMemoryRecords(
  records: readonly StoredMemoryRecord[]
): StoredMemoryRecord[] {
  const seen = new Set<string>();
  const merged: StoredMemoryRecord[] = [];
  for (const record of records) {
    if (seen.has(record.id)) {
      continue;
    }
    seen.add(record.id);
    merged.push(record);
  }
  return merged;
}

export class MemoryService {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly options: MemoryServiceOptions = {}
  ) {}

  private sanitizeAndValidate(content: string): void {
    for (const pattern of SENSITIVE_PATTERNS) {
      if (pattern.test(content)) {
        throw new Error(
          "Memory content contains sensitive credentials, keys, or passwords. Storing secrets in memory is blocked."
        );
      }
    }
  }

  async writeMemory(
    orgId: string,
    input: WriteMemoryInput,
    options: { strategy?: "preserve" | "legacy-upsert" } = {}
  ): Promise<StoredMemoryRecord> {
    if (!orgId?.trim()) {
      throw new Error("orgId is required for memory operations.");
    }
    const cleanContent = input.content.trim();
    if (!cleanContent) {
      throw new Error("Memory content cannot be empty.");
    }

    this.sanitizeAndValidate(cleanContent);
    const subject = normalizedSubject(input.subject);

    // The native save tool preserves independent facts. Other callers keep
    // their existing upsert contract until explicitly migrated.
    const existingMemories =
      options.strategy === "preserve"
        ? []
        : await this.db.listMemories(orgId, input.scope, input.ownerId, 50);

    // Similar wording does not make two explicitly different subjects the same
    // memory. Preserve existing same-subject replacement and unlabelled dedup.
    for (const mem of existingMemories) {
      const existingSubject = normalizedSubject(mem.subject);
      if (subject && existingSubject && subject !== existingSubject) {
        continue;
      }
      const similarity = calculateTitleSimilarity(mem.content, cleanContent);
      const sameSubject = subject !== null && subject === existingSubject;

      if (similarity >= 0.75 || sameSubject) {
        // Update existing memory
        const updated: StoredMemoryRecord = {
          ...mem,
          confidence: input.confidence ?? mem.confidence,
          content: cleanContent,
          importance: Math.max(mem.importance, input.importance ?? 1),
          source: input.source ?? mem.source,
          subject: input.subject ?? mem.subject,
          updatedAt: new Date().toISOString(),
        };
        await this.db.createMemory(updated);
        return updated;
      }
    }

    const now = new Date().toISOString();
    const record: StoredMemoryRecord = {
      confidence: Math.max(0.1, Math.min(1.0, input.confidence ?? 1.0)),
      content: cleanContent,
      createdAt: now,
      id: nanoid(16),
      importance: Math.max(1, Math.min(5, input.importance ?? 1)),
      orgId,
      ownerId: input.ownerId,
      scope: input.scope,
      source: input.source ?? null,
      subject: input.subject?.trim() ?? null,
      updatedAt: now,
    };

    if (options.strategy === "preserve") {
      return this.db.createOrGetMemory(record);
    }
    await this.db.createMemory(record);
    return record;
  }

  async searchMemories(
    orgId: string,
    query: string,
    options: SearchMemoryOptions = {}
  ): Promise<StoredMemoryRecord[]> {
    if (!orgId?.trim()) {
      throw new Error("orgId is required for memory operations.");
    }

    const cleanQuery = query.trim();
    const limit = memoryResultLimit(options.limit, 20);
    if (limit === 0) {
      return [];
    }
    if (!cleanQuery) {
      return this.listMemories(orgId, options);
    }

    const terms = tokenizeMemoryQuery(cleanQuery);
    if (terms.length === 0) {
      return [];
    }
    const candidateLimit = memoryResultLimit(Math.max(limit * 8, 40), 200);
    const records = await this.db.searchMemories(
      orgId,
      terms,
      options.scope,
      options.ownerId,
      candidateLimit
    );
    const archive = await this.loadArchiveRecords(orgId, options);
    return searchRankedMemories(
      mergeMemoryRecords([...records, ...archive]),
      cleanQuery,
      { limit }
    );
  }

  async listMemories(
    orgId: string,
    options: SearchMemoryOptions = {}
  ): Promise<StoredMemoryRecord[]> {
    return this.db.listMemories(
      orgId,
      options.scope,
      options.ownerId,
      memoryResultLimit(options.limit, 50)
    );
  }

  async listVisibleMemories(
    orgId: string,
    visibility: {
      limit?: number;
      profileId?: string | null;
      userId?: string | null;
    }
  ): Promise<StoredMemoryRecord[]> {
    const limit = memoryResultLimit(visibility.limit, 10);
    if (limit === 0) {
      return [];
    }
    const buckets = await Promise.all([
      this.listMemories(orgId, {
        limit,
        ownerId: orgId,
        scope: "organization",
      }),
      visibility.profileId
        ? this.listMemories(orgId, {
            limit,
            ownerId: visibility.profileId,
            scope: "agent",
          })
        : Promise.resolve([]),
      visibility.userId
        ? this.listMemories(orgId, {
            limit,
            ownerId: visibility.userId,
            scope: "user",
          })
        : Promise.resolve([]),
    ]);
    const seen = new Set<string>();
    const merged: StoredMemoryRecord[] = [];
    for (const record of buckets.flat()) {
      if (seen.has(record.id)) {
        continue;
      }
      seen.add(record.id);
      merged.push(record);
    }
    merged.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return merged.slice(0, limit);
  }

  async searchVisibleMemories(
    orgId: string,
    query: string,
    visibility: {
      limit?: number;
      profileId?: string | null;
      userId?: string | null;
    }
  ): Promise<StoredMemoryRecord[]> {
    const limit = memoryResultLimit(visibility.limit, 10);
    if (limit === 0) {
      return [];
    }
    if (!query.trim()) {
      return this.listVisibleMemories(orgId, { ...visibility, limit });
    }
    const buckets = await Promise.all([
      this.searchMemories(orgId, query, {
        limit,
        ownerId: orgId,
        scope: "organization",
      }),
      visibility.profileId
        ? this.searchMemories(orgId, query, {
            limit,
            ownerId: visibility.profileId,
            profileId: visibility.profileId,
            scope: "agent",
          })
        : Promise.resolve([]),
      visibility.userId
        ? this.searchMemories(orgId, query, {
            limit,
            ownerId: visibility.userId,
            scope: "user",
          })
        : Promise.resolve([]),
    ]);
    const seen = new Set<string>();
    const merged: StoredMemoryRecord[] = [];
    for (const record of buckets.flat()) {
      if (seen.has(record.id)) {
        continue;
      }
      seen.add(record.id);
      merged.push(record);
    }
    return searchRankedMemories(merged, query, { limit });
  }

  async getMemory(
    orgId: string,
    id: string
  ): Promise<StoredMemoryRecord | null> {
    return this.db.getMemory(orgId, id);
  }

  async updateMemory(
    orgId: string,
    id: string,
    patch: {
      confidence?: number;
      content?: string;
      importance?: number;
      subject?: string | null;
    }
  ): Promise<StoredMemoryRecord | null> {
    if (patch.content) {
      this.sanitizeAndValidate(patch.content);
    }
    await this.db.updateMemory(orgId, id, patch);
    return this.db.getMemory(orgId, id);
  }

  async deleteMemory(orgId: string, id: string): Promise<boolean> {
    return this.db.deleteMemory(orgId, id);
  }

  private async loadArchiveRecords(
    orgId: string,
    options: SearchMemoryOptions
  ): Promise<StoredMemoryRecord[]> {
    if (
      this.options.indexProfileArchive === false ||
      options.indexProfileArchive === false
    ) {
      return [];
    }
    if (options.scope && options.scope !== "agent") {
      return [];
    }
    const profileId =
      options.profileId?.trim() ||
      (options.scope === "agent" ? options.ownerId?.trim() : "");
    if (!profileId) {
      return [];
    }
    try {
      const facts = await loadProfileMemoryArchiveFacts(orgId, profileId);
      return facts.map((fact) =>
        archiveFactToStoredMemory(fact, orgId, profileId)
      );
    } catch {
      return [];
    }
  }
}
