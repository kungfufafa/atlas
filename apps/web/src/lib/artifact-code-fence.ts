/** Wrap source so Streamdown highlights it as a single fenced block. */
export function toCodeFence(content: string, language: string): string {
  const longestRun = Math.max(
    0,
    ...[...content.matchAll(/`+/g)].map((match) => match[0].length)
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${content}\n${fence}`;
}
