import { describe, expect, test } from "bun:test";
import { createPptxBuffer } from "../../packages/core/src/presentation-engine";
import {
  type JourneyTurnEvidence,
  requireAcceptedCancellation,
  requireCancelledStream,
  requireCompletedReply,
  requireCurrentArtifact,
  requireFetchRecovery,
  requireHistoryRetrieval,
  requireMemoryRoundTrip,
  requireUploadedDocument,
  verifyOfficeContent,
} from "./golden-journey-evidence";

function evidence(): JourneyTurnEvidence {
  const path = "artifacts/gate-current-run-deck.pptx";
  const result = { bytesWritten: 100, path };
  return {
    events: [
      { tool: "write_pptx", toolCallId: "current-call", type: "tool_start" },
      {
        result,
        tool: "write_pptx",
        toolCallId: "current-call",
        type: "tool_end",
      },
      {
        artifact: {
          filename: "gate-current-run-deck.pptx",
          path,
          sessionId: "current-session",
        },
        type: "artifact_created",
      },
      { reply: "Saved the deck.", type: "done" },
    ],
    messages: [
      { content: "Make a deck. current-run", role: "user" },
      {
        content: JSON.stringify(result),
        name: "write_pptx",
        role: "tool",
        toolCallId: "current-call",
      },
      { content: "Saved the deck.", role: "assistant" },
    ],
    prompt: "Make a deck. current-run",
    sessionId: "current-session",
  };
}

const artifactOptions = {
  extension: ".pptx",
  runId: "current-run",
  tool: "write_pptx",
};

function toolEvidence(
  tool: string,
  input: Record<string, unknown>,
  result: Record<string, unknown>,
  reply: string,
  sessionId = "retrieval-session"
): JourneyTurnEvidence {
  return {
    events: [
      { input, tool, toolCallId: "call", type: "tool_start" },
      { result, tool, toolCallId: "call", type: "tool_end" },
      { reply, type: "done" },
    ],
    messages: [
      { content: "current prompt", role: "user" },
      {
        content: JSON.stringify(result),
        name: tool,
        role: "tool",
        toolCallId: "call",
      },
      { content: reply, role: "assistant" },
    ],
    prompt: "current prompt",
    sessionId,
  };
}

test("cross-session memory requires the actual saved record and retrieval tool", () => {
  const content = "Concise preference current-run";
  const saved = toolEvidence(
    "memory_write",
    { content },
    { id: "saved-id" },
    "Saved",
    "source-session"
  );
  const recalled = () =>
    toolEvidence(
      "memory_search",
      { query: "current-run" },
      {
        memories: [{ content, id: "saved-id" }],
      },
      content
    );
  expect(() =>
    requireMemoryRoundTrip(saved, recalled(), "current-run")
  ).not.toThrow();
  for (const mutation of [
    (turn: JourneyTurnEvidence) => {
      turn.events = [];
    },
    (turn: JourneyTurnEvidence) => {
      turn.sessionId = saved.sessionId;
    },
    (turn: JourneyTurnEvidence) => {
      const result = { memories: [{ content, id: "other-id" }] };
      turn.events[1]!.result = result;
      turn.messages[1]!.content = JSON.stringify(result);
    },
    (turn: JourneyTurnEvidence) => {
      const result = { memories: [] };
      turn.events[1]!.result = result;
      turn.messages[1]!.content = JSON.stringify(result);
    },
  ]) {
    const turn = recalled();
    mutation(turn);
    expect(() => requireMemoryRoundTrip(saved, turn, "current-run")).toThrow();
  }
});

test("history cannot pass on an invented date, empty results or another source session", () => {
  const fact = "Apollo current-run launches October 12.";
  const seeded: JourneyTurnEvidence = {
    events: [{ reply: "Recorded", type: "done" }],
    messages: [
      { content: fact, role: "user" },
      { content: "Recorded", role: "assistant" },
    ],
    prompt: fact,
    sessionId: "source-session",
  };
  const recalled = (results: unknown[]) =>
    toolEvidence(
      "search_chats",
      { query: "Apollo current-run" },
      { results },
      fact
    );
  const source = {
    matchedSnippet: fact,
    role: "user",
    sessionId: seeded.sessionId,
  };
  expect(() =>
    requireHistoryRetrieval(seeded, recalled([source]), fact)
  ).not.toThrow();
  expect(() => requireHistoryRetrieval(seeded, recalled([]), fact)).toThrow();
  expect(() =>
    requireHistoryRetrieval(
      seeded,
      recalled([{ ...source, sessionId: "other" }]),
      fact
    )
  ).toThrow();
  const missing = recalled([source]);
  missing.events = [];
  expect(() => requireHistoryRetrieval(seeded, missing, fact)).toThrow();
});

test("fetch recovery requires both executed persisted results in order before reply", () => {
  const urls = {
    failure: "https://broken.test/current-run",
    success: "https://alternative.test/current-run",
  };
  const recovered = () => {
    const turn = toolEvidence(
      "web_fetch",
      { url: urls.success },
      {
        content: "Recovered current-run",
        status: 200,
        url: urls.success,
      },
      "Recovered current-run"
    );
    const failure = {
      error: "web_fetch failed: HTTP 503 Service Unavailable.",
    };
    turn.events.unshift(
      {
        input: { url: urls.failure },
        tool: "web_fetch",
        toolCallId: "failed-call",
        type: "tool_start",
      },
      {
        result: failure,
        tool: "web_fetch",
        toolCallId: "failed-call",
        type: "tool_end",
      }
    );
    turn.messages.splice(1, 0, {
      content: JSON.stringify(failure),
      name: "web_fetch",
      role: "tool",
      toolCallId: "failed-call",
    });
    return turn;
  };
  expect(() =>
    requireFetchRecovery(recovered(), urls, "current-run")
  ).not.toThrow();
  for (const mutation of [
    (turn: JourneyTurnEvidence) => {
      turn.events.splice(0, 2);
    },
    (turn: JourneyTurnEvidence) => {
      turn.events.splice(2, 2);
    },
    (turn: JourneyTurnEvidence) => {
      turn.messages.splice(1, 1);
    },
    (turn: JourneyTurnEvidence) => {
      turn.events.push(...turn.events.splice(0, 2));
    },
    (turn: JourneyTurnEvidence) => {
      turn.events[2]!.input = { url: "https://unrelated.test" };
    },
  ]) {
    const turn = recovered();
    mutation(turn);
    expect(() => requireFetchRecovery(turn, urls, "current-run")).toThrow();
  }
});

describe("golden journey current-turn evidence", () => {
  test("accepts a matching current receipt, persisted result and artifact", () => {
    expect(requireCompletedReply(evidence())).toBe("Saved the deck.");
    expect(requireCurrentArtifact(evidence(), artifactOptions).path).toEndWith(
      "deck.pptx"
    );
  });

  test("an assistant filename claim without an executed tool cannot pass", () => {
    const turn = evidence();
    turn.events = turn.events.filter((event) => event.type !== "tool_end");
    expect(() => requireCurrentArtifact(turn, artifactOptions)).toThrow(
      "no successful"
    );
  });

  test("missing or empty call IDs cannot bind matching receipts", () => {
    for (const toolCallId of [undefined, "", " "]) {
      const turn = evidence();
      turn.events[0]!.toolCallId = toolCallId;
      turn.events[1]!.toolCallId = toolCallId;
      turn.messages[1] = {
        content: JSON.stringify(turn.events[1]!.result),
        name: "write_pptx",
        role: "tool",
        toolCallId: toolCallId as string,
      };
      expect(() => requireCurrentArtifact(turn, artifactOptions)).toThrow(
        "execution identity"
      );
    }
  });

  test("an actual tool result without a newly emitted artifact cannot pass", () => {
    const turn = evidence();
    turn.events = turn.events.filter(
      (event) => event.type !== "artifact_created"
    );
    expect(() => requireCurrentArtifact(turn, artifactOptions)).toThrow(
      "newly emitted"
    );
  });

  test("old transcript replies do not satisfy a new follow-up", () => {
    const turn = evidence();
    turn.messages.push({
      content: "Revise the deck. current-run",
      role: "user",
    });
    turn.prompt = "Revise the deck. current-run";
    expect(() => requireCompletedReply(turn)).toThrow("not persisted");
    expect(() => requireCurrentArtifact(turn, artifactOptions)).toThrow(
      "persisted result"
    );
  });

  test("a foreign session artifact or stale run filename cannot pass", () => {
    const turn = evidence();
    turn.events[2] = {
      artifact: {
        filename: "gate-current-run-deck.pptx",
        path: "artifacts/gate-current-run-deck.pptx",
        sessionId: "other-session",
      },
      type: "artifact_created",
    };
    expect(() => requireCurrentArtifact(turn, artifactOptions)).toThrow(
      "current session"
    );
    expect(() =>
      requireCurrentArtifact(evidence(), {
        ...artifactOptions,
        runId: "other-run",
      })
    ).toThrow("newly emitted");
  });

  test("failed tools, unmatched output and missing starts cannot pass", () => {
    for (const mutation of [
      (turn: JourneyTurnEvidence) => {
        turn.events[1] = {
          ...turn.events[1]!,
          result: { error: "write failed" },
        };
      },
      (turn: JourneyTurnEvidence) => {
        turn.messages[1] = {
          content: "{}",
          name: "write_pptx",
          role: "tool",
          toolCallId: "other-call",
        };
      },
      (turn: JourneyTurnEvidence) => {
        turn.events.shift();
      },
    ]) {
      const turn = evidence();
      mutation(turn);
      expect(() => requireCurrentArtifact(turn, artifactOptions)).toThrow();
    }
  });

  test("an upload control or filename alone is not an uploaded document", () => {
    expect(() => requireUploadedDocument(evidence(), "upload.pptx")).toThrow(
      "not persisted as an attachment"
    );
  });

  test("cancellation requires accepted cancellation of the same active turn", () => {
    expect(() =>
      requireAcceptedCancellation(
        { expectedTurnId: "turn" },
        { cancelled: true },
        "turn"
      )
    ).not.toThrow();
    expect(() =>
      requireAcceptedCancellation(
        { expectedTurnId: "turn" },
        { cancelled: false },
        "turn"
      )
    ).toThrow();
    expect(() =>
      requireAcceptedCancellation(
        { expectedTurnId: "old" },
        { cancelled: true },
        "turn"
      )
    ).toThrow();
    expect(() =>
      requireAcceptedCancellation(undefined, undefined, "turn")
    ).toThrow();
  });

  test("stream cancellation cannot pass on a completed turn or unrelated failure", () => {
    expect(() =>
      requireCancelledStream("net::ERR_ABORTED", { active: false }, "turn")
    ).not.toThrow();
    expect(() =>
      requireCancelledStream(null, { active: false }, "turn")
    ).toThrow();
    expect(() =>
      requireCancelledStream("net::ERR_FAILED", { active: false }, "turn")
    ).toThrow();
    expect(() =>
      requireCancelledStream("net::ERR_ABORTED", { active: true }, "turn")
    ).toThrow();
    expect(() =>
      requireCancelledStream(
        "net::ERR_ABORTED",
        { active: false, turnId: "other" },
        "turn"
      )
    ).toThrow();
  });
});

test("Office verification reads actual content and rejects stale, absent, or unchanged revision bytes", async () => {
  const before = await createPptxBuffer({
    slides: [{ layout: "title", title: "current-run before" }],
    themeColor: "3B82F6",
    title: "Fixture",
  });
  const after = await createPptxBuffer({
    slides: [{ layout: "title", title: "current-run revised" }],
    themeColor: "3B82F6",
    title: "Fixture",
  });
  expect(() =>
    verifyOfficeContent(
      after,
      {
        expected: ["current-run revised"],
        forbidden: ["before"],
        slideCount: 1,
      },
      before
    )
  ).not.toThrow();
  expect(() => verifyOfficeContent(before, { expected: ["revised"] })).toThrow(
    "missing"
  );
  expect(() =>
    verifyOfficeContent(after, { expected: ["revised"] }, after)
  ).toThrow("unchanged");
  expect(() =>
    verifyOfficeContent(Buffer.from("created deck.pptx"), {
      expected: ["deck"],
    })
  ).toThrow();
  expect(() =>
    verifyOfficeContent(after, { expected: ["revised"], slideCount: 4 })
  ).toThrow("slide count");
});
