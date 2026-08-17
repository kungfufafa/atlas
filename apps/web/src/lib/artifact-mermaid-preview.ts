import { isMermaidArtifactFilename } from "@atlas/core/artifact-mime";
import { MAX_MERMAID_PREVIEW_CHARS } from "@/lib/artifact-preview-limits";

export { isMermaidArtifactFilename };

export function markdownForMermaidSource(source: string): string {
  const body = source.trim();
  if (/^```mermaid\b/i.test(body)) {
    return body;
  }

  return `\`\`\`mermaid\n${body}\n\`\`\``;
}

export function mermaidPreviewError(source: string): string | null {
  if (source.length > MAX_MERMAID_PREVIEW_CHARS) {
    return "This diagram is too large to preview.";
  }

  if (!source.trim()) {
    return "This diagram is empty.";
  }

  return null;
}
