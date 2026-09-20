import { createHash } from "node:crypto";
import type { ChatMessage } from "../../packages/core/src/contract";
import { readOfficeZipParts } from "../../packages/core/src/office-document/archive";

export interface JourneyStreamEvent {
  type: string;
  [key: string]: unknown;
}

export interface JourneyTurnEvidence {
  events: JourneyStreamEvent[];
  messages: ChatMessage[];
  prompt: string;
  sessionId: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function userText(message: ChatMessage): string {
  if (message.role !== "user") {
    return "";
  }
  return typeof message.content === "string"
    ? message.content
    : message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
}

export function currentPersistedTurn(
  evidence: JourneyTurnEvidence
): ChatMessage[] {
  const start = evidence.messages.findLastIndex((message) =>
    userText(message).includes(evidence.prompt)
  );
  if (start < 0) {
    throw new Error(
      "The current browser request was not persisted in its session."
    );
  }
  const turn = evidence.messages.slice(start + 1);
  if (turn.some((message) => message.role === "user")) {
    throw new Error("A newer request replaced the journey's current turn.");
  }
  return turn;
}

export function requireCompletedReply(evidence: JourneyTurnEvidence): string {
  const terminal = evidence.events.filter((event) => event.type === "done");
  if (
    terminal.length !== 1 ||
    typeof terminal[0]?.reply !== "string" ||
    evidence.events.some((event) => event.type === "error")
  ) {
    throw new Error("The current turn did not complete successfully.");
  }
  const reply = terminal[0].reply;
  if (
    !currentPersistedTurn(evidence).some(
      (message) => message.role === "assistant" && message.content === reply
    )
  ) {
    throw new Error("The current assistant reply was not persisted.");
  }
  return reply;
}

export function requirePersistedTool(
  evidence: JourneyTurnEvidence,
  tool: string
): JourneyStreamEvent[] {
  const completed = evidence.events.filter((event) => {
    const result = record(event.result);
    return (
      event.type === "tool_end" &&
      event.tool === tool &&
      result &&
      !result.error &&
      result.success !== false
    );
  });
  if (completed.length === 0) {
    throw new Error(`The current turn has no successful ${tool} execution.`);
  }
  for (const event of completed) {
    requireToolReceipt(evidence, event);
  }
  return completed;
}

function requireToolReceipt(
  evidence: JourneyTurnEvidence,
  event: JourneyStreamEvent
): JourneyStreamEvent {
  if (
    typeof event.toolCallId !== "string" ||
    !event.toolCallId.trim() ||
    typeof event.tool !== "string" ||
    !event.tool.trim()
  ) {
    throw new Error("Tool receipt lacks an explicit execution identity.");
  }
  const start = evidence.events.find(
    (item) =>
      item.type === "tool_start" &&
      item.tool === event.tool &&
      item.toolCallId === event.toolCallId
  );
  const persisted = currentPersistedTurn(evidence).some(
    (message) =>
      message.role === "tool" &&
      message.name === event.tool &&
      message.toolCallId === event.toolCallId &&
      JSON.stringify(JSON.parse(message.content)) ===
        JSON.stringify(event.result)
  );
  if (!(start && persisted)) {
    throw new Error(
      `${event.tool} execution lacks matching start or persisted result.`
    );
  }
  return start;
}

export function requireMemoryRoundTrip(
  saved: JourneyTurnEvidence,
  recalled: JourneyTurnEvidence,
  runId: string
): void {
  if (saved.sessionId === recalled.sessionId) {
    throw new Error("Durable memory must be retrieved in a new session.");
  }
  const write = requirePersistedTool(saved, "memory_write")[0]!;
  const savedId = record(write.result)?.id;
  const input = record(requireToolReceipt(saved, write).input);
  if (
    typeof savedId !== "string" ||
    typeof input?.content !== "string" ||
    !input.content.includes(runId)
  ) {
    throw new Error("Memory write lacks this run's persisted record identity.");
  }
  const searches = requirePersistedTool(recalled, "memory_search");
  if (
    !(
      searches.some((event) => {
        const memories = record(event.result)?.memories;
        return (
          Array.isArray(memories) &&
          memories.some((item) => {
            const memory = record(item);
            return memory?.id === savedId && memory.content === input.content;
          })
        );
      }) && requireCompletedReply(recalled).includes(input.content)
    )
  ) {
    throw new Error(
      "New-session retrieval did not return the saved memory and content."
    );
  }
}

export function requireHistoryRetrieval(
  seeded: JourneyTurnEvidence,
  recalled: JourneyTurnEvidence,
  fact: string
): void {
  requireCompletedReply(seeded);
  if (
    seeded.sessionId === recalled.sessionId ||
    !seeded.prompt.includes(fact)
  ) {
    throw new Error(
      "History fixture must be persisted in a different session."
    );
  }
  const searches = requirePersistedTool(recalled, "search_chats");
  if (
    !(
      searches.some((event) => {
        const results = record(event.result)?.results;
        return (
          Array.isArray(results) &&
          results.some((item) => {
            const result = record(item);
            return (
              result?.sessionId === seeded.sessionId &&
              result.role === "user" &&
              typeof result.matchedSnippet === "string" &&
              result.matchedSnippet.includes(fact)
            );
          })
        );
      }) && requireCompletedReply(recalled).includes(fact)
    )
  ) {
    throw new Error(
      "Chat search did not retrieve the persisted source-session fact."
    );
  }
}

export function requireFetchRecovery(
  evidence: JourneyTurnEvidence,
  urls: { failure: string; success: string },
  runId: string
): void {
  const failure = evidence.events.find(
    (event) =>
      event.type === "tool_end" &&
      event.tool === "web_fetch" &&
      typeof record(event.result)?.error === "string" &&
      String(record(event.result)?.error).includes("HTTP 503")
  );
  if (
    !failure ||
    record(requireToolReceipt(evidence, failure).input)?.url !== urls.failure
  ) {
    throw new Error("Recovery lacks the persisted failed first fetch.");
  }
  const success = requirePersistedTool(evidence, "web_fetch").find((event) => {
    const result = record(event.result);
    return (
      result?.status === 200 &&
      result.url === urls.success &&
      typeof result.content === "string" &&
      result.content.includes(runId)
    );
  });
  if (!success) {
    throw new Error(
      "Recovery lacks the persisted successful alternative fetch."
    );
  }
  const start = requireToolReceipt(evidence, success);
  const content = String(record(success.result)?.content);
  if (
    record(start.input)?.url !== urls.success ||
    evidence.events.indexOf(start) <= evidence.events.indexOf(failure) ||
    !requireCompletedReply(evidence).includes(content)
  ) {
    throw new Error(
      "Recovery did not continue from the failed fetch to the successful result."
    );
  }
}

export function requireCurrentArtifact(
  evidence: JourneyTurnEvidence,
  options: { extension: string; runId: string; tool: string }
): { filename: string; path: string } {
  const completed = requirePersistedTool(evidence, options.tool);
  const artifacts = evidence.events
    .filter((event) => event.type === "artifact_created")
    .map((event) => record(event.artifact))
    .filter(
      (artifact) =>
        artifact &&
        typeof artifact.filename === "string" &&
        artifact.filename.includes(options.runId) &&
        artifact.filename.endsWith(options.extension)
    );
  if (artifacts.length !== 1) {
    throw new Error(
      "Expected one newly emitted artifact for this run and format."
    );
  }
  const artifact = artifacts[0]!;
  if (
    typeof artifact.path !== "string" ||
    typeof artifact.filename !== "string" ||
    (artifact.sessionId !== undefined &&
      artifact.sessionId !== evidence.sessionId) ||
    !completed.some((event) => {
      const result = record(event.result);
      return (
        result?.path === artifact.path ||
        (Array.isArray(result?.artifacts) &&
          result.artifacts.some((item) => record(item)?.path === artifact.path))
      );
    })
  ) {
    throw new Error(
      "Artifact is not bound to the current session's executed output."
    );
  }
  return { filename: artifact.filename, path: artifact.path };
}

export function verifyOfficeContent(
  bytes: Uint8Array,
  options: { expected: string[]; forbidden?: string[]; slideCount?: number },
  previous?: Uint8Array
): void {
  if (previous && Buffer.from(previous).equals(Buffer.from(bytes))) {
    throw new Error("Revision returned unchanged artifact bytes.");
  }
  const parts = readOfficeZipParts(bytes);
  const content = Object.entries(parts)
    .filter(
      ([name]) =>
        /^ppt\/slides\/slide\d+\.xml$/.test(name) ||
        /^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/.test(name)
    )
    .map(([, value]) => new TextDecoder().decode(value))
    .join("\n");
  for (const token of options.expected) {
    if (!content.includes(token)) {
      throw new Error(`Downloaded Office content is missing ${token}.`);
    }
  }
  for (const token of options.forbidden ?? []) {
    if (content.includes(token)) {
      throw new Error(`Downloaded revision still contains ${token}.`);
    }
  }
  if (
    options.slideCount !== undefined &&
    Object.keys(parts).filter((name) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(name)
    ).length !== options.slideCount
  ) {
    throw new Error("Downloaded presentation has the wrong slide count.");
  }
}

export function requireAcceptedCancellation(
  request: unknown,
  response: unknown,
  activeTurnId: string
): void {
  if (
    record(request)?.expectedTurnId !== activeTurnId ||
    record(response)?.cancelled !== true
  ) {
    throw new Error("The active turn was not actually cancelled by the UI.");
  }
}

export function requireUploadedDocument(
  evidence: JourneyTurnEvidence,
  filename: string
): string {
  const message = evidence.messages.findLast((item) =>
    userText(item).includes(evidence.prompt)
  );
  const attachment =
    message?.role === "user" && Array.isArray(message.content)
      ? message.content.find(
          (part) => part.type === "document_ref" && part.filename === filename
        )
      : undefined;
  if (attachment?.type !== "document_ref") {
    throw new Error(
      "The uploaded Office file was not persisted as an attachment."
    );
  }
  requirePersistedTool(evidence, "office_document");
  return attachment.attachmentId;
}

export function requireCancelledStream(
  failure: string | null,
  status: unknown,
  activeTurnId: string
): void {
  const stopped = record(status);
  if (
    !(failure && /abort/i.test(failure)) ||
    stopped?.active !== false ||
    (stopped.turnId !== undefined && stopped.turnId !== activeTurnId)
  ) {
    throw new Error(
      "The active stream was not aborted and released by the UI."
    );
  }
}

export function artifactDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
