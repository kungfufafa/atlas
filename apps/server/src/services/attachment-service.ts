import { AsyncLocalStorage } from "node:async_hooks";
import type {
  AgentChannel,
  LoadAttachmentBytes,
  SaveInlineAttachment,
} from "@atlas/core";
import { createId } from "@atlas/core";
import {
  deleteAttachmentBytes,
  readAttachmentBytes,
  saveAttachmentBytes,
} from "@atlas/core/attachments/store";
import type { DatabaseAdapter, StoredAttachmentRecord } from "@atlas/db";

export interface AttachmentServiceContext {
  channel: AgentChannel;
  orgId: string;
  profileId: string;
  sessionId: string;
}

export interface TurnAttachmentSaver {
  beginTurn: () => string;
  commitTurn: (turnId: string) => void;
  rollbackTurn: (turnId: string) => Promise<void>;
  runTurn: <T>(turnId: string, operation: () => Promise<T>) => Promise<T>;
  save: SaveInlineAttachment;
}

export function createAttachmentSaver(
  db: DatabaseAdapter,
  context: AttachmentServiceContext
): SaveInlineAttachment {
  return async (input) => {
    const attachmentId = createId("att");
    const storagePath = await saveAttachmentBytes(
      context.orgId,
      context.profileId,
      attachmentId,
      input.bytes
    );
    const now = new Date().toISOString();
    const record: StoredAttachmentRecord = {
      channel: context.channel,
      createdAt: now,
      filename: input.filename ?? null,
      id: attachmentId,
      kind: input.kind,
      mediaType: input.mediaType,
      orgId: context.orgId,
      profileId: context.profileId,
      sessionId: context.sessionId,
      sizeBytes: input.bytes.byteLength,
      storagePath,
    };

    try {
      await db.insertAttachment(record);
    } catch (error) {
      await deleteAttachmentBytes(
        context.orgId,
        context.profileId,
        attachmentId
      );
      throw error;
    }

    return {
      attachmentId,
      size: input.bytes.byteLength,
    };
  };
}

export function createTurnAttachmentSaver(
  db: DatabaseAdapter,
  context: AttachmentServiceContext
): TurnAttachmentSaver {
  const saveAttachment = createAttachmentSaver(db, context);
  const activeTurns = new Map<string, Set<string>>();
  const turnContext = new AsyncLocalStorage<string>();

  return {
    beginTurn() {
      const turnId = createId("attachment_turn");
      activeTurns.set(turnId, new Set());
      return turnId;
    },
    commitTurn(turnId) {
      activeTurns.delete(turnId);
    },
    async rollbackTurn(turnId) {
      const attachmentIds = [...(activeTurns.get(turnId) ?? [])];
      activeTurns.delete(turnId);

      await Promise.allSettled(
        attachmentIds.flatMap((attachmentId) => [
          deleteAttachmentBytes(context.orgId, context.profileId, attachmentId),
          db.deleteAttachment(attachmentId),
        ])
      );
    },
    runTurn: (turnId, operation) => {
      if (!activeTurns.has(turnId)) {
        throw new Error("Attachment turn is no longer active.");
      }
      return turnContext.run(turnId, operation);
    },
    save: async (input) => {
      const turnId = turnContext.getStore();
      const createdAttachmentIds = turnId ? activeTurns.get(turnId) : undefined;

      if (!createdAttachmentIds) {
        throw new Error("Attachment save requires an active turn.");
      }

      const saved = await saveAttachment(input);
      createdAttachmentIds.add(saved.attachmentId);
      return saved;
    },
  };
}

export function createAttachmentLoader(
  db: DatabaseAdapter,
  context: Pick<AttachmentServiceContext, "orgId" | "profileId">
): LoadAttachmentBytes {
  return async (attachmentId) => {
    const record = await db.getAttachment(attachmentId);

    if (
      !record ||
      record.orgId !== context.orgId ||
      record.profileId !== context.profileId
    ) {
      return null;
    }

    const bytes = await readAttachmentBytes(
      context.orgId,
      context.profileId,
      attachmentId
    );

    if (!bytes) {
      return null;
    }

    return {
      bytes,
      filename: record.filename,
      mediaType: record.mediaType,
    };
  };
}
