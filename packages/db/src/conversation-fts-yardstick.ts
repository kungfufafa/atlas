/** Cross-session fact lexical ranking misses inside the result limit. */
export const FTS_CHAT_NEEDLE_CODE = "ZEPHYRIC-LOCKER-77";
export const FTS_CHAT_QUERY =
  "What is the zephyric cipher locker code we discussed?";
export const FTS_CHAT_DISTRACTOR_COUNT = 80;
export const FTS_CHAT_RESULT_LIMIT = 10;

export function ftsChatNeedleText(): string {
  return `Zephyric cipher locker retrieval code: ${FTS_CHAT_NEEDLE_CODE}.`;
}

export function ftsChatDistractorText(index: number): string {
  return `Weekly ops log ${index}: the team discussed backup windows, on-call swaps, and vendor intake. They reviewed the zephyric cipher locker code checklist during the morning stand-up, then moved on to badge printers, tape rotations, spare keys, warehouse bins, stakeholder status copy, and the usual closing notes. No retrieval code was recorded in this log.`;
}

export function buildFtsChatYardstickDocuments(): Array<{
  createdAt: string;
  messageId: string;
  text: string;
}> {
  const documents = [
    {
      createdAt: "2026-01-01T00:00:00.000Z",
      messageId: "fts-needle",
      text: ftsChatNeedleText(),
    },
  ];
  for (let index = 0; index < FTS_CHAT_DISTRACTOR_COUNT; index += 1) {
    documents.push({
      createdAt: "2026-09-01T00:00:00.000Z",
      messageId: `fts-distractor-${index}`,
      text: ftsChatDistractorText(index),
    });
  }
  return documents;
}
