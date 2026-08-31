import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createInMemoryDatabaseAdapter,
  ensureBuiltinToolDefinitions,
  ensurePythonExecuteToolDefinition,
  ensureToolSearchToolDefinition,
} from "@atlas/db";
import { ProfileService } from "./profile-service";

const originalConfigDir = process.env.ATLAS_CONFIG_DIR;

const tinyPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const corruptPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVSH2mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const ORG_ID = "org_test";

describe("profile service createTool", () => {
  let tempConfigDir = "";

  afterEach(async () => {
    if (originalConfigDir === undefined) {
      delete process.env.ATLAS_CONFIG_DIR;
    } else {
      process.env.ATLAS_CONFIG_DIR = originalConfigDir;
    }

    if (tempConfigDir) {
      await rm(tempConfigDir, { force: true, recursive: true });
      tempConfigDir = "";
    }
  });

  test("defaults to an executable javascript tool", async () => {
    tempConfigDir = await mkdtemp(
      path.join(os.tmpdir(), "atlas-profile-tool-")
    );
    process.env.ATLAS_CONFIG_DIR = tempConfigDir;
    const toolsDir = path.join(tempConfigDir, "tools");
    await mkdir(toolsDir, { recursive: true });

    await writeFile(
      path.join(toolsDir, "echo.js"),
      `export async function run(input) {
  return input;
}
`,
      "utf8"
    );

    const service = new ProfileService(createInMemoryDatabaseAdapter());
    const tool = await service.createTool(ORG_ID, {
      description: "Echo input",
      handlerConfig: { modulePath: "echo.js" },
      name: "echo",
    });

    expect(tool.handlerType).toBe("javascript");
    const stored = await service
      .listTools(ORG_ID)
      .then((result) => result.tools.find((item) => item.id === tool.id));
    expect(stored?.id).toBe(tool.id);
  });

  test("keeps custom tools private to the creating workspace", async () => {
    tempConfigDir = await mkdtemp(
      path.join(os.tmpdir(), "atlas-profile-tool-")
    );
    process.env.ATLAS_CONFIG_DIR = tempConfigDir;
    const toolsDir = path.join(tempConfigDir, "tools");
    await mkdir(toolsDir, { recursive: true });
    await writeFile(
      path.join(toolsDir, "echo.js"),
      `export async function run(input) {
  return input;
}
`,
      "utf8"
    );

    const db = createInMemoryDatabaseAdapter();
    const now = new Date().toISOString();
    await db.upsertOrganization({
      createdAt: now,
      id: "org_a",
      name: "Org A",
      slug: "org-a",
      updatedAt: now,
    });
    await db.upsertOrganization({
      createdAt: now,
      id: "org_b",
      name: "Org B",
      slug: "org-b",
      updatedAt: now,
    });

    const service = new ProfileService(db);
    const created = await service.createTool("org_a", {
      description: "Echo input",
      handlerConfig: { modulePath: "echo.js" },
      name: "echo",
    });

    const listedA = await service.listTools("org_a");
    const listedB = await service.listTools("org_b");
    expect(listedA.tools.some((tool) => tool.id === created.id)).toBe(true);
    expect(listedB.tools.some((tool) => tool.id === created.id)).toBe(false);

    await expect(service.getTool("org_b", created.id)).rejects.toThrow(
      /not found/i
    );
    await expect(service.deleteTool("org_b", created.id)).rejects.toThrow(
      /not found/i
    );

    const { tool } = await service.getTool("org_a", created.id);
    expect(tool.id).toBe(created.id);
  });

  test("rejects non-javascript handler types", async () => {
    const service = new ProfileService(createInMemoryDatabaseAdapter());

    await expect(
      service.createTool(ORG_ID, {
        description: "Bad tool",
        handlerConfig: { modulePath: "bad-tool.js" },
        handlerType: "custom",
        name: "bad-tool",
      })
    ).rejects.toThrow(/only javascript tools can be created/i);
  });
});

describe("profile service avatar", () => {
  let tempConfigDir = "";

  afterEach(async () => {
    process.env.ATLAS_CONFIG_DIR = originalConfigDir;

    if (tempConfigDir) {
      await rm(tempConfigDir, { force: true, recursive: true });
      tempConfigDir = "";
    }
  });

  test("uploads, serves, and deletes profile avatars", async () => {
    tempConfigDir = await mkdtemp(
      path.join(os.tmpdir(), "atlas-profile-avatar-")
    );
    process.env.ATLAS_CONFIG_DIR = tempConfigDir;

    const service = new ProfileService(createInMemoryDatabaseAdapter());
    const created = await service.createProfile(ORG_ID, { name: "Avatar Bot" });
    const profileId = created.profile.id;

    expect(created.profile.hasAvatar).toBe(false);

    const updated = await service.uploadProfileAvatar(ORG_ID, profileId, {
      data: tinyPngBase64,
      mediaType: "image/png",
    });

    expect(updated.profile.hasAvatar).toBe(true);

    const avatar = await service.getProfileAvatar(ORG_ID, profileId);
    expect(avatar.mediaType).toBe("image/png");
    expect(avatar.bytes.length).toBeGreaterThan(0);

    const publicAvatar = await service.getProfileAvatarByProfileId(profileId);
    expect(publicAvatar.mediaType).toBe("image/png");
    expect(publicAvatar.bytes.length).toBeGreaterThan(0);

    await service.deleteProfileAvatar(ORG_ID, profileId);

    const afterDelete = await service.getProfile(ORG_ID, profileId);
    expect(afterDelete.profile.hasAvatar).toBe(false);
  });

  test("rejects corrupt avatar pixels without writing an avatar", async () => {
    tempConfigDir = await mkdtemp(
      path.join(os.tmpdir(), "atlas-profile-avatar-corrupt-")
    );
    process.env.ATLAS_CONFIG_DIR = tempConfigDir;

    const service = new ProfileService(createInMemoryDatabaseAdapter());
    const created = await service.createProfile(ORG_ID, { name: "Avatar Bot" });
    const profileId = created.profile.id;

    await expect(
      service.uploadProfileAvatar(ORG_ID, profileId, {
        data: corruptPngBase64,
        mediaType: "image/png",
      })
    ).rejects.toMatchObject({ status: 400 });

    const unchanged = await service.getProfile(ORG_ID, profileId);
    expect(unchanged.profile.hasAvatar).toBe(false);
  });
});

describe("profile service createProfile", () => {
  let tempConfigDir = "";

  afterEach(async () => {
    process.env.ATLAS_CONFIG_DIR = originalConfigDir;

    if (tempConfigDir) {
      await rm(tempConfigDir, { force: true, recursive: true });
      tempConfigDir = "";
    }
  });

  test("scaffolds soul templates for new profiles", async () => {
    tempConfigDir = await mkdtemp(
      path.join(os.tmpdir(), "atlas-profile-soul-")
    );
    process.env.ATLAS_CONFIG_DIR = tempConfigDir;

    const service = new ProfileService(createInMemoryDatabaseAdapter());
    const created = await service.createProfile(ORG_ID, { name: "Soul Bot" });
    const soulDir = path.join(
      tempConfigDir,
      "orgs",
      ORG_ID,
      "profiles",
      created.profile.id
    );
    const soulContent = await readFile(path.join(soulDir, "SOUL.md"), "utf8");

    expect(soulContent.trim().length).toBeGreaterThan(0);
    await expect(
      readFile(path.join(soulDir, "STYLE.md"), "utf8")
    ).resolves.toMatch(/\S/);
  });

  test("removes the soul directory when a profile is deleted", async () => {
    tempConfigDir = await mkdtemp(
      path.join(os.tmpdir(), "atlas-profile-delete-")
    );
    process.env.ATLAS_CONFIG_DIR = tempConfigDir;

    const service = new ProfileService(createInMemoryDatabaseAdapter());
    const created = await service.createProfile(ORG_ID, { name: "Doomed Bot" });
    const soulDir = path.join(
      tempConfigDir,
      "orgs",
      ORG_ID,
      "profiles",
      created.profile.id
    );

    await expect(readFile(path.join(soulDir, "SOUL.md"), "utf8")).resolves
      .toBeTruthy;

    await service.deleteProfile(ORG_ID, created.profile.id);

    let dirExists = true;
    try {
      await readFile(path.join(soulDir, "SOUL.md"), "utf8");
    } catch {
      dirExists = false;
    }
    expect(dirExists).toBe(false);
  });

  test("assigns the Default Agent work toolkit when built-in tools exist", async () => {
    tempConfigDir = await mkdtemp(
      path.join(os.tmpdir(), "atlas-profile-default-tools-")
    );
    process.env.ATLAS_CONFIG_DIR = tempConfigDir;

    const db = createInMemoryDatabaseAdapter();
    await ensureBuiltinToolDefinitions(db);
    await ensurePythonExecuteToolDefinition(db);
    await ensureToolSearchToolDefinition(db);

    const service = new ProfileService(db);
    const created = await service.createProfile(ORG_ID, { name: "Skill Bot" });
    const tools = await db.listToolsForProfile(created.profile.id);
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("write_file");
    expect(toolNames).toContain("edit_file");
    expect(toolNames).toContain("search_files");
    expect(toolNames).toContain("knowledge_base_search");
    expect(toolNames).toContain("web_fetch");
    expect(toolNames).toContain("web_search");
    expect(toolNames).toContain("deep_research");
    expect(toolNames).toContain("python_execute");
    expect(toolNames).toContain("tool_search");
    expect(toolNames).toContain("write_pptx");
    expect(toolNames).not.toContain("update_profile_memory");
    expect(toolNames).not.toContain("bash");
    expect(toolNames).not.toContain("generate_image");
    expect(created.profile.systemPrompt).toBe("");
  });

  test("assigns default bundled skills when they exist", async () => {
    tempConfigDir = await mkdtemp(
      path.join(os.tmpdir(), "atlas-profile-default-skills-")
    );
    process.env.ATLAS_CONFIG_DIR = tempConfigDir;

    const db = createInMemoryDatabaseAdapter();
    const now = new Date().toISOString();
    await db.upsertSkill({
      createdAt: now,
      createdBy: "bundled",
      description:
        "Create, update, inspect, or manage reusable profile skills.",
      disableModelInvocation: false,
      enabled: true,
      hasTool: false,
      id: "skill_manage_skills",
      name: "manage-skills",
      sourcePath: path.join(tempConfigDir, "agent", "skills", "manage-skills"),
      updatedAt: now,
    });

    const service = new ProfileService(db);
    const created = await service.createProfile(ORG_ID, { name: "Skill Bot" });
    const skills = await db.listSkillsForProfile(created.profile.id);

    expect(skills.map((skill) => skill.name)).toContain("manage-skills");
  });

  test("skips missing basic built-in tools without failing", async () => {
    tempConfigDir = await mkdtemp(
      path.join(os.tmpdir(), "atlas-profile-missing-tools-")
    );
    process.env.ATLAS_CONFIG_DIR = tempConfigDir;

    const db = createInMemoryDatabaseAdapter();

    const service = new ProfileService(db);
    const created = await service.createProfile(ORG_ID, {
      name: "No Tools Bot",
    });
    const tools = await db.listToolsForProfile(created.profile.id);

    expect(tools).toEqual([]);
  });

  test("writes generated soul files and keeps memory empty", async () => {
    tempConfigDir = await mkdtemp(
      path.join(os.tmpdir(), "atlas-profile-generated-soul-")
    );
    process.env.ATLAS_CONFIG_DIR = tempConfigDir;

    const service = new ProfileService(createInMemoryDatabaseAdapter());
    const created = await service.createProfile(ORG_ID, {
      name: "Support Bot",
      soulFiles: {
        "INSTRUCTIONS.md": "# Instructions\n\nEscalate billing risks.",
        "SOUL.md": "# Support Bot\n\nHelps customers.",
        "STYLE.md": "# Style\n\nClear and kind.",
      },
    });
    const soulDir = path.join(
      tempConfigDir,
      "orgs",
      ORG_ID,
      "profiles",
      created.profile.id
    );

    await expect(
      readFile(path.join(soulDir, "SOUL.md"), "utf8")
    ).resolves.toContain("# Support Bot");
    await expect(
      readFile(path.join(soulDir, "STYLE.md"), "utf8")
    ).resolves.toContain("Clear and kind");
    await expect(
      readFile(path.join(soulDir, "INSTRUCTIONS.md"), "utf8")
    ).resolves.toContain("Escalate billing risks");
    await expect(
      readFile(path.join(soulDir, "MEMORY.md"), "utf8")
    ).resolves.toBe("");
  });

  test("rejects unsupported generated soul file keys", async () => {
    tempConfigDir = await mkdtemp(
      path.join(os.tmpdir(), "atlas-profile-bad-soul-")
    );
    process.env.ATLAS_CONFIG_DIR = tempConfigDir;

    const service = new ProfileService(createInMemoryDatabaseAdapter());

    await expect(
      service.createProfile(ORG_ID, {
        name: "Bad Soul Bot",
        soulFiles: {
          "../SOUL.md": "# Bad",
        } as never,
      })
    ).rejects.toThrow(/unsupported soul file/i);
  });

  test("stores profile model selection", async () => {
    tempConfigDir = await mkdtemp(
      path.join(os.tmpdir(), "atlas-profile-model-")
    );
    process.env.ATLAS_CONFIG_DIR = tempConfigDir;

    const service = new ProfileService(createInMemoryDatabaseAdapter());

    const created = await service.createProfile(ORG_ID, {
      model: "openai:gpt-5",
      name: "Model Bot",
    });

    expect(created.profile.model).toBe("openai:gpt-5");

    const updated = await service.updateProfile(ORG_ID, created.profile.id, {
      model: "anthropic:claude-sonnet-4",
    });

    expect(updated.profile.model).toBe("anthropic:claude-sonnet-4");
  });

  test("uses a slug from the profile name when id is omitted", async () => {
    tempConfigDir = await mkdtemp(
      path.join(os.tmpdir(), "atlas-profile-slug-id-")
    );
    process.env.ATLAS_CONFIG_DIR = tempConfigDir;

    const service = new ProfileService(createInMemoryDatabaseAdapter());
    const created = await service.createProfile(ORG_ID, {
      name: "Research Assistant",
    });

    expect(created.profile.id).toBe("research-assistant");
  });

  test("uses a custom profile id when provided", async () => {
    tempConfigDir = await mkdtemp(
      path.join(os.tmpdir(), "atlas-profile-custom-id-")
    );
    process.env.ATLAS_CONFIG_DIR = tempConfigDir;

    const service = new ProfileService(createInMemoryDatabaseAdapter());
    const created = await service.createProfile(ORG_ID, {
      id: "research-bot",
      name: "Research Bot",
    });

    expect(created.profile.id).toBe("research-bot");
  });

  test("rejects duplicate custom profile ids", async () => {
    tempConfigDir = await mkdtemp(
      path.join(os.tmpdir(), "atlas-profile-duplicate-id-")
    );
    process.env.ATLAS_CONFIG_DIR = tempConfigDir;

    const service = new ProfileService(createInMemoryDatabaseAdapter());

    await service.createProfile(ORG_ID, { id: "support", name: "Support" });

    await expect(
      service.createProfile(ORG_ID, { id: "support", name: "Support 2" })
    ).rejects.toThrow(/already exists/i);
  });

  test("rejects invalid custom profile ids", async () => {
    const service = new ProfileService(createInMemoryDatabaseAdapter());

    await expect(
      service.createProfile(ORG_ID, { id: "../escape", name: "Bad Bot" })
    ).rejects.toThrow(/profile id must/i);
  });
});

describe("profile service assignSkill", () => {
  let tempConfigDir = "";
  const originalPath = process.env.PATH ?? "";
  const originalDisableFixPath = process.env.ATLAS_DISABLE_FIX_PATH;

  afterEach(async () => {
    process.env.ATLAS_CONFIG_DIR = originalConfigDir;
    process.env.PATH = originalPath;
    if (originalDisableFixPath === undefined) {
      delete process.env.ATLAS_DISABLE_FIX_PATH;
    } else {
      process.env.ATLAS_DISABLE_FIX_PATH = originalDisableFixPath;
    }

    if (tempConfigDir) {
      await rm(tempConfigDir, { force: true, recursive: true });
      tempConfigDir = "";
    }
  });

  test("assigns coding-agent without requiring a ready coding harness", async () => {
    tempConfigDir = await mkdtemp(
      path.join(os.tmpdir(), "atlas-profile-assign-skill-")
    );
    process.env.ATLAS_CONFIG_DIR = tempConfigDir;
    process.env.PATH = tempConfigDir;
    process.env.ATLAS_DISABLE_FIX_PATH = "1";

    const db = createInMemoryDatabaseAdapter();
    await ensureBuiltinToolDefinitions(db);
    const now = new Date().toISOString();
    await db.upsertSkill({
      createdAt: now,
      createdBy: "bundled",
      description: "Delegate coding work",
      disableModelInvocation: false,
      enabled: true,
      hasTool: false,
      id: "skill_coding_delegation",
      name: "coding-agent",
      sourcePath: "/tmp/coding-agent",
      updatedAt: now,
    });

    const service = new ProfileService(db);
    const created = await service.createProfile(ORG_ID, { name: "Worker Bot" });

    const updated = await service.assignSkill(ORG_ID, created.profile.id, {
      skillId: "skill_coding_delegation",
    });

    expect(
      updated.profile.skills.some(
        (skill) => skill.id === "skill_coding_delegation"
      )
    ).toBe(true);
  });
});

describe("profile service knowledge base", () => {
  let tempConfigDir = "";

  afterEach(async () => {
    process.env.ATLAS_CONFIG_DIR = originalConfigDir;

    if (tempConfigDir) {
      await rm(tempConfigDir, { force: true, recursive: true });
      tempConfigDir = "";
    }
  });

  test("uploads, lists, and deletes knowledge base documents", async () => {
    tempConfigDir = await mkdtemp(path.join(os.tmpdir(), "atlas-profile-kb-"));
    process.env.ATLAS_CONFIG_DIR = tempConfigDir;

    const service = new ProfileService(createInMemoryDatabaseAdapter());
    const created = await service.createProfile(ORG_ID, { name: "KB Bot" });
    const profileId = created.profile.id;

    const uploaded = await service.uploadKnowledgeBaseDocument(
      ORG_ID,
      profileId,
      {
        data: Buffer.from("project fact", "utf8").toString("base64"),
        filename: "notes.txt",
        mediaType: "text/plain",
      }
    );

    expect(uploaded.document.status).toBe("ready");
    expect(uploaded.outcome).toBe("created");
    expect(uploaded.profileId).toBe(profileId);

    const listed = await service.listKnowledgeBase(ORG_ID, profileId);
    expect(listed.documents).toHaveLength(1);
    expect(listed.documents[0]?.filename).toBe("notes.txt");

    const deleted = await service.deleteKnowledgeBaseDocument(
      ORG_ID,
      profileId,
      uploaded.document.id
    );
    expect(deleted.deleted).toBe(true);

    const afterDelete = await service.listKnowledgeBase(ORG_ID, profileId);
    expect(afterDelete.documents).toHaveLength(0);
  });

  test("maps duplicate uploads to 409 and supports replacement", async () => {
    tempConfigDir = await mkdtemp(path.join(os.tmpdir(), "atlas-profile-kb-"));
    process.env.ATLAS_CONFIG_DIR = tempConfigDir;

    const service = new ProfileService(createInMemoryDatabaseAdapter());
    const created = await service.createProfile(ORG_ID, { name: "KB Bot" });
    const attachment = {
      data: Buffer.from("project fact", "utf8").toString("base64"),
      filename: "notes.txt",
      mediaType: "text/plain",
    };
    const first = await service.uploadKnowledgeBaseDocument(
      ORG_ID,
      created.profile.id,
      attachment
    );

    await expect(
      service.uploadKnowledgeBaseDocument(
        ORG_ID,
        created.profile.id,
        attachment
      )
    ).rejects.toMatchObject({
      knowledgeBaseDuplicate: {
        existingDocumentId: first.document.id,
        existingFilename: "notes.txt",
        match: "content_hash",
      },
      status: 409,
    });

    const replaced = await service.uploadKnowledgeBaseDocument(
      ORG_ID,
      created.profile.id,
      attachment,
      "replace"
    );
    expect(replaced.outcome).toBe("replaced");
    expect(replaced.document.id).not.toBe(first.document.id);
  });

  test("readKnowledgeBaseDocument returns preview text and download bytes", async () => {
    tempConfigDir = await mkdtemp(path.join(os.tmpdir(), "atlas-profile-kb-"));
    process.env.ATLAS_CONFIG_DIR = tempConfigDir;

    const service = new ProfileService(createInMemoryDatabaseAdapter());
    const created = await service.createProfile(ORG_ID, { name: "KB Bot" });
    const profileId = created.profile.id;

    const uploaded = await service.uploadKnowledgeBaseDocument(
      ORG_ID,
      profileId,
      {
        data: Buffer.from("project fact", "utf8").toString("base64"),
        filename: "notes.txt",
        mediaType: "text/plain",
      }
    );

    const preview = await service.readKnowledgeBaseDocument(
      ORG_ID,
      profileId,
      uploaded.document.id,
      { render: "text" }
    );
    expect(preview.contentType).toBe("text/plain");
    expect(preview.bytes.toString("utf8")).toBe("project fact");

    const download = await service.readKnowledgeBaseDocument(
      ORG_ID,
      profileId,
      uploaded.document.id
    );
    expect(download.bytes.toString("utf8")).toBe("project fact");
  });

  test("readKnowledgeBaseDocument throws for unknown document", async () => {
    tempConfigDir = await mkdtemp(path.join(os.tmpdir(), "atlas-profile-kb-"));
    process.env.ATLAS_CONFIG_DIR = tempConfigDir;

    const service = new ProfileService(createInMemoryDatabaseAdapter());
    const created = await service.createProfile(ORG_ID, { name: "KB Bot" });
    const profileId = created.profile.id;

    await expect(
      service.readKnowledgeBaseDocument(ORG_ID, profileId, "kb_nope", {
        render: "text",
      })
    ).rejects.toThrow(/not found/);
  });
});
