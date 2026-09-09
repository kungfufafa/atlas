import { expect, test } from "bun:test";
import type { AgentChatSession } from "@atlas/agent";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { wrapPersistedSession } from "./session-persistence";

type Options = NonNullable<Parameters<AgentChatSession["send"]>[1]>;

class InheritedOptions implements Options {
  calls = 0;
  receivers: unknown[] = [];
  async onToolCheckpoint(): Promise<void> {
    this.receivers.push(this);
    this.calls += 1;
  }
}

function innerSession(): AgentChatSession {
  const send: AgentChatSession["send"] = async (_message, options) => {
    await options?.onToolCheckpoint?.();
    return "Fixture complete.";
  };
  return {
    clear() {},
    async compact() {
      throw new Error("Unused fixture method");
    },
    async createAutomation() {
      throw new Error("Unused fixture method");
    },
    getContextUsage: () => null,
    getHistory: () => [],
    getHistoryRevision: () => 0,
    send,
    sendStream: (message, _handlers, options) => send(message, options),
  };
}

for (const streaming of [false, true]) {
  for (const inherited of [false, true]) {
    test(`${streaming ? "stream" : "send"} preserves ${inherited ? "prototype" : "own"} checkpoint callback and receiver`, async () => {
      const own: Options & { calls: number; receivers: unknown[] } = {
        calls: 0,
        async onToolCheckpoint() {
          this.receivers.push(this);
          this.calls += 1;
        },
        receivers: [],
      };
      const options = inherited ? new InheritedOptions() : own;
      const session = wrapPersistedSession(
        "fixture",
        innerSession(),
        createInMemoryDatabaseAdapter()
      );
      if (streaming) {
        await session.sendStream("Fixture", { onChunk() {} }, options);
      } else {
        await session.send("Fixture", options);
      }
      expect(options.calls).toBe(1);
      expect(options.receivers).toHaveLength(1);
      expect(options.receivers[0]).toBe(options);
    });
  }
}
