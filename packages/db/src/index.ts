import { createInMemoryDatabaseAdapter } from "./adapters/in-memory";
import { createSqliteDatabase, type SqliteDatabase } from "./adapters/sqlite";
import {
  type ResolveDatabasePathOptions,
  resolveDatabasePath,
} from "./database-url";
import type { DatabaseAdapter } from "./types";

export { createInMemoryDatabaseAdapter } from "./adapters/in-memory";
export { createSqliteDatabase } from "./adapters/sqlite";
export { publicationSourceEvidenceFingerprint } from "./artifact-publication-evidence";
export {
  MAX_PUBLICATION_BYTES,
  MAX_PUBLICATION_OUTPUTS,
  publicationIdentity,
  validatePublicationPath,
} from "./artifact-publication-identity";
export * from "./automation-store";
export * from "./constants";
export {
  buildFtsChatYardstickDocuments,
  FTS_CHAT_DISTRACTOR_COUNT,
  FTS_CHAT_NEEDLE_CODE,
  FTS_CHAT_QUERY,
  FTS_CHAT_RESULT_LIMIT,
  ftsChatDistractorText,
  ftsChatNeedleText,
} from "./conversation-fts-yardstick";
export { ConversationKeywordSearch } from "./conversation-keyword-search";
export {
  queryConversationFts5Ranks,
  searchRankedConversations,
} from "./conversation-rank-fts5";
export type { ResolveDatabasePathOptions } from "./database-url";
export * from "./local-client";
export {
  queryMemoryFts5Hits,
  searchRankedMemories,
} from "./memory-rank-fts5";
export {
  collapseConflictingMemories,
  memoryConflictSlot,
  memoryMatchScore,
  memoryResultLimit,
  type RankableMemoryFact,
  rankMemoryMatches,
  tokenizeMemoryQuery,
} from "./memory-search";
export * from "./org-profiles";
export * from "./seed";
export {
  parseStoredChatKind,
  SESSION_CHAT_KINDS,
  type StoredSessionChatKind,
} from "./session-chat-kind";
export * from "./skill-rank-fts5";
export * from "./types";
export * from "./workspace-settings";

export interface Database {
  adapter: DatabaseAdapter;
  close(): void;
  /** Re-open the on-disk database after files under the data root were replaced. */
  reopen(): Promise<void>;
}

export async function createDatabase(
  databaseUrl: string,
  options: ResolveDatabasePathOptions = {}
): Promise<Database> {
  const databasePath = resolveDatabasePath(databaseUrl, options);

  if (databasePath === ":memory:") {
    return {
      adapter: createInMemoryDatabaseAdapter(),
      close() {},
      async reopen() {},
    };
  }

  return createSqliteDatabase(`file:${databasePath}`);
}

export type { SqliteDatabase };
