import { AtlasApiError } from "@atlas/core/api-error";
import type {
  DocumentAttachment,
  KnowledgeBaseDuplicateAction,
  KnowledgeBaseDuplicateConflict,
} from "@atlas/core/contract";

export type KnowledgeBaseDuplicateDecision = "cancel" | "replace" | "skip";

export type PreparedKnowledgeBaseUpload = {
  document: DocumentAttachment;
  filename: string;
};

export type KnowledgeBaseDuplicateContext = KnowledgeBaseDuplicateConflict & {
  uploadedFilename: string;
};

export function formatKnowledgeBaseDuplicatePrompt(
  context: KnowledgeBaseDuplicateContext
): string {
  if (context.existingFilename === context.uploadedFilename) {
    return `Replace existing document “${context.existingFilename}” with this upload, or skip it?`;
  }

  return `The uploaded file “${context.uploadedFilename}” matches existing document “${context.existingFilename}”. Replace it, or skip it?`;
}

export async function uploadPreparedKnowledgeBaseDocuments(
  items: PreparedKnowledgeBaseUpload[],
  options: {
    decideDuplicate: (
      context: KnowledgeBaseDuplicateContext
    ) => Promise<KnowledgeBaseDuplicateDecision>;
    upload: (
      item: PreparedKnowledgeBaseUpload,
      onDuplicate?: KnowledgeBaseDuplicateAction
    ) => Promise<unknown>;
    isCancelled?: () => boolean;
  }
): Promise<void> {
  for (const item of items) {
    if (options.isCancelled?.()) {
      return;
    }

    let duplicate: KnowledgeBaseDuplicateConflict;
    try {
      await options.upload(item);
      continue;
    } catch (error) {
      if (
        !(error instanceof AtlasApiError) ||
        error.status !== 409 ||
        !error.knowledgeBaseDuplicate
      ) {
        throw error;
      }
      duplicate = error.knowledgeBaseDuplicate;
    }

    const decision = await options.decideDuplicate({
      ...duplicate,
      uploadedFilename: item.filename,
    });
    if (decision === "cancel") {
      return;
    }
    if (decision === "skip") {
      continue;
    }
    if (options.isCancelled?.()) {
      return;
    }

    await options.upload(item, "replace");
  }
}
