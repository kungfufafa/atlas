import { afterEach, describe, expect, test } from "bun:test";
import type { WAMessageKey } from "@whiskeysockets/baileys";
import {
  clearActiveStream,
  registerActiveStream,
  resetActiveStreamsForTests,
  stopActiveStream,
} from "./active-stream";
import { resetChatLocksForTests, withChatLock } from "./chat-handler";
import { WhatsAppInboundDispatcher } from "./inbound-dispatch";
import {
  type WhatsAppNativeBinding,
  WhatsAppNativeControls,
  type WhatsAppNativeReaction,
} from "./native-controls";
import { runClaimedInboundDelivery } from "./socket";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function dispatcher() {
  return new WhatsAppInboundDispatcher({
    maxConcurrent: 4,
    maxQueued: 10,
    maxWaitMs: 1000,
  });
}

function binding(jid: string): WhatsAppNativeBinding {
  return {
    channelUserAliases: [],
    channelUserId: jid,
    destination: jid,
    orgId: "org",
    profileId: "profile",
    sessionId: `session-${jid}`,
    userId: "user",
  };
}

function nativeFixture() {
  const controls = new WhatsAppNativeControls();
  const sent: WAMessageKey[] = [];
  const socket = {
    sendMessage: async (jid: string) => {
      const key = { fromMe: true, id: `sent-${sent.length}`, remoteJid: jid };
      sent.push(key);
      return { key };
    },
  };
  const reaction = (
    key: WAMessageKey,
    emoji: string
  ): WhatsAppNativeReaction => ({
    actorAliases: [],
    actorId: key.remoteJid!,
    destination: key.remoteJid!,
    emoji,
    eventId: `reaction-${key.id}`,
    target: key,
  });
  return { controls, reaction, sent, socket: socket as never };
}

afterEach(() => {
  resetActiveStreamsForTests();
  resetChatLocksForTests();
});

describe("WhatsApp socket work dispatch", () => {
  test("same-chat followups wait outside active slots and keep the delivery claim until completion", async () => {
    const queue = dispatcher();
    const gate = deferred();
    const started = deferred();
    const completed: string[] = [];
    const ran: string[] = [];
    const jid = "628111@s.whatsapp.net";
    const first = queue.runMessage(jid, "work", () =>
      runClaimedInboundDelivery({
        deliver: () =>
          withChatLock(jid, async () => {
            started.resolve();
            await gate.promise;
            ran.push("first");
          }),
        deliveryId: "first",
        ledger: {
          complete: async (id) => {
            completed.push(id);
          },
          release: () => {},
        },
      })
    );
    await started.promise;
    const waiting = ["second", "third", "fourth"].map((id) =>
      queue.runMessage("628111:2@s.whatsapp.net", "work", () =>
        withChatLock(jid, async () => {
          ran.push(id);
        })
      )
    );
    expect(queue.snapshot().messages).toEqual({ active: 1, queued: 3 });
    await queue.runMessage("628222@s.whatsapp.net", "work", async () => {
      ran.push("independent");
    });
    expect(ran).toEqual(["independent"]);
    expect(completed).toEqual([]);
    await queue.runReaction(jid, "✅", async () => {
      gate.resolve();
    });
    await Promise.all([first, ...waiting]);
    expect(ran).toEqual(["independent", "first", "second", "third", "fourth"]);
    expect(completed).toEqual(["first"]);
    expect(queue.snapshot().messages).toEqual({ active: 0, queued: 0 });
  });

  test("approval decisions remain available with four pending approvals", async () => {
    const queue = dispatcher();
    const f = nativeFixture();
    const ready = [deferred(), deferred(), deferred(), deferred()];
    const decisions: string[] = [];
    const turns = ready.map((started, index) => {
      const jid = `62811${index}@s.whatsapp.net`;
      const gate = deferred();
      return queue.runMessage(jid, "work", async () => {
        await f.controls.approval({
          approval: {
            consequenceSummary: "Send the requested file",
            createdAt: new Date().toISOString(),
            id: `approval-${index}`,
            status: "pending",
            title: "Send file",
            tool: "channel_action",
            toolCallId: `call-${index}`,
          },
          binding: binding(jid),
          decide: async (decision) => {
            decisions.push(decision);
            gate.resolve();
          },
          socket: f.socket,
        });
        started.resolve();
        await gate.promise;
      });
    });
    await Promise.all(ready.map((started) => started.promise));
    expect(queue.snapshot().messages.active).toBe(4);
    const controls = f.sent.map((key, index) => {
      const event = f.reaction(key, index % 2 ? "❌" : "✅");
      return queue.runReaction(event.destination, event.emoji, () =>
        f.controls.react(event, async () => ({ userId: "user" }))
      );
    });
    expect(await Promise.all(controls)).toEqual([true, true, true, true]);
    await Promise.all(turns);
    expect(decisions.sort()).toEqual([
      "approved",
      "approved",
      "denied",
      "denied",
    ]);
    expect(queue.snapshot()).toEqual({
      controls: { active: 0, queued: 0 },
      messages: { active: 0, queued: 0 },
    });
  });

  test("stop cancels an active stream while all chat slots and the waiting queue are occupied", async () => {
    const queue = dispatcher();
    const ready = [deferred(), deferred(), deferred(), deferred()];
    const turns = ready.map((started, index) => {
      const jid = `62822${index}@s.whatsapp.net`;
      return queue.runMessage(jid, "work", async () => {
        const signal = registerActiveStream(jid);
        const stopped = deferred();
        signal.addEventListener("abort", stopped.resolve, { once: true });
        started.resolve();
        await stopped.promise;
        clearActiveStream(jid, signal);
      });
    });
    await Promise.all(ready.map((started) => started.promise));
    const followups = Array.from({ length: 10 }, () =>
      queue.runMessage("628220@s.whatsapp.net", "queued", async () => {})
    );
    expect(queue.snapshot().messages).toEqual({ active: 4, queued: 10 });
    for (const index of [0, 1, 2, 3]) {
      const jid = `62822${index}@s.whatsapp.net`;
      await queue.runMessage(jid, "  /STOP ", async () => {
        expect(stopActiveStream(jid)).toBe(true);
      });
    }
    await Promise.all([...turns, ...followups]);
    expect(queue.snapshot().messages).toEqual({ active: 0, queued: 0 });
  });

  test("questionnaire continuation turns cannot occupy approval decision slots", async () => {
    const queue = dispatcher();
    const f = nativeFixture();
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const ready = gates.map(() => deferred());
    for (const [index, gate] of gates.entries()) {
      const jid = `62833${index}@s.whatsapp.net`;
      await f.controls.questionnaire({
        answer: async () => {
          ready[index]!.resolve();
          await gate.promise;
        },
        binding: binding(jid),
        questionnaire: {
          id: `question-${index}`,
          questions: [
            {
              allowCustomAnswer: false,
              choices: [{ id: "yes", label: "Yes" }],
              id: "choice",
              prompt: "Continue?",
            },
          ],
          title: "Choose",
        },
        socket: f.socket,
      });
    }
    const turns = f.sent.map((key) => {
      const event = f.reaction(key, "1️⃣");
      return queue.runReaction(event.destination, event.emoji, () =>
        f.controls.react(event, async () => ({ userId: "user" }))
      );
    });
    await Promise.all(ready.map((started) => started.promise));
    expect(queue.snapshot()).toEqual({
      controls: { active: 0, queued: 0 },
      messages: { active: 4, queued: 0 },
    });
    await queue.runReaction("628330@s.whatsapp.net", "✅", async () => {
      for (const gate of gates) {
        gate.resolve();
      }
    });
    expect(await Promise.all(turns)).toEqual([true, true, true, true]);
  });
});
