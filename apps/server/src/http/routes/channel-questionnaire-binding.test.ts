import { afterEach, expect, test } from "bun:test";
import { createAgentHarness } from "@atlas/agent";
import type { AgentQuestionnaire } from "@atlas/core";
import { sessionTurnRegistry } from "../../services/session-turn-registry";
import { setupTestConfigDir } from "../../test-config-dir";
import { createNativeChannelHarness } from "../../testing/channel-native-harness";

setupTestConfigDir("atlas-native-questionnaire-");
const opened: Array<Awaited<ReturnType<typeof createNativeChannelHarness>>> =
  [];
afterEach(() => {
  for (const h of opened.splice(0)) {
    sessionTurnRegistry.cancelTurn(h.sessionId);
    h.database.close();
  }
});
const original: AgentQuestionnaire = {
  id: "questionnaire",
  title: "Choose",
  questions: [
    {
      id: "color",
      prompt: "Color?",
      allowCustomAnswer: false,
      selectionMode: "multiple",
      choices: [
        { id: "red", label: "Red" },
        { id: "blue", label: "Blue" },
      ],
    },
  ],
};
for (const channel of ["telegram", "whatsapp", "discord"] as const) {
  test(`${channel}: exact persisted questionnaire is consumed once under the HTTP turn lock`, async () => {
    const h = await createNativeChannelHarness(channel);
    opened.push(h);
    await h.db.updateSessionQuestionnaire(h.sessionId, original);
    let providerCalls = 0;
    const session = createAgentHarness({
      provider: {
        name: "openai_compatible",
        async generateText() {
          return { content: "unused" };
        },
        async streamChat() {
          throw new Error(
            "This fixture exercises nonstreaming questionnaire admission"
          );
        },
        async generateChat() {
          providerCalls += 1;
          return {
            content: "Received",
            assistantMessage: { role: "assistant", content: "Received" },
            toolCalls: [],
          };
        },
      },
    }).createChatSession();
    h.routeAgent.resolveSession = async () => session;
    const path = `/v1/sessions/${h.sessionId}/messages`;
    const changed = {
      ...original,
      title: "Changed after the native card was shown",
    };
    expect(
      (
        await h.request(path, {
          message: "Red",
          expectedQuestionnaire: changed,
        })
      ).status
    ).toBe(409);
    expect(providerCalls).toBe(0);
    expect(await h.db.getSessionQuestionnaire(h.sessionId)).toEqual(original);
    expect(
      (
        await h.request(path, {
          message: "Red and Blue",
          expectedQuestionnaire: original,
        })
      ).status
    ).toBe(200);
    expect(providerCalls).toBe(1);
    expect(await h.db.getSessionQuestionnaire(h.sessionId)).toBeNull();
    expect(
      (
        await h.request(path, {
          message: "Red and Blue",
          expectedQuestionnaire: original,
        })
      ).status
    ).toBe(409);
    expect(providerCalls).toBe(1);
    expect(
      (await h.request(path, { message: "Ordinary text still works" })).status
    ).toBe(200);
    expect(providerCalls).toBe(2);
  });
}
