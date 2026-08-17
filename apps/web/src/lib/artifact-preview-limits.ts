/** Highlighting a very large file blocks the main thread. */
export const MAX_HIGHLIGHTED_CHARS = 200_000;

/** Streamdown + mermaid stay responsive below this. */
export const MAX_MARKDOWN_PREVIEW_CHARS = 400_000;

export const MAX_SVG_PREVIEW_CHARS = 500_000;

export const MAX_HTML_PREVIEW_CHARS = 1_500_000;

export const MAX_MERMAID_PREVIEW_CHARS = 200_000;

export function truncatePreviewText(
  content: string,
  maxChars: number
): { text: string; truncated: boolean } {
  if (content.length <= maxChars) {
    return { text: content, truncated: false };
  }

  return {
    text: content.slice(0, maxChars),
    truncated: true,
  };
}
