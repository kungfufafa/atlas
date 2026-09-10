import type { Dispatch, SetStateAction } from "react";

/** Check again when React applies an updater, after any intervening navigation. */
export function guardChatStateUpdates<T>(
  setState: Dispatch<SetStateAction<T>>,
  isCurrent: () => boolean
): Dispatch<SetStateAction<T>> {
  return (next) => {
    if (!isCurrent()) {
      return;
    }
    setState((current) => {
      if (!isCurrent()) {
        return current;
      }
      return typeof next === "function"
        ? (next as (value: T) => T)(current)
        : next;
    });
  };
}

/** Serializes composer sends with session restoration and cancellation. */
export class ChatSendQueue<T> {
  private items: T[] = [];
  private running = false;
  private paused = false;
  private generation = 0;
  private readonly holds = new Set<symbol>();

  constructor(
    private readonly send: (item: T) => Promise<void>,
    private readonly changed: (items: readonly T[]) => void,
    private readonly failed: (error: unknown, item: T) => void
  ) {}

  get busy(): boolean {
    return this.running || this.holds.size > 0 || this.items.length > 0;
  }

  enqueue(item: T): void {
    this.items.push(item);
    this.changed(this.items);
    this.drain();
  }

  restore(item: T): void {
    this.items.unshift(item);
    this.changed(this.items);
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.drain();
  }

  hold(): () => void {
    const token = Symbol("chat queue hold");
    this.holds.add(token);
    return () => {
      if (this.holds.delete(token)) {
        this.drain();
      }
    };
  }

  reset(): void {
    this.generation += 1;
    this.items = [];
    this.holds.clear();
    this.running = false;
    this.paused = false;
    this.changed(this.items);
  }

  private drain(): void {
    if (this.running || this.paused || this.holds.size > 0) {
      return;
    }
    const item = this.items.shift();
    if (item === undefined) {
      return;
    }
    this.running = true;
    this.changed(this.items);
    void this.run(item, this.generation);
  }

  private async run(item: T, generation: number): Promise<void> {
    try {
      await this.send(item);
    } catch (error) {
      if (generation === this.generation) {
        this.pause();
        this.failed(error, item);
      }
    } finally {
      if (generation === this.generation) {
        this.running = false;
        this.drain();
      }
    }
  }
}

interface TurnStatus {
  active: boolean;
  turnId?: string;
}

/** Stop only a turn captured by this view; never cancel a newly observed turn. */
export async function stopChatSessionTurn(input: {
  abortStream: () => void;
  cancelTurn: (turnId: string, signal: AbortSignal) => Promise<unknown>;
  getStatus: (signal: AbortSignal) => Promise<TurnStatus>;
  isCurrent: () => boolean;
  turnId: string | null;
  now?: () => number;
  timeoutMs?: number;
  wait?: () => Promise<void>;
}): Promise<void> {
  const now = input.now ?? Date.now;
  const wait =
    input.wait ??
    (() => new Promise<void>((resolve) => setTimeout(resolve, 150)));
  const timeoutMs = input.timeoutMs ?? 15_000;
  const deadline = now() + timeoutMs;
  const controller = new AbortController();
  const timeoutError = new Error(
    "The response is still stopping. Try again shortly."
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(timeoutError);
      controller.abort();
    }, timeoutMs);
  });
  const stop = async () => {
    if (input.turnId) {
      await input.cancelTurn(input.turnId, controller.signal);
    }
    if (!input.isCurrent() || controller.signal.aborted) {
      return;
    }
    input.abortStream();
    while (input.isCurrent() && !controller.signal.aborted) {
      const status = await input.getStatus(controller.signal);
      if (
        !status.active ||
        (input.turnId && status.turnId && status.turnId !== input.turnId)
      ) {
        return;
      }
      if (now() >= deadline) {
        throw timeoutError;
      }
      await wait();
    }
  };
  try {
    await Promise.race([stop(), timedOut]);
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}
