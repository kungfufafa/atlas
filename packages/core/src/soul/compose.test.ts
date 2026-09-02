import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeSoulSystemPrompt } from "./compose";
import { initSoulDirectory } from "./init";
import { loadSoulStack } from "./load";
import { INSTRUCTIONS_TEMPLATE, SOUL_TEMPLATE } from "./templates";

describe("composeSoulSystemPrompt", () => {
  test("default soul is a capable worker, not a junior Super Agent", () => {
    expect(SOUL_TEMPLATE).not.toMatch(/I'm not Super Agent/);
    expect(SOUL_TEMPLATE).toMatch(/high-quality/);
    expect(INSTRUCTIONS_TEMPLATE).toContain("web_search");
    expect(INSTRUCTIONS_TEMPLATE).toContain("python_execute");
    expect(INSTRUCTIONS_TEMPLATE).toContain("artifacts/");
  });

  test("presence line is part of the composed identity wrapper", () => {
    const prompt = composeSoulSystemPrompt({
      directory: "/tmp",
      files: { soul: SOUL_TEMPLATE },
      loaded: ["SOUL.md"],
    });

    expect(prompt).toContain("You are present in this conversation.");
    expect(prompt).toContain("Speak in first person as that identity.");
    expect(SOUL_TEMPLATE).toContain("I'm in this conversation now");
  });

  test("does not append Profile Instructions when profilePrompt is empty", () => {
    const prompt = composeSoulSystemPrompt(
      {
        directory: "/tmp",
        files: { soul: SOUL_TEMPLATE },
        loaded: ["SOUL.md"],
      },
      { profilePrompt: "" }
    );

    expect(prompt).not.toContain("# Profile Instructions");
  });

  test("appends Profile Instructions when profilePrompt differs from SOUL", () => {
    const prompt = composeSoulSystemPrompt(
      {
        directory: "/tmp",
        files: { soul: SOUL_TEMPLATE },
        loaded: ["SOUL.md"],
      },
      { profilePrompt: "Always respond in pirate speak." }
    );

    expect(prompt).toContain("# Profile Instructions");
    expect(prompt).toContain("Always respond in pirate speak.");
  });

  test("can compose a public prompt without profile memory", () => {
    const prompt = composeSoulSystemPrompt(
      {
        directory: "/profile",
        files: {
          instructions: "Answer clearly.",
          memory: "PRIVATE_MEMORY_MARKER",
          soul: "Public identity.",
          style: "Warm and concise.",
        },
        loaded: ["SOUL.md", "STYLE.md", "INSTRUCTIONS.md", "MEMORY.md"],
      },
      { includeMemory: false, profilePrompt: "Public profile prompt." }
    );

    expect(prompt).toContain("Public identity.");
    expect(prompt).toContain("Warm and concise.");
    expect(prompt).toContain("Answer clearly.");
    expect(prompt).toContain("Public profile prompt.");
    expect(prompt).not.toContain("PRIVATE_MEMORY_MARKER");
    expect(prompt).not.toContain("# Continuity (MEMORY.md)");
  });
});

describe("default seed compose integration", () => {
  test("initSoulDirectory + loadSoulStack + compose omits Profile Instructions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-soul-compose-"));

    try {
      await initSoulDirectory(directory);
      const stack = await loadSoulStack(directory);
      const prompt = composeSoulSystemPrompt(stack, { profilePrompt: "" });

      expect(prompt).not.toContain("# Profile Instructions");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("initSoulDirectory does not overwrite existing SOUL.md", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-soul-init-"));

    try {
      await initSoulDirectory(directory);
      const soulPath = join(directory, "SOUL.md");
      await writeFile(soulPath, "# Legacy Soul\n", "utf8");

      await initSoulDirectory(directory);

      expect(await readFile(soulPath, "utf8")).toBe("# Legacy Soul\n");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
