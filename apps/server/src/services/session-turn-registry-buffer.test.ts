import { expect, test } from "bun:test";
import type { StreamEvent } from "@atlas/core";
import { SessionTurnRegistry } from "./session-turn-registry";

const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_BUFFER_EVENTS = 10_000;

async function runIsolatedProbe(body: string): Promise<{
  active: boolean;
  bytes: number;
  latestSnapshot: string[];
  liveLengths: number[];
  payloadsIntact: boolean;
  replayIndexes: string[];
  replayLengths: number[];
  terminals: number;
}> {
  const modulePath = new URL("./session-turn-registry.ts", import.meta.url)
    .href;
  const source = `
    import { SessionTurnRegistry } from ${JSON.stringify(modulePath)};
    const registry = new SessionTurnRegistry();
    registry.beginTurn("buffer");
    ${body}
  `;
  const child = Bun.spawn([process.execPath, "--eval", source], {
    stderr: "pipe",
    stdout: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 5000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exitCode, stderr, timedOut }).toEqual({
      exitCode: 0,
      stderr: "",
      timedOut: false,
    });
    return JSON.parse(stdout);
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}

for (const { label, repeats, unit } of [
  { label: "ASCII", repeats: 2 * 1024 * 1024, unit: "x" },
  { label: "Unicode", repeats: 400_000, unit: "🙂" },
]) {
  test(`bounds cumulative ${label} replay bytes without blocking live delivery or termination`, async () => {
    const result = await runIsolatedProbe(`
        const liveLengths = [];
        const originals = [];
        let payloadsIntact = true;
        let terminals = 0;
        registry.subscribe("buffer", (event) => {
          if (event.type === "chunk") {
            liveLengths.push(event.delta.length);
            payloadsIntact &&= event.delta === originals.at(-1);
          }
          if (event.type === "done") terminals++;
        });
        registry.publish("buffer", {
          type: "tool_input_delta", tool: "write_file", toolCallId: "call_1",
          delta: "old", accumulatedArguments: "old"
        });
        registry.publish("buffer", {
          type: "tool_input_delta", tool: "write_file", toolCallId: "call_1",
          delta: "new", accumulatedArguments: "new"
        });
        for (let index = 0; index < 3; index++) {
          originals.push(${JSON.stringify(unit)}.repeat(${repeats}) + index);
          registry.publish("buffer", { type: "chunk", delta: originals.at(-1) });
        }
        const replay = [];
        registry.subscribe("buffer", (event) => replay.push(event));
        const bytes = replay.reduce((sum, event) =>
          sum + Buffer.byteLength(JSON.stringify(event), "utf8"), 0);
        const replayLengths = replay.filter(event => event.type === "chunk")
          .map(event => event.delta.length);
        const replayIndexes = replay.filter(event => event.type === "chunk")
          .map(event => event.delta.slice(-1));
        payloadsIntact &&= replay.filter(event => event.type === "chunk")
          .every(event => originals.includes(event.delta));
        const latestSnapshot = replay.filter(event => event.type === "tool_input_delta")
          .map(event => event.accumulatedArguments);
        registry.endTurn("buffer", {type: "done", reply: "completed"});
        registry.endTurn("buffer", {type: "done", reply: "duplicate"});
        console.log(JSON.stringify({active: registry.isActive("buffer"),
          bytes, liveLengths, replayLengths, latestSnapshot, payloadsIntact, replayIndexes, terminals}));
      `);
    expect(result.bytes).toBeLessThanOrEqual(MAX_BUFFER_BYTES);
    expect(result.liveLengths).toEqual(
      Array(3).fill(unit.length * repeats + 1)
    );
    expect(result.replayLengths).toEqual(
      Array(label === "ASCII" ? 1 : 2).fill(unit.length * repeats + 1)
    );
    expect(result.replayIndexes).toEqual(
      label === "ASCII" ? ["2"] : ["1", "2"]
    );
    expect(result.payloadsIntact).toBe(true);
    expect(result.latestSnapshot).toEqual(["new"]);
    expect(result.terminals).toBe(1);
    expect(result.active).toBe(false);
  }, 10_000);
}

function collectReplay(registry: SessionTurnRegistry): StreamEvent[] {
  const replay: StreamEvent[] = [];
  const subscription = registry.subscribe("buffer", (event) =>
    replay.push(event)
  );
  subscription?.unsubscribe();
  return replay;
}

test("replacing a snapshot preserves the chronology of unrelated replay events", () => {
  const registry = new SessionTurnRegistry();
  registry.beginTurn("buffer");
  const snapshot = (value: string): StreamEvent => ({
    accumulatedArguments: value,
    delta: value,
    tool: "write_file",
    toolCallId: "call_1",
    type: "tool_input_delta",
  });
  const first: StreamEvent = { delta: "first", type: "chunk" };
  const start: StreamEvent = {
    input: {},
    tool: "read_file",
    toolCallId: "call_2",
    type: "tool_start",
  };
  const second: StreamEvent = { delta: "second", type: "chunk" };
  for (const event of [
    snapshot("old"),
    first,
    start,
    second,
    snapshot("new"),
  ]) {
    registry.publish("buffer", event);
  }
  expect(collectReplay(registry)).toEqual([
    first,
    start,
    second,
    snapshot("new"),
  ]);
});

test("oversized replacement snapshots invalidate old replay without changing live payloads", () => {
  const registry = new SessionTurnRegistry();
  registry.beginTurn("buffer");
  const old: StreamEvent = { todos: [], type: "todos_updated" };
  registry.publish("buffer", old);
  const live: StreamEvent[] = [];
  registry.subscribe("buffer", (event) => live.push(event));
  const oversized: StreamEvent = {
    todos: [
      { content: "x".repeat(MAX_BUFFER_BYTES), id: "todo", status: "pending" },
    ],
    type: "todos_updated",
  };
  registry.publish("buffer", oversized);
  expect(collectReplay(registry)).toEqual([]);
  expect(live).toEqual([old, oversized]);
  registry.cancelTurn("buffer");
  expect(live.at(-1)?.type).toBe("error");
  expect(registry.isActive("buffer")).toBe(false);
});

test("oversized terminal completes existing and late subscribers exactly once", () => {
  const registry = new SessionTurnRegistry();
  registry.beginTurn("buffer");
  const live: StreamEvent[] = [];
  registry.subscribe("buffer", (event) => live.push(event));
  const terminal: StreamEvent = {
    reply: "x".repeat(MAX_BUFFER_BYTES),
    type: "done",
  };
  registry.publish("buffer", terminal);
  expect(collectReplay(registry)).toEqual([]);
  const late: StreamEvent[] = [];
  registry.subscribe("buffer", (event) => late.push(event));
  registry.endTurn("buffer", terminal);
  registry.endTurn("buffer", terminal);
  expect(live).toEqual([terminal]);
  expect(late).toEqual([terminal]);
  expect(registry.isActive("buffer")).toBe(false);
});

test("more snapshot keys than the event limit retain exactly the newest keys in order", () => {
  const registry = new SessionTurnRegistry();
  registry.beginTurn("buffer");
  for (let index = 0; index < MAX_BUFFER_EVENTS + 3; index++) {
    registry.publish("buffer", {
      accumulatedArguments: String(index),
      delta: String(index),
      tool: "write_file",
      toolCallId: `call_${index}`,
      type: "tool_input_delta",
    });
  }
  const replay = collectReplay(registry);
  expect(replay).toHaveLength(MAX_BUFFER_EVENTS);
  expect(
    replay.map((event) =>
      event.type === "tool_input_delta" ? event.accumulatedArguments : null
    )
  ).toEqual(
    Array.from({ length: MAX_BUFFER_EVENTS }, (_, index) => String(index + 3))
  );
  registry.publish("buffer", {
    accumulatedArguments: "revised",
    delta: "revised",
    tool: "write_file",
    toolCallId: "call_5",
    type: "tool_input_delta",
  });
  const replaced = collectReplay(registry);
  expect(replaced).toHaveLength(MAX_BUFFER_EVENTS);
  expect(replaced.at(-1)).toMatchObject({ accumulatedArguments: "revised" });
});
