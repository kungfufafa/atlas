import { AtlasApiError } from "@atlas/core/api-error";
import type {
  KnowledgeBaseDuplicateAction,
  KnowledgeBaseDuplicateConflict,
} from "@atlas/core/contract";

export type KnowledgeBaseDuplicateDecision = "cancel" | "replace" | "skip";

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

export async function uploadKnowledgeBaseDocumentWithDuplicateResolution<T>(
  uploadedFilename: string,
  options: {
    decideDuplicate: (
      context: KnowledgeBaseDuplicateContext
    ) => Promise<KnowledgeBaseDuplicateDecision>;
    upload: (onDuplicate?: KnowledgeBaseDuplicateAction) => Promise<T>;
  }
): Promise<T | null> {
  let duplicate: KnowledgeBaseDuplicateConflict;

  try {
    return await options.upload();
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
    uploadedFilename,
  });
  if (decision !== "replace") {
    return null;
  }

  return options.upload("replace");
}
