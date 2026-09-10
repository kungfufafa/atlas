import { describe, expect, test } from "bun:test";
import { CHAT_TOOL_APPROVAL_TIMEOUT_MS } from "@atlas/core/chat-tool-approval-timeout";
import type { AgentQuestionnaire, ApprovalRequest } from "@atlas/core/contract";
import {
  parseWhatsAppNativeReaction,
  type WhatsAppNativeBinding,
  WhatsAppNativeControls,
  type WhatsAppNativeReaction,
} from "./native-controls";

const binding: WhatsAppNativeBinding = {
  channelUserAliases: ["100@lid"],
  channelUserId: "628111@s.whatsapp.net",
  destination: "120000@g.us",
  orgId: "org-a",
  profileId: "profile-a",
  sessionId: "session-a",
  userId: "user-a",
};
const approval: ApprovalRequest = {
  consequenceSummary: "A message will be delivered",
  createdAt: new Date().toISOString(),
  id: "approval-a",
  status: "pending",
  title: "Send message",
  tool: "native_action",
  toolCallId: "call-a",
};

function fixture() {
  let now = 1;
  const controls = new WhatsAppNativeControls(() => now);
  const sent: Array<{
    jid: string;
    text: string;
    key: { id: string; remoteJid: string; fromMe: boolean };
  }> = [];
  const socket = {
    sendMessage: async (jid: string, body: { text: string }) => {
      const key = {
        fromMe: true,
        id: `message-${sent.length}`,
        remoteJid: jid,
      };
      sent.push({ jid, key, text: body.text });
      return { key };
    },
  };
  const reaction = (
    index = 0,
    extra: Partial<WhatsAppNativeReaction> = {}
  ): WhatsAppNativeReaction => ({
    actorAliases: ["628111@s.whatsapp.net"],
    actorId: "100@lid",
    destination: binding.destination,
    emoji: "✅",
    eventId: `event-${index}`,
    target: sent[index]!.key,
    ...extra,
  });
  return {
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    controls,
    expire: () => {
      now += CHAT_TOOL_APPROVAL_TIMEOUT_MS + 1;
    },
    reaction,
    sent,
    socket: socket as never,
  };
}

describe("WhatsApp controls bind reactions to the exact message, tenant session and canonical actor", () => {
  test.each([10 * 60_000, CHAT_TOOL_APPROVAL_TIMEOUT_MS - 1])(
    "pending approval remains actionable and deduplicated after %d milliseconds",
    async (elapsed) => {
      const f = fixture();
      const decisions: string[] = [];
      const input = {
        approval,
        binding,
        decide: async (decision: string) => {
          decisions.push(decision);
        },
        socket: f.socket,
      };
      await f.controls.approval(input);
      f.advance(elapsed);
      await f.controls.approval(input);
      expect(f.sent).toHaveLength(1);
      expect(
        await f.controls.react(f.reaction(), async () => ({
          userId: binding.userId,
        }))
      ).toBe(true);
      expect(decisions).toEqual(["approved"]);
    }
  );

  test("approval expires at the shared decision boundary without dispatching a decision", async () => {
    const f = fixture();
    let decisions = 0;
    await f.controls.approval({
      approval,
      binding,
      decide: async () => {
        decisions += 1;
      },
      socket: f.socket,
    });
    f.advance(CHAT_TOOL_APPROVAL_TIMEOUT_MS);
    expect(
      await f.controls.react(f.reaction(), async () => ({
        userId: binding.userId,
      }))
    ).toBe(false);
    expect(decisions).toBe(0);
  });

  test("a retained approval card cannot bypass a server decision rejection", async () => {
    const f = fixture();
    let dispatched = 0;
    const rejection = new Error("The server no longer accepts this approval.");
    await f.controls.approval({
      approval,
      binding,
      decide: async () => {
        dispatched += 1;
        throw rejection;
      },
      socket: f.socket,
    });
    f.advance(11 * 60_000);
    await expect(
      f.controls.react(f.reaction(), async () => ({ userId: binding.userId }))
    ).rejects.toBe(rejection);
    expect(
      await f.controls.react(f.reaction(0, { eventId: "retry" }), async () => ({
        userId: binding.userId,
      }))
    ).toBe(false);
    expect(dispatched).toBe(1);
  });

  test("questionnaire cards still expire after ten minutes", async () => {
    const f = fixture();
    let answers = 0;
    await f.controls.questionnaire({
      answer: async () => {
        answers += 1;
      },
      binding,
      questionnaire: {
        id: "short-lived-questionnaire",
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
    f.advance(10 * 60_000);
    expect(
      await f.controls.react(f.reaction(0, { emoji: "1️⃣" }), async () => ({
        userId: binding.userId,
      }))
    ).toBe(false);
    expect(answers).toBe(0);
  });

  test("multiple-selection questionnaires preserve every choice in typed fallback and never submit one reaction", async () => {
    const f = fixture();
    const answers: string[] = [];
    await f.controls.questionnaire({
      answer: async (text) => {
        answers.push(text);
      },
      binding,
      questionnaire: {
        id: "multiple",
        questions: [
          {
            allowCustomAnswer: false,
            choices: [
              { id: "red", label: "Red" },
              { id: "blue", label: "Blue" },
            ],
            id: "colors",
            prompt: "Choose all colors",
            selectionMode: "multiple",
          },
        ],
        title: "Choose colors",
      },
      socket: f.socket,
    });
    expect(f.sent.length).toBe(1);
    expect(f.sent[0]!.text).toContain("Red");
    expect(f.sent[0]!.text).toContain("Blue");
    expect(
      await f.controls.react(f.reaction(0, { emoji: "1️⃣" }), async () => ({
        userId: binding.userId,
      }))
    ).toBe(false);
    expect(answers).toEqual([]);
  });
  test("Baileys actor and target keys cannot be swapped or cross chat", () => {
    const target = {
      fromMe: true,
      id: "target",
      remoteJid: binding.destination,
    };
    const actor = {
      fromMe: false,
      id: "event",
      participant: "100@lid",
      remoteJid: binding.destination,
    };
    expect(
      parseWhatsAppNativeReaction({
        key: target,
        reaction: { key: actor, text: "✅" },
      })?.actorId
    ).toBe("100@lid");
    expect(
      parseWhatsAppNativeReaction({
        key: actor,
        reaction: { key: target, text: "✅" },
      })
    ).toBeNull();
    const self = { id: "628999@s.whatsapp.net" };
    expect(
      parseWhatsAppNativeReaction(
        {
          key: { fromMe: true, id: "target", remoteJid: self.id },
          reaction: {
            key: { fromMe: true, id: "self-react", remoteJid: self.id },
            text: "✅",
          },
        },
        self
      )?.actorId
    ).toBe(self.id);
    expect(
      parseWhatsAppNativeReaction(
        {
          key: { fromMe: true, id: "target", remoteJid: "628999@lid" },
          reaction: {
            key: { fromMe: true, id: "self-react", remoteJid: "628999@lid" },
            text: "✅",
          },
        },
        self
      )
    ).toBeNull();
    expect(
      parseWhatsAppNativeReaction({
        key: target,
        reaction: { key: { ...actor, remoteJid: "foreign@g.us" }, text: "✅" },
      })
    ).toBeNull();
    expect(
      parseWhatsAppNativeReaction({
        key: target,
        reaction: { key: actor, text: "" },
      })
    ).toBeNull();
    expect(
      parseWhatsAppNativeReaction({
        key: target,
        reaction: { key: { ...actor, participant: null }, text: "✅" },
      })
    ).toBeNull();
  });

  test.each(["✅", "❌"])(
    "current PN/LID canonical owner can decide %s once, even after an unknown response",
    async (emoji) => {
      const f = fixture();
      const decisions: string[] = [];
      await f.controls.approval({
        approval,
        binding,
        decide: async (decision) => {
          decisions.push(decision);
          throw new Error("reply lost");
        },
        socket: f.socket,
      });
      await expect(
        f.controls.react(f.reaction(0, { emoji }), async () => ({
          userId: binding.userId,
        }))
      ).rejects.toThrow();
      expect(decisions).toEqual([emoji === "✅" ? "approved" : "denied"]);
      expect(
        await f.controls.react(
          f.reaction(0, { emoji, eventId: "replay" }),
          async () => ({ userId: binding.userId })
        )
      ).toBe(false);
      expect(decisions.length).toBe(1);
    }
  );

  test("foreign canonical user, chat, target, non-bot target and revoked admission have zero decisions", async () => {
    const f = fixture();
    let decisions = 0;
    await f.controls.approval({
      approval,
      binding,
      decide: async () => {
        decisions += 1;
      },
      socket: f.socket,
    });
    expect(
      await f.controls.react(f.reaction(), async () => ({
        userId: "other-user",
      }))
    ).toBe(false);
    expect(
      await f.controls.react(
        f.reaction(0, { destination: "another@g.us" }),
        async () => ({ userId: binding.userId })
      )
    ).toBe(false);
    expect(
      await f.controls.react(
        f.reaction(0, { target: { ...f.sent[0]!.key, id: "another" } }),
        async () => ({ userId: binding.userId })
      )
    ).toBe(false);
    expect(
      await f.controls.react(
        f.reaction(0, { target: { ...f.sent[0]!.key, fromMe: false } }),
        async () => ({ userId: binding.userId })
      )
    ).toBe(false);
    await expect(
      f.controls.react(f.reaction(), async () => {
        throw new Error("membership revoked");
      })
    ).rejects.toThrow();
    expect(decisions).toBe(0);
    expect(
      await f.controls.react(f.reaction(), async () => ({
        userId: binding.userId,
      }))
    ).toBe(true);
    expect(decisions).toBe(1);
  });

  test("expiry during asynchronous authorization and concurrent duplicate reactions are denied", async () => {
    const f = fixture();
    let decisions = 0;
    await f.controls.approval({
      approval,
      binding,
      decide: async () => {
        decisions += 1;
      },
      socket: f.socket,
    });
    expect(
      await f.controls.react(f.reaction(), async () => {
        f.expire();
        return { userId: binding.userId };
      })
    ).toBe(false);
    expect(decisions).toBe(0);
    const g = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await g.controls.approval({
      approval,
      binding,
      decide: async () => {
        decisions += 1;
      },
      socket: g.socket,
    });
    const first = g.controls.react(g.reaction(), async () => {
      await gate;
      return { userId: binding.userId };
    });
    expect(
      await g.controls.react(
        g.reaction(0, { eventId: "concurrent" }),
        async () => ({ userId: binding.userId })
      )
    ).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(decisions).toBe(1);
  });

  test("repeated SSE cards do not send twice and questionnaire choices collect all answers", async () => {
    const f = fixture();
    const answers: string[] = [];
    const questionnaire: AgentQuestionnaire = {
      id: "questionnaire-a",
      questions: ["Color", "Size"].map((prompt, index) => ({
        allowCustomAnswer: true,
        choices: [
          { id: "a", label: "First" },
          { id: "b", label: "Second" },
        ],
        id: `q${index}`,
        prompt,
      })),
      title: "Choose",
    };
    const input = {
      answer: async (text: string) => {
        answers.push(text);
      },
      binding,
      questionnaire,
      socket: f.socket,
    };
    await f.controls.questionnaire(input);
    await f.controls.questionnaire(input);
    expect(f.sent.length).toBe(2);
    expect(
      await f.controls.react(f.reaction(0, { emoji: "👍" }), async () => ({
        userId: binding.userId,
      }))
    ).toBe(false);
    expect(
      await f.controls.react(f.reaction(0, { emoji: "2️⃣" }), async () => ({
        userId: binding.userId,
      }))
    ).toBe(true);
    expect(answers.length).toBe(0);
    expect(
      await f.controls.react(f.reaction(1, { emoji: "1️⃣" }), async () => ({
        userId: binding.userId,
      }))
    ).toBe(true);
    expect(answers).toEqual([
      "Answers\n\nQ: Color\nA: Second\n\nQ: Size\nA: First",
    ]);
  });

  test("cleared or replaced questionnaires cannot be answered through old reactions", async () => {
    const f = fixture();
    let answers = 0;
    await f.controls.questionnaire({
      answer: async () => {
        answers += 1;
      },
      binding,
      questionnaire: {
        id: "q",
        questions: [
          {
            allowCustomAnswer: false,
            choices: [{ id: "a", label: "A" }],
            id: "q",
            prompt: "Pick",
          },
        ],
        title: "Q",
      },
      socket: f.socket,
    });
    f.controls.clearQuestionnaire(binding);
    expect(
      await f.controls.react(f.reaction(0, { emoji: "1️⃣" }), async () => ({
        userId: binding.userId,
      }))
    ).toBe(false);
    expect(answers).toBe(0);
  });
});
