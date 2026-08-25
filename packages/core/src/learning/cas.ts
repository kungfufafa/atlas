import { createHash } from "node:crypto";
import { applyRedactionBoundary } from "../redaction-boundary";
import { LearningLoopError } from "./loop";

export function hashSkillContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function assertFullSkillMarkdown(content: string): string {
  const redacted = applyRedactionBoundary(content.trim(), "learning");
  if (!(redacted.includes("---") && redacted.includes("name:"))) {
    throw new LearningLoopError(
      "Skill mutation must carry a full SKILL.md with YAML frontmatter."
    );
  }
  const body = redacted.split("---").slice(2).join("---").trim();
  if (body.length < 40) {
    throw new LearningLoopError(
      "Generated skills must include a full procedure body, not only a name or description."
    );
  }
  return redacted;
}

export function applySkillCasPatch(input: {
  baseVersion: number;
  currentContent: string;
  expectedHash: string;
  nextContent: string;
}): { content: string; digest: string; version: number } {
  if (input.baseVersion < 0) {
    throw new LearningLoopError("baseVersion must be >= 0.");
  }
  const currentHash = hashSkillContent(input.currentContent);
  if (currentHash !== input.expectedHash) {
    throw new LearningLoopError(
      "CAS conflict: SKILL.md changed since baseVersion was read."
    );
  }
  const content = assertFullSkillMarkdown(input.nextContent);
  return {
    content,
    digest: hashSkillContent(content),
    version: input.baseVersion + 1,
  };
}

export function composeProcedureSkillMarkdown(input: {
  description: string;
  name: string;
  steps: string[];
}): string {
  if (input.steps.length < 2) {
    throw new LearningLoopError(
      "A procedure skill requires at least two explicit steps."
    );
  }
  const body = [
    "## When to use",
    "",
    input.description.trim(),
    "",
    "## Steps",
    "",
    ...input.steps.map((step, index) => `${index + 1}. ${step.trim()}`),
    "",
    "## Verification",
    "",
    "Confirm each step completed before reporting success.",
  ].join("\n");
  return [
    "---",
    `name: ${input.name}`,
    `description: ${input.description.trim()}`,
    "---",
    "",
    body,
    "",
  ].join("\n");
}
