import type { StreamEvent } from "@atlas/core";

const MAX_BUFFER_EVENTS = 10_000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_SUBSCRIBERS_PER_SESSION = 3;

export interface BeginTurnResult {
  started: boolean;
}

export interface TurnStatus {
  active: boolean;
  startedAt?: string;
}

type Subscriber = {
  push: (event: StreamEvent) => void;
  close: () => void;
  terminalDelivered: boolean;
};

type ActiveTurn = {
  abort: AbortController;
  attachedAborts: Set<AbortController>;
  orgId?: string;
  startedAt: string;
  events: StreamEvent[];
  bufferBytes: number;
  snapshotIndexes: Map<string, number>;
  subscribers: Set<Subscriber>;
};

function estimateEventBytes(event: StreamEvent): number {
  try {
    return Buffer.byteLength(JSON.stringify(event), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isTerminalEvent(event: StreamEvent): boolean {
  return event.type === "done" || event.type === "error";
}

function deliverEvent(subscriber: Subscriber, event: StreamEvent): void {
  if (isTerminalEvent(event)) {
    if (subscriber.terminalDelivered) {
      return;
    }
    subscriber.terminalDelivered = true;
  }
  subscriber.push(event);
}

function snapshotKey(event: StreamEvent): string | null {
  switch (event.type) {
    case "chunk":
    case "thinking":
      return `leg:${event.type}`;
    case "tool_input_delta":
      return `tool_input:${event.toolCallId}`;
    case "todos_updated":
      return "todos_updated";
    case "questionnaire_updated":
      return "questionnaire_updated";
    default:
      return null;
  }
}

function rebuildSnapshotIndexes(turn: ActiveTurn): void {
  turn.snapshotIndexes.clear();
  for (let index = 0; index < turn.events.length; index += 1) {
    const key = snapshotKey(turn.events[index]!);
    if (key) {
      turn.snapshotIndexes.set(key, index);
    }
  }
}

function removeEventAt(turn: ActiveTurn, index: number): StreamEvent {
  const [removed] = turn.events.splice(index, 1);
  rebuildSnapshotIndexes(turn);
  return removed!;
}

function shouldReplaceOnPublish(event: StreamEvent): boolean {
  return (
    event.type === "tool_input_delta" ||
    event.type === "todos_updated" ||
    event.type === "questionnaire_updated"
  );
}

function publishSnapshotKey(event: StreamEvent): string | null {
  if (!shouldReplaceOnPublish(event)) {
    return null;
  }
  return snapshotKey(event);
}

function trimBuffer(turn: ActiveTurn): void {
  if (
    turn.events.length <= MAX_BUFFER_EVENTS &&
    turn.bufferBytes <= MAX_BUFFER_BYTES
  ) {
    return;
  }

  const latestSnapshots = new Map<string, number>();
  const sizes = turn.events.map((event, index) => {
    const key = snapshotKey(event);
    if (key) {
      latestSnapshots.set(key, index);
    }
    return estimateEventBytes(event);
  });
  const snapshots = new Set(latestSnapshots.values());
  const keep = new Set<number>();
  let bufferBytes = 0;
  const retain = (index: number): void => {
    const size = sizes[index]!;
    if (
      !keep.has(index) &&
      keep.size < MAX_BUFFER_EVENTS &&
      bufferBytes + size <= MAX_BUFFER_BYTES
    ) {
      keep.add(index);
      bufferBytes += size;
    }
  };

  // Replay is a bounded window. Prefer terminal events, then the newest
  // snapshot for each key, then recent events that fit. Never truncate payloads
  // or loop until a budget changes: every pass visits each candidate once.
  for (let index = turn.events.length - 1; index >= 0; index -= 1) {
    if (isTerminalEvent(turn.events[index]!)) {
      retain(index);
    }
  }
  for (let index = turn.events.length - 1; index >= 0; index -= 1) {
    if (snapshots.has(index)) {
      retain(index);
    }
  }
  for (let index = turn.events.length - 1; index >= 0; index -= 1) {
    retain(index);
  }

  turn.events = turn.events.filter((_, index) => keep.has(index));
  turn.bufferBytes = bufferBytes;
  rebuildSnapshotIndexes(turn);
}

export class SessionTurnRegistry {
  private readonly turns = new Map<string, ActiveTurn>();

  beginTurn(sessionId: string, orgId?: string): BeginTurnResult {
    if (this.turns.has(sessionId)) {
      return { started: false };
    }

    this.turns.set(sessionId, {
      abort: new AbortController(),
      attachedAborts: new Set(),
      bufferBytes: 0,
      events: [],
      orgId,
      snapshotIndexes: new Map(),
      startedAt: new Date().toISOString(),
      subscribers: new Set(),
    });

    return { started: true };
  }

  attachAbort(sessionId: string, abort: AbortController): void {
    const turn = this.turns.get(sessionId);
    if (!turn) {
      abort.abort();
      return;
    }

    turn.attachedAborts.add(abort);
    if (turn.abort.signal.aborted) {
      abort.abort();
    }
  }

  canSubscribe(sessionId: string): boolean {
    const turn = this.turns.get(sessionId);
    return Boolean(turn && turn.subscribers.size < MAX_SUBSCRIBERS_PER_SESSION);
  }

  cancelTurn(sessionId: string): void {
    const turn = this.turns.get(sessionId);
    if (!turn) {
      return;
    }

    turn.abort.abort();
    for (const abort of turn.attachedAborts) {
      abort.abort();
    }
    this.endTurn(sessionId, { error: "Turn cancelled.", type: "error" });
  }

  cancelTurnsForOrg(orgId: string): string[] {
    const sessionIds = [...this.turns.entries()]
      .filter(([, turn]) => turn.orgId === orgId)
      .map(([sessionId]) => sessionId);

    for (const sessionId of sessionIds) {
      this.cancelTurn(sessionId);
    }

    return sessionIds;
  }

  getStatus(sessionId: string): TurnStatus {
    const turn = this.turns.get(sessionId);
    if (!turn) {
      return { active: false };
    }

    return { active: true, startedAt: turn.startedAt };
  }

  isActive(sessionId: string): boolean {
    return this.turns.has(sessionId);
  }

  publish(
    sessionId: string,
    event: StreamEvent,
    owner?: AbortController
  ): void {
    const turn = this.turns.get(sessionId);
    if (!turn || (owner && !turn.attachedAborts.has(owner))) {
      return;
    }

    const key = publishSnapshotKey(event);
    if (key) {
      const existingIndex = turn.snapshotIndexes.get(key);
      if (existingIndex !== undefined) {
        const removed = removeEventAt(turn, existingIndex);
        turn.bufferBytes -= estimateEventBytes(removed);
      }
    }

    const eventBytes = estimateEventBytes(event);
    // Oversized or non-serializable events still reach live subscribers, but
    // cannot enter the replay buffer. Replaced snapshots stay invalidated.
    if (eventBytes <= MAX_BUFFER_BYTES) {
      turn.events.push(event);
      turn.bufferBytes += eventBytes;
      if (key) {
        turn.snapshotIndexes.set(key, turn.events.length - 1);
      }
      trimBuffer(turn);
    }
    for (const subscriber of turn.subscribers) {
      deliverEvent(subscriber, event);
    }
  }

  subscribe(
    sessionId: string,
    onEvent: (event: StreamEvent) => void
  ): { unsubscribe: () => void } | null {
    const turn = this.turns.get(sessionId);
    if (!turn) {
      return null;
    }

    if (turn.subscribers.size >= MAX_SUBSCRIBERS_PER_SESSION) {
      return null;
    }

    const subscriber: Subscriber = {
      close: () => {
        turn.subscribers.delete(subscriber);
      },
      push: onEvent,
      terminalDelivered: false,
    };

    turn.subscribers.add(subscriber);

    for (const event of turn.events) {
      deliverEvent(subscriber, event);
    }

    return { unsubscribe: subscriber.close };
  }

  endTurn(
    sessionId: string,
    terminal: StreamEvent,
    owner?: AbortController
  ): void {
    const turn = this.turns.get(sessionId);
    if (!turn || (owner && !turn.attachedAborts.has(owner))) {
      return;
    }

    if (isTerminalEvent(terminal)) {
      // A subscriber may join after an oversized terminal was excluded from
      // replay. Complete it too, without repeating terminal delivery to peers.
      for (const subscriber of turn.subscribers) {
        deliverEvent(subscriber, terminal);
      }
    } else {
      this.publish(sessionId, terminal);
    }

    for (const subscriber of turn.subscribers) {
      subscriber.close();
    }

    this.turns.delete(sessionId);
  }
}

export const sessionTurnRegistry = new SessionTurnRegistry();
