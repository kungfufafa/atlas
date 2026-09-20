import { describe, expect, test } from "bun:test";
import {
  type DiscoveredSkill,
  discoveredSkillFromMarkdown,
  type ProviderClient,
  type ToolDefinition,
} from "@atlas/core";
import { createAgentHarness } from "./index";
import {
  distillFallbackSkill,
  runSkillLearningTurn,
  type SkillLearningStore,
} from "./skill-learning-loop";

function memoryStore(): SkillLearningStore & {
  skills: Map<string, DiscoveredSkill>;
} {
  const skills = new Map<string, DiscoveredSkill>();
  return {
    apply(outcome) {
      if (outcome.action === "patch") {
        const existing = skills.get(outcome.name);
        if (!existing) {
          return { action: "noop", reason: "missing" };
        }
        const nextBody = existing.body.replace(
          outcome.oldString,
          outcome.newString
        );
        const content = [
          "---",
          `name: ${existing.name}`,
          `description: ${existing.description}`,
          "include-body-on-match: true",
          "---",
          "",
          nextBody,
        ].join("\n");
        const parsed = discoveredSkillFromMarkdown(
          content,
          `memory://${existing.name}/SKILL.md`
        );
        skills.set(parsed.name, parsed);
        return { action: "patch", name: parsed.name };
      }
      const parsed = discoveredSkillFromMarkdown(
        outcome.content,
        `memory://${outcome.name}/SKILL.md`
      );
      skills.set(parsed.name, parsed);
      return { action: outcome.action, name: parsed.name };
    },
    listCatalog() {
      return [...skills.values()].map((skill) => ({
        body: skill.body,
        description: skill.description,
        name: skill.name,
      }));
    },
    listDiscovered() {
      return [...skills.values()];
    },
    skills,
  };
}

function unknownToolTurn(toolName: string, user: string) {
  return [
    { content: user, role: "user" as const },
    {
      content: "",
      role: "assistant" as const,
      toolCalls: [{ arguments: "{}", id: "1", name: toolName }],
    },
    {
      content: JSON.stringify({ error: `Unknown tool: ${toolName}` }),
      name: toolName,
      role: "tool" as const,
      toolCallId: "1",
    },
  ];
}

describe("distillFallbackSkill", () => {
  test("writes a recover skill for an unknown tool", () => {
    const outcome = distillFallbackSkill({
      assignedToolNames: ["lookup_ticket", "write_note"],
      catalog: [],
      signals: [{ kind: "unknown_tool", toolName: "clearance_stamp" }],
      turnMessages: unknownToolTurn(
        "clearance_stamp",
        "Use clearance_stamp on T-42"
      ),
    });
    expect(outcome.action).toBe("create");
    if (outcome.action !== "create") {
      throw new Error("expected create");
    }
    expect(outcome.content).toContain("include-body-on-match: true");
    expect(outcome.content).toContain("Never call `clearance_stamp`");
    expect(outcome.content).toContain("lookup_ticket");
  });

  test("writes a recover skill for a requested unassigned tool", () => {
    const outcome = distillFallbackSkill({
      assignedToolNames: ["lookup_ticket", "write_note"],
      catalog: [],
      signals: [
        { kind: "requested_unassigned_tool", toolName: "clearance_stamp" },
      ],
      turnMessages: [
        { content: "Use clearance_stamp on T-42", role: "user" },
        { content: "that tool is not assigned", role: "assistant" },
      ],
    });
    expect(outcome.action).toBe("create");
    if (outcome.action !== "create") {
      throw new Error("expected create");
    }
    expect(outcome.content).toContain("Never call `clearance_stamp`");
    expect(outcome.content).toContain("write_note");
  });

  test("consolidates a second unknown-tool distill into an edit", () => {
    const first = distillFallbackSkill({
      assignedToolNames: ["lookup_ticket"],
      catalog: [],
      signals: [{ kind: "unknown_tool", toolName: "clearance_stamp" }],
      turnMessages: unknownToolTurn("clearance_stamp", "stamp T-42"),
    });
    expect(first.action).toBe("create");
    if (first.action !== "create") {
      throw new Error("expected create");
    }
    const second = distillFallbackSkill({
      assignedToolNames: ["lookup_ticket"],
      catalog: [
        {
          body: discoveredSkillFromMarkdown(first.content).body,
          description: discoveredSkillFromMarkdown(first.content).description,
          name: first.name,
        },
      ],
      signals: [{ kind: "unknown_tool", toolName: "clearance_stamp" }],
      turnMessages: unknownToolTurn("clearance_stamp", "stamp T-42 again"),
    });
    expect(second.action === "noop" || second.action === "edit").toBe(true);
  });
});

describe("runSkillLearningTurn", () => {
  test("is disabled by default", async () => {
    const store = memoryStore();
    const result = await runSkillLearningTurn({
      assignedToolNames: ["lookup_ticket"],
      enabled: false,
      store,
      turnMessages: unknownToolTurn("clearance_stamp", "stamp it"),
    });
    expect(result.skipped).toBe("disabled");
    expect(store.skills.size).toBe(0);
  });

  test("skips messaging channels", async () => {
    const store = memoryStore();
    const result = await runSkillLearningTurn({
      assignedToolNames: ["lookup_ticket"],
      channel: "whatsapp",
      enabled: true,
      store,
      turnMessages: unknownToolTurn("clearance_stamp", "stamp it"),
    });
    expect(result.skipped).toBe("channel");
    expect(store.skills.size).toBe(0);
  });

  test("falls back to a deterministic skill when the LLM noops", async () => {
    const store = memoryStore();
    const provider: ProviderClient = {
      generateChat() {
        return Promise.resolve({
          assistantMessage: { content: "ok", role: "assistant" },
          content: "ok",
          toolCalls: [],
        });
      },
      generateText() {
        return Promise.resolve({
          content: JSON.stringify({ action: "noop", reason: "routine" }),
        });
      },
      name: "stub",
      streamChat() {
        return Promise.resolve({
          assistantMessage: { content: "ok", role: "assistant" },
          content: "ok",
          toolCalls: [],
        });
      },
    };
    const result = await runSkillLearningTurn({
      assignedToolNames: ["lookup_ticket", "write_note"],
      channel: "cli",
      enabled: true,
      provider,
      store,
      turnMessages: unknownToolTurn(
        "clearance_stamp",
        "Use clearance_stamp on T-42"
      ),
    });
    expect(result.applied?.action).toBe("create");
    expect(store.skills.size).toBe(1);
    const skill = [...store.skills.values()][0];
    expect(skill?.includeBodyOnMatch).toBe(true);
    expect(skill?.body).toContain("clearance_stamp");
  });

  test("respects write-approval staging from the store", async () => {
    const store: SkillLearningStore = {
      apply(_outcome, context) {
        if (context?.writeApprovalRequired) {
          return {
            action: "staged",
            name: "recover-clearance-stamp",
            staged: true,
          };
        }
        return { action: "create", name: "recover-clearance-stamp" };
      },
      listCatalog() {
        return [];
      },
      listDiscovered() {
        return [];
      },
    };
    const result = await runSkillLearningTurn({
      assignedToolNames: ["lookup_ticket"],
      enabled: true,
      store,
      turnMessages: unknownToolTurn("clearance_stamp", "stamp T-42"),
      writeApprovalRequired: true,
    });
    expect(result.applied?.staged).toBe(true);
  });
});

describe("createAgentChatSession skill learning", () => {
  test("learns from an unknown tool and injects the skill on the next session", async () => {
    const store = memoryStore();
    let calls = 0;
    const provider: ProviderClient = {
      generateChat() {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve({
            assistantMessage: {
              content: "",
              role: "assistant",
              toolCalls: [
                {
                  arguments: "{}",
                  id: "1",
                  name: "clearance_stamp",
                },
              ],
            },
            content: "",
            toolCalls: [
              {
                arguments: "{}",
                id: "1",
                name: "clearance_stamp",
              },
            ],
          });
        }
        return Promise.resolve({
          assistantMessage: { content: "done", role: "assistant" },
          content: "done",
          toolCalls: [],
        });
      },
      generateText() {
        return Promise.resolve({
          content: JSON.stringify({ action: "noop", reason: "fallback" }),
        });
      },
      name: "stub",
      streamChat() {
        return Promise.resolve({
          assistantMessage: { content: "done", role: "assistant" },
          content: "done",
          toolCalls: [],
        });
      },
    };

    const assigned: ToolDefinition = {
      description: "Look up a ticket",
      name: "lookup_ticket",
      parameters: { properties: {}, type: "object" },
      run: () => Promise.resolve({ ok: true }),
    };

    const harness = createAgentHarness({ provider, tools: [assigned] });
    const phase1 = harness.createChatSession({
      enableToolLoop: true,
      skillLearning: { enabled: true, store },
      tools: [assigned],
    });
    await phase1.send("Use clearance_stamp on T-42");
    expect(store.skills.size).toBe(1);

    let capturedPrompt = "";
    const phase2Provider: ProviderClient = {
      generateChat(input) {
        capturedPrompt = input.system;
        return Promise.resolve({
          assistantMessage: { content: "recovered", role: "assistant" },
          content: "recovered",
          toolCalls: [],
        });
      },
      generateText() {
        return Promise.resolve({ content: "{}" });
      },
      name: "stub",
      streamChat(input, handlers) {
        capturedPrompt = input.system;
        handlers.onChunk("recovered");
        return Promise.resolve({
          assistantMessage: { content: "recovered", role: "assistant" },
          content: "recovered",
          toolCalls: [],
        });
      },
    };
    const phase2 = createAgentHarness({
      provider: phase2Provider,
      tools: [],
    }).createChatSession({
      skillLearning: { enabled: false, store },
    });
    await phase2.send("Stamp the clearance for ticket T-42");
    expect(capturedPrompt).toContain("Available Agent Skills");
    expect(capturedPrompt).toContain("Active Skill");
    expect(capturedPrompt).toContain("Never call `clearance_stamp`");
  });

  test("learns from a requested unassigned tool when the model never called it", async () => {
    const store = memoryStore();
    let calls = 0;
    const provider: ProviderClient = {
      generateChat() {
        calls += 1;
        return Promise.resolve({
          assistantMessage: {
            content: "clearance_stamp is not assigned",
            role: "assistant",
          },
          content: "clearance_stamp is not assigned",
          toolCalls: [],
        });
      },
      generateText() {
        return Promise.resolve({
          content: JSON.stringify({ action: "noop", reason: "fallback" }),
        });
      },
      name: "stub",
      streamChat() {
        return Promise.resolve({
          assistantMessage: { content: "done", role: "assistant" },
          content: "done",
          toolCalls: [],
        });
      },
    };
    const assigned: ToolDefinition = {
      description: "Look up a ticket",
      name: "lookup_ticket",
      parameters: { properties: {}, type: "object" },
      run: () => Promise.resolve({ ok: true }),
    };
    const harness = createAgentHarness({ provider, tools: [assigned] });
    const phase1 = harness.createChatSession({
      enableToolLoop: true,
      skillLearning: { enabled: true, store },
      tools: [assigned],
    });
    await phase1.send("Use clearance_stamp on T-42");
    expect(calls).toBeGreaterThan(0);
    expect(store.skills.size).toBe(1);
    expect([...store.skills.values()][0]?.body).toContain("clearance_stamp");
  });
});
