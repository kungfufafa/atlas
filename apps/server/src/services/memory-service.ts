import { nanoid } from "@atlas/core";
import { calculateTitleSimilarity } from "@atlas/core/tools/url-utils";
import type {
  DatabaseAdapter,
  MemoryScope,
  StoredMemoryRecord,
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
  limit?: number;
  ownerId?: string;
  scope?: MemoryScope;
}

export class MemoryService {
  constructor(private readonly db: DatabaseAdapter) {}

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
    input: WriteMemoryInput
  ): Promise<StoredMemoryRecord> {
    if (!orgId?.trim()) {
      throw new Error("orgId is required for memory operations.");
    }
    const cleanContent = input.content.trim();
    if (!cleanContent) {
      throw new Error("Memory content cannot be empty.");
    }

    this.sanitizeAndValidate(cleanContent);

    const existingMemories = await this.db.listMemories(
      orgId,
      input.scope,
      input.ownerId,
      50
    );

    // Deduplication check
    for (const mem of existingMemories) {
      const similarity = calculateTitleSimilarity(mem.content, cleanContent);
      const sameSubject =
        input.subject &&
        mem.subject &&
        input.subject.toLowerCase() === mem.subject.toLowerCase();

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
    if (!cleanQuery) {
      return this.listMemories(orgId, options);
    }

    const records = await this.db.searchMemories(
      orgId,
      cleanQuery,
      options.scope,
      options.ownerId,
      options.limit ?? 20
    );

    // Rank by scope priority + importance + recency
    const scopeWeights: Record<MemoryScope, number> = {
      agent: 1,
      organization: 2,
      project: 3,
      user: 4,
    };

    return records.sort((a, b) => {
      const scoreA =
        (scopeWeights[a.scope] || 1) * 2 +
        a.importance * 1.5 +
        (a.confidence || 1.0) * 1.2;
      const scoreB =
        (scopeWeights[b.scope] || 1) * 2 +
        b.importance * 1.5 +
        (b.confidence || 1.0) * 1.2;
      return scoreB - scoreA;
    });
  }

  async listMemories(
    orgId: string,
    options: SearchMemoryOptions = {}
  ): Promise<StoredMemoryRecord[]> {
    return this.db.listMemories(
      orgId,
      options.scope,
      options.ownerId,
      options.limit ?? 50
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
    const limit = visibility.limit ?? 10;
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
    const limit = visibility.limit ?? 10;
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
    return merged.slice(0, limit);
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
      subject?: string;
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
}
