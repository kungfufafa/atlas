import type { DocumentAttachment } from "@atlas/core/contract";
import {
  isKnowledgeBaseFilename,
  isSupportedKnowledgeBaseMediaType,
} from "@atlas/core/knowledge-base/formats";
import { parseDocumentDataUrl } from "@atlas/core/message-content";

export {
  KNOWLEDGE_BASE_ACCEPT,
  KNOWLEDGE_BASE_SUPPORTED_TYPE_LABEL,
} from "@atlas/core/knowledge-base/formats";

export function isKnowledgeBaseFile(file: File): boolean {
  const filename = file.name.trim();

  return (
    isKnowledgeBaseFilename(filename) ||
    isSupportedKnowledgeBaseMediaType(file.type, filename)
  );
}

export function fileToDocumentAttachment(
  file: File
): Promise<DocumentAttachment | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = typeof reader.result === "string" ? reader.result : null;
      if (!result) {
        resolve(null);
        return;
      }

      const filename = file.name.trim() || "document";
      resolve(parseDocumentDataUrl(result, filename));
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
