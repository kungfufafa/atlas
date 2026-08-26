import { describe, expect, test } from "bun:test";
import type { AgentChannel } from "@atlas/core";
import { shouldExpandLearnCommand } from "./learn-command";

const skillManage = [{ name: "skill_manage" }];

describe("shouldExpandLearnCommand", () => {
  test.each(["web", "cli"] satisfies AgentChannel[])(
    "enables /learn for %s when skill_manage is resolved",
    (channel) => {
      expect(shouldExpandLearnCommand(channel, skillManage)).toBe(true);
    }
  );

  test.each([
    "telegram",
    "whatsapp",
    "discord",
    "automation",
    "task",
    "subagent",
  ] satisfies AgentChannel[])("keeps /learn disabled for %s", (channel) => {
    expect(shouldExpandLearnCommand(channel, skillManage)).toBe(false);
  });

  test("requires the resolved skill_manage tool", () => {
    expect(shouldExpandLearnCommand("web", [])).toBe(false);
    expect(shouldExpandLearnCommand("cli", [{ name: "read_file" }])).toBe(
      false
    );
  });
});
