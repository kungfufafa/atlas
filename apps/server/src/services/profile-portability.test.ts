import { describe, expect, test } from "bun:test";
import { mkdir, readFile, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ATLAS_API_VERSION,
  getCustomToolsDir,
  getProfileSoulDir,
  initSoulDirectory,
  type ProfilePackManifest,
  pathExists,
} from "@atlas/core";
import { createInMemoryDatabaseAdapter, createSqliteDatabase } from "@atlas/db";
import { unzipSync, zipSync } from "fflate";
import { setupTestConfigDir } from "../test-config-dir";
import {
  createProfilePackExport,
  importProfilePack,
  PROFILE_PACK_MANIFEST_FILENAME,
  previewProfilePackImport,
} from "./profile-portability";

setupTestConfigDir("atlas-profile-pack-test-");

const NOW = "2026-08-26T12:00:00.000Z";

async function seedOrganization(
  db: ReturnType<typeof createInMemoryDatabaseAdapter>,
  id: string
): Promise<void> {
  await db.upsertOrganization({
    createdAt: NOW,
    id,
    name: id,
    slug: id.replaceAll("_", "-"),
    updatedAt: NOW,
  });
}

async function seedPortableProfile(
  db: ReturnType<typeof createInMemoryDatabaseAdapter>
): Promise<void> {
  await seedOrganization(db, "org_source");
  await seedOrganization(db, "org_destination");
  await db.upsertProfile({
    createdAt: NOW,
    id: "portable",
    isDefault: true,
    isSuper: false,
    model: "provider_source::model-secret",
    name: "Portable",
    orgId: "org_source",
    skillsPostTurnReview: false,
    skillsWriteApproval: false,
    systemPrompt: "Portable system prompt",
    thinkingEffort: "high",
    thinkingEnabled: true,
    updatedAt: NOW,
  });

  const soulDir = getProfileSoulDir("org_source", "portable");
  await initSoulDirectory(soulDir);
  await writeFile(join(soulDir, "SOUL.md"), "# Portable soul\n");
  await writeFile(join(soulDir, "provider-secret.env"), "API_KEY=secret\n");
  await mkdir(join(soulDir, "artifacts"), { recursive: true });
  await writeFile(join(soulDir, "artifacts", "generated.txt"), "generated");

  const toolsDir = getCustomToolsDir();
  await mkdir(toolsDir, { recursive: true });
  await writeFile(
    join(toolsDir, "echo.js"),
    "export async function run(input) { return input; }\n"
  );
  await db.upsertTool({
    createdAt: NOW,
    description: "Echo input",
    handlerConfig: {
      modulePath: "echo.js",
      parameters: {
        additionalProperties: false,
        properties: { message: { type: "string" } },
        required: ["message"],
        type: "object",
      },
      secret: "must-not-export",
    },
    handlerType: "javascript",
    id: "tool_echo",
    name: "echo",
    orgId: "org_source",
    updatedAt: NOW,
  });
  await db.assignToolToProfile("portable", "tool_echo");

  await db.upsertMcpServer({
    cachedTools: [],
    config: { apiKey: "mcp-secret" },
    createdAt: NOW,
    enabled: true,
    id: "mcp_source",
    lastError: null,
    name: "Source MCP",
    orgId: "org_source",
    status: "connected",
    transport: "http",
    updatedAt: NOW,
  });
  await db.assignMcpServerToProfile("portable", "mcp_source");
  await db.upsertComposioToolkit({
    cachedTools: [],
    createdAt: NOW,
    displayName: "GitHub",
    id: "toolkit_source",
    lastError: null,
    orgId: "org_source",
    status: "connected",
    toolkitSlug: "github",
    updatedAt: NOW,
  });
  await db.replaceProfileComposioToolkits("portable", [
    {
      allowedActions: ["create_issue"],
      profileId: "portable",
      toolkitId: "toolkit_source",
    },
  ]);
  await db.upsertComposioUserConnection({
    connectedAccountId: "account-secret",
    createdAt: NOW,
    id: "connection_source",
    lastError: null,
    oauthStateHash: "oauth-secret",
    orgId: "org_source",
    sessionIdEnc: "composio-secret",
    status: "connected",
    toolkitId: "toolkit_source",
    updatedAt: NOW,
    userId: "user_source",
  });
}

describe("profile pack portability", () => {
  test("rewrites imports into the destination tenant without secrets or privilege flags", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedPortableProfile(db);

    const exported = await createProfilePackExport(
      db,
      "org_source",
      "portable",
      { includeCustomTools: true, now: new Date(NOW) }
    );
    const archiveEntries = unzipSync(exported.data);
    expect(Object.keys(archiveEntries)).toContain("SOUL.md");
    expect(Object.keys(archiveEntries)).not.toContain("provider-secret.env");
    expect(Object.keys(archiveEntries)).not.toContain(
      "artifacts/generated.txt"
    );
    expect(exported.manifest.meta.customTools?.[0]?.handlerConfig).toEqual({
      modulePath: "echo.js",
      parameters: {
        additionalProperties: false,
        properties: { message: { type: "string" } },
        required: ["message"],
        type: "object",
      },
    });
    const serializedManifest = JSON.stringify(exported.manifest);
    for (const secret of [
      "must-not-export",
      "mcp-secret",
      "account-secret",
      "oauth-secret",
      "composio-secret",
    ]) {
      expect(serializedManifest).not.toContain(secret);
    }
    expect(exported.manifest.meta.mcpServerNames).toEqual(["Source MCP"]);
    expect(exported.manifest.version).toBe(2);
    expect(exported.manifest.meta.composioToolkitSlugs).toEqual(["github"]);
    expect(exported.manifest.meta.composioToolkitAssignments).toEqual([
      { allowedActions: ["create_issue"], toolkitSlug: "github" },
    ]);

    await db.upsertComposioToolkit({
      cachedTools: [],
      createdAt: NOW,
      displayName: "GitHub",
      id: "toolkit_destination",
      lastError: null,
      orgId: "org_destination",
      status: "enabled",
      toolkitSlug: "github",
      updatedAt: NOW,
    });

    const preview = await previewProfilePackImport(
      db,
      "org_destination",
      exported.data,
      { availableModelIds: new Set(), restoreCustomTools: true }
    );
    expect(preview.skippedAssignments).toContainEqual(
      expect.objectContaining({ path: "model:provider_source::model-secret" })
    );
    expect(preview.skippedAssignments).toContainEqual(
      expect.objectContaining({
        path: "profile setting:skills write approval",
      })
    );

    const imported = await importProfilePack(
      db,
      "org_destination",
      exported.data,
      {
        availableModelIds: new Set(),
        confirm: true,
        restoreCustomTools: true,
      }
    );
    const profile = await db.getProfile(imported.profileId);
    expect(profile).toMatchObject({
      isDefault: false,
      isSuper: false,
      model: null,
      orgId: "org_destination",
      skillsPostTurnReview: null,
      skillsWriteApproval: null,
      thinkingEffort: "high",
      thinkingEnabled: true,
    });
    expect(
      await readFile(
        join(
          getProfileSoulDir("org_destination", imported.profileId),
          "SOUL.md"
        ),
        "utf8"
      )
    ).toBe("# Portable soul\n");

    const importedTool = (
      await db.listToolsForProfile(imported.profileId)
    ).find((tool) => tool.name === "echo");
    expect(importedTool?.orgId).toBe("org_destination");
    const handlerConfig = importedTool?.handlerConfig as {
      modulePath?: string;
    };
    expect(handlerConfig.modulePath).toStartWith(
      "profile-packs/org_destination/"
    );
    expect(handlerConfig.modulePath).not.toBe("echo.js");
    expect(handlerConfig).toMatchObject({
      parameters: {
        additionalProperties: false,
        required: ["message"],
        type: "object",
      },
    });
    expect(
      await pathExists(join(getCustomToolsDir(), handlerConfig.modulePath!))
    ).toBe(true);
    expect(await db.listProfileComposioToolkits(imported.profileId)).toEqual([
      {
        allowedActions: ["create_issue"],
        profileId: imported.profileId,
        toolkitId: "toolkit_destination",
      },
    ]);
  });

  test("skips legacy slug-only Composio assignments instead of widening access", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedOrganization(db, "org_destination");
    await db.upsertComposioToolkit({
      cachedTools: [],
      createdAt: NOW,
      displayName: "GitHub",
      id: "toolkit_destination",
      lastError: null,
      orgId: "org_destination",
      status: "enabled",
      toolkitSlug: "github",
      updatedAt: NOW,
    });
    const manifest = createManifest({ composioToolkitSlugs: ["github"] });
    const archive = zipSync({
      [PROFILE_PACK_MANIFEST_FILENAME]: Buffer.from(JSON.stringify(manifest)),
    });

    const preview = await previewProfilePackImport(
      db,
      "org_destination",
      archive
    );
    expect(preview.skippedAssignments).toContainEqual(
      expect.objectContaining({
        path: "Composio toolkit:github",
        reason: expect.stringMatching(/legacy.*allowed-action/i),
      })
    );

    const imported = await importProfilePack(db, "org_destination", archive, {
      confirm: true,
    });
    expect(await db.listProfileComposioToolkits(imported.profileId)).toEqual(
      []
    );
    expect(imported.skippedAssignments).toContainEqual(
      expect.objectContaining({ path: "Composio toolkit:github" })
    );
  });

  test("skips JavaScript tools with relative imports instead of restoring broken modules", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedPortableProfile(db);
    await writeFile(
      join(getCustomToolsDir(), "echo.js"),
      'import { helper } from "./helper.js";\nexport async function run(input) { return helper(input); }\n'
    );
    await writeFile(
      join(getCustomToolsDir(), "helper.js"),
      "export const helper = (input) => input;\n"
    );

    const exported = await createProfilePackExport(
      db,
      "org_source",
      "portable",
      { includeCustomTools: true }
    );
    expect(Object.keys(unzipSync(exported.data))).not.toContain(
      "custom-tools/echo.js"
    );
    expect(exported.manifest.skipped).toContainEqual(
      expect.objectContaining({
        path: "custom tool:echo",
        reason: expect.stringMatching(/relative imports/i),
      })
    );
    await writeFile(
      join(getCustomToolsDir(), "echo.js"),
      'const helperPath = "./helper.js";\nexport async function run(input) { const { helper } = await import(helperPath); return helper(input); }\n'
    );
    const dynamicExport = await createProfilePackExport(
      db,
      "org_source",
      "portable",
      { includeCustomTools: true }
    );
    expect(Object.keys(unzipSync(dynamicExport.data))).not.toContain(
      "custom-tools/echo.js"
    );

    const preview = await previewProfilePackImport(
      db,
      "org_destination",
      exported.data,
      { restoreCustomTools: true }
    );
    expect(preview.skippedAssignments).toContainEqual(
      expect.objectContaining({
        path: "custom tool:echo",
        reason: expect.stringMatching(/missing.*source/i),
      })
    );
    const imported = await importProfilePack(
      db,
      "org_destination",
      exported.data,
      { confirm: true, restoreCustomTools: true }
    );
    expect(await db.getToolByName("echo", "org_destination")).toBeNull();
    expect(
      (await db.listToolsForProfile(imported.profileId)).map(
        (tool) => tool.name
      )
    ).not.toContain("echo");

    const directManifest = createManifest({
      customTools: [
        {
          description: "Unsafe direct tool",
          handlerConfig: { modulePath: "unsafe.js" },
          handlerType: "javascript",
          name: "unsafe-direct",
        },
      ],
      toolNames: ["unsafe-direct"],
    });
    const directArchive = zipSync({
      "custom-tools/unsafe.js": Buffer.from(
        'import { helper } from "./helper.js";\nexport async function run(input) { return helper(input); }\n'
      ),
      [PROFILE_PACK_MANIFEST_FILENAME]: Buffer.from(
        JSON.stringify(directManifest)
      ),
    });
    const directPreview = await previewProfilePackImport(
      db,
      "org_destination",
      directArchive,
      { restoreCustomTools: true }
    );
    expect(directPreview.skippedAssignments).toContainEqual(
      expect.objectContaining({
        path: "custom tool:unsafe-direct",
        reason: expect.stringMatching(/relative imports/i),
      })
    );
    const directImport = await importProfilePack(
      db,
      "org_destination",
      directArchive,
      { confirm: true, restoreCustomTools: true }
    );
    expect(
      (await db.listToolsForProfile(directImport.profileId)).map(
        (tool) => tool.name
      )
    ).not.toContain("unsafe-direct");
  });

  test("skips custom tools with non-JSON-safe parameter schemas", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedPortableProfile(db);
    const circularSchema: Record<string, unknown> = { type: "object" };
    circularSchema.self = circularSchema;
    const sourceTool = await db.getToolByName("echo", "org_source");
    expect(sourceTool).not.toBeNull();
    await db.upsertTool({
      ...sourceTool!,
      handlerConfig: {
        modulePath: "echo.js",
        parameters: circularSchema,
      },
    });

    const exported = await createProfilePackExport(
      db,
      "org_source",
      "portable",
      { includeCustomTools: true }
    );
    expect(Object.keys(unzipSync(exported.data))).not.toContain(
      "custom-tools/echo.js"
    );
    expect(exported.manifest.skipped).toContainEqual(
      expect.objectContaining({
        path: "custom tool:echo",
        reason: expect.stringMatching(/parameters/i),
      })
    );
  });

  test("treats custom tool metadata and parameter schema mismatches as collisions", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedOrganization(db, "org_destination");
    const toolsDir = getCustomToolsDir();
    await mkdir(toolsDir, { recursive: true });
    const source = "export async function run(input) { return input; }\n";
    const packedParameters = {
      additionalProperties: false,
      properties: { message: { type: "string" } },
      required: ["message"],
      type: "object",
    } as const;
    for (const tool of [
      {
        description: "Schema tool",
        handlerConfig: {
          modulePath: "schema-existing.js",
          parameters: { type: "object" },
        },
        id: "tool_schema",
        name: "schema-tool",
      },
      {
        description: "Different description",
        handlerConfig: {
          modulePath: "description-existing.js",
          parameters: packedParameters,
        },
        id: "tool_description",
        name: "description-tool",
      },
    ]) {
      await writeFile(join(toolsDir, tool.handlerConfig.modulePath), source);
      await db.upsertTool({
        createdAt: NOW,
        description: tool.description,
        handlerConfig: tool.handlerConfig,
        handlerType: "javascript",
        id: tool.id,
        name: tool.name,
        orgId: "org_destination",
        updatedAt: NOW,
      });
    }
    const manifest = createManifest({
      customTools: [
        {
          description: "Schema tool",
          handlerConfig: {
            modulePath: "schema-tool.js",
            parameters: packedParameters,
          },
          handlerType: "javascript",
          name: "schema-tool",
        },
        {
          description: "Packed description",
          handlerConfig: {
            modulePath: "description-tool.js",
            parameters: packedParameters,
          },
          handlerType: "javascript",
          name: "description-tool",
        },
      ],
      toolNames: ["schema-tool", "description-tool"],
    });
    const archive = zipSync({
      "custom-tools/description-tool.js": Buffer.from(source),
      "custom-tools/schema-tool.js": Buffer.from(source),
      [PROFILE_PACK_MANIFEST_FILENAME]: Buffer.from(JSON.stringify(manifest)),
    });

    const preview = await previewProfilePackImport(
      db,
      "org_destination",
      archive,
      { restoreCustomTools: true }
    );
    expect(
      preview.skippedAssignments.filter((item) =>
        item.reason.includes("conflicts")
      )
    ).toHaveLength(2);
    const imported = await importProfilePack(db, "org_destination", archive, {
      confirm: true,
      restoreCustomTools: true,
    });
    expect(await db.listToolsForProfile(imported.profileId)).toEqual([]);
  });

  test("revalidates an existing custom tool snapshot inside atomic publication", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedOrganization(db, "org_destination");
    const source = "export async function run(input) { return input; }\n";
    await mkdir(getCustomToolsDir(), { recursive: true });
    await writeFile(join(getCustomToolsDir(), "existing.js"), source);
    const existingTool = {
      createdAt: NOW,
      description: "Stable tool",
      handlerConfig: {
        modulePath: "existing.js",
        parameters: { type: "object" },
      },
      handlerType: "javascript",
      id: "tool_existing",
      name: "stable-tool",
      orgId: "org_destination",
      updatedAt: NOW,
    } as const;
    await db.upsertTool(existingTool);
    const manifest = createManifest({
      customTools: [
        {
          description: existingTool.description,
          handlerConfig: {
            modulePath: "stable-tool.js",
            parameters: { type: "object" },
          },
          handlerType: "javascript",
          name: existingTool.name,
        },
      ],
      toolNames: [existingTool.name],
    });
    const archive = zipSync({
      "custom-tools/stable-tool.js": Buffer.from(source),
      [PROFILE_PACK_MANIFEST_FILENAME]: Buffer.from(JSON.stringify(manifest)),
    });
    const racingDb = {
      ...db,
      publishProfileImport: async (
        publication: Parameters<typeof db.publishProfileImport>[0]
      ) => {
        await db.upsertTool({
          ...existingTool,
          description: "Changed after preflight",
        });
        return db.publishProfileImport(publication);
      },
    };

    await expect(
      importProfilePack(racingDb, "org_destination", archive, {
        confirm: true,
        restoreCustomTools: true,
      })
    ).rejects.toMatchObject({ status: 409 });
    expect(await db.getProfile("imported")).toBeNull();
  });

  test("rejects duplicate custom tool names and module paths in a manifest", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedOrganization(db, "org_destination");
    const definitions = [
      [
        {
          description: "One",
          handlerConfig: { modulePath: "one.js" },
          handlerType: "javascript" as const,
          name: "duplicate",
        },
        {
          description: "Two",
          handlerConfig: { modulePath: "two.js" },
          handlerType: "javascript" as const,
          name: "DUPLICATE",
        },
      ],
      [
        {
          description: "One",
          handlerConfig: { modulePath: "shared.js" },
          handlerType: "javascript" as const,
          name: "one",
        },
        {
          description: "Two",
          handlerConfig: { modulePath: "SHARED.js" },
          handlerType: "javascript" as const,
          name: "two",
        },
      ],
    ];

    for (const customTools of definitions) {
      const archive = zipSync({
        [PROFILE_PACK_MANIFEST_FILENAME]: Buffer.from(
          JSON.stringify(createManifest({ customTools }))
        ),
      });
      await expect(
        previewProfilePackImport(db, "org_destination", archive)
      ).rejects.toMatchObject({ status: 400 });
    }

    const invalidSchemaManifest = createManifest({
      customTools: [
        {
          description: "Invalid schema",
          handlerConfig: {
            modulePath: "invalid.js",
            parameters: [] as unknown as NonNullable<
              ProfilePackManifest["meta"]["customTools"]
            >[number]["handlerConfig"]["parameters"],
          },
          handlerType: "javascript",
          name: "invalid-schema",
        },
      ],
      toolNames: ["invalid-schema"],
    });
    const invalidSchemaArchive = zipSync({
      "custom-tools/invalid.js": Buffer.from(
        "export async function run() { return true; }\n"
      ),
      [PROFILE_PACK_MANIFEST_FILENAME]: Buffer.from(
        JSON.stringify(invalidSchemaManifest)
      ),
    });
    await expect(
      previewProfilePackImport(db, "org_destination", invalidSchemaArchive)
    ).rejects.toMatchObject({ status: 400 });
  });

  test("publishes a packed skill and custom tool atomically with SQLite", async () => {
    const database = await createSqliteDatabase(":memory:");
    const db = database.adapter;
    try {
      await db.upsertOrganization({
        createdAt: NOW,
        id: "org_destination",
        name: "Destination",
        slug: "destination",
        updatedAt: NOW,
      });
      const manifest = createManifest({
        customTools: [
          {
            description: "SQLite tool",
            handlerConfig: { modulePath: "sqlite-tool.js" },
            handlerType: "javascript",
            name: "sqlite-tool",
          },
        ],
        profileSkillNames: ["sqlite-skill"],
        toolNames: ["sqlite-tool"],
      });
      const archive = zipSync({
        "custom-tools/sqlite-tool.js": Buffer.from(
          "export async function run() { return true; }\n"
        ),
        [PROFILE_PACK_MANIFEST_FILENAME]: Buffer.from(JSON.stringify(manifest)),
        "skills/sqlite/SKILL.md": Buffer.from(
          "---\nname: sqlite-skill\ndescription: SQLite skill\n---\n\n# SQLite\n"
        ),
      });

      const imported = await importProfilePack(db, "org_destination", archive, {
        confirm: true,
        restoreCustomTools: true,
      });
      expect(
        (await db.listToolsForProfile(imported.profileId)).map(
          (tool) => tool.name
        )
      ).toEqual(["sqlite-tool"]);
      expect(
        (await db.listSkillsForProfile(imported.profileId)).map(
          (skill) => skill.name
        )
      ).toEqual(["sqlite-skill"]);
    } finally {
      database.close();
    }
  });

  test("rejects oversized sparse workspace and custom-tool files before reading them", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedPortableProfile(db);
    const soulDir = getProfileSoulDir("org_source", "portable");
    const oversizedKnowledge = join(soulDir, "knowledge-base", "oversized.md");
    await mkdir(join(soulDir, "knowledge-base"), { recursive: true });
    await writeFile(oversizedKnowledge, "");
    await truncate(oversizedKnowledge, 26 * 1024 * 1024);

    await expect(
      createProfilePackExport(db, "org_source", "portable")
    ).rejects.toMatchObject({ status: 413 });

    await truncate(oversizedKnowledge, 0);
    const oversizedTool = join(getCustomToolsDir(), "echo.js");
    await truncate(oversizedTool, 26 * 1024 * 1024);
    await expect(
      createProfilePackExport(db, "org_source", "portable", {
        includeCustomTools: true,
      })
    ).rejects.toMatchObject({ status: 413 });
    await writeFile(
      oversizedTool,
      "export async function run(input) { return input; }\n"
    );
  });

  test("rechecks a profile file that grows after inventory", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedPortableProfile(db);
    const avatarPath = join(
      getProfileSoulDir("org_source", "portable"),
      "avatar.png"
    );
    await writeFile(avatarPath, "small");
    let grewFile = false;
    const growingDb = {
      ...db,
      listToolsForProfile: async (profileId: string) => {
        if (!grewFile) {
          grewFile = true;
          await truncate(avatarPath, 26 * 1024 * 1024);
        }
        return db.listToolsForProfile(profileId);
      },
    };

    await expect(
      createProfilePackExport(growingDb, "org_source", "portable")
    ).rejects.toMatchObject({ status: 413 });
    await truncate(avatarPath, 0);
  });

  test("atomically retries when another organization claims the profile id", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedOrganization(db, "org_destination");
    await seedOrganization(db, "org_rival");
    const archive = zipSync({
      [PROFILE_PACK_MANIFEST_FILENAME]: Buffer.from(
        JSON.stringify(createManifest())
      ),
    });
    let releaseFirstAttempt: (() => void) | undefined;
    const firstAttemptReleased = new Promise<void>((resolve) => {
      releaseFirstAttempt = resolve;
    });
    let announceFirstAttempt: (() => void) | undefined;
    const firstAttemptStarted = new Promise<void>((resolve) => {
      announceFirstAttempt = resolve;
    });
    let heldFirstAttempt = false;
    const racingDb = {
      ...db,
      reserveProfileImport: async (
        profile: Parameters<typeof db.reserveProfileImport>[0]
      ) => {
        if (
          !heldFirstAttempt &&
          profile.id === "imported" &&
          profile.orgId === "org_destination"
        ) {
          heldFirstAttempt = true;
          announceFirstAttempt?.();
          await firstAttemptReleased;
        }
        return db.reserveProfileImport(profile);
      },
    };

    const importing = importProfilePack(racingDb, "org_destination", archive, {
      confirm: true,
    });
    await firstAttemptStarted;
    expect(
      await db.createProfileIfAbsent({
        createdAt: NOW,
        id: "imported",
        isDefault: false,
        isSuper: false,
        model: null,
        name: "Rival profile",
        orgId: "org_rival",
        systemPrompt: "Do not overwrite",
        updatedAt: NOW,
      })
    ).toBe(true);
    releaseFirstAttempt?.();

    const imported = await importing;
    expect(imported.profileId).toBe("imported-2");
    expect(await db.getProfile("imported")).toMatchObject({
      orgId: "org_rival",
      systemPrompt: "Do not overwrite",
    });
    expect(await db.getProfile("imported-2")).toMatchObject({
      orgId: "org_destination",
    });
  });

  test("admits different organizations concurrently and rejects overlap in one organization", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedOrganization(db, "org_destination");
    await seedOrganization(db, "org_rival");
    const archive = zipSync({
      [PROFILE_PACK_MANIFEST_FILENAME]: Buffer.from(
        JSON.stringify(createManifest())
      ),
    });
    let announcePublish: (() => void) | undefined;
    const publishStarted = new Promise<void>((resolve) => {
      announcePublish = resolve;
    });
    let releasePublish: (() => void) | undefined;
    const publishReleased = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    const gatedDb = {
      ...db,
      publishProfileImport: async (
        publication: Parameters<typeof db.publishProfileImport>[0]
      ) => {
        if (publication.orgId === "org_destination") {
          announcePublish?.();
          await publishReleased;
        }
        return db.publishProfileImport(publication);
      },
    };

    const first = importProfilePack(gatedDb, "org_destination", archive, {
      confirm: true,
    });
    await publishStarted;
    await expect(
      previewProfilePackImport(gatedDb, "org_destination", archive)
    ).rejects.toMatchObject({ status: 429 });
    const rival = await importProfilePack(gatedDb, "org_rival", archive, {
      confirm: true,
    });
    expect(rival.profileId).toBe("imported-2");
    releasePublish?.();
    await expect(first).resolves.toMatchObject({ profileId: "imported" });
  });

  test("keeps export inside the same per-organization admission gate", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedPortableProfile(db);
    let announceLookup = () => {};
    const lookupStarted = new Promise<void>((resolve) => {
      announceLookup = resolve;
    });
    let releaseLookup = () => {};
    const lookupReleased = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const gatedDb = {
      ...db,
      getProfileForOrg: async (profileId: string, orgId: string) => {
        announceLookup();
        await lookupReleased;
        return db.getProfileForOrg(profileId, orgId);
      },
    };

    const exporting = createProfilePackExport(
      gatedDb,
      "org_source",
      "portable"
    );
    await lookupStarted;
    const archive = zipSync({
      [PROFILE_PACK_MANIFEST_FILENAME]: Buffer.from(
        JSON.stringify(createManifest())
      ),
    });
    await expect(
      previewProfilePackImport(gatedDb, "org_source", archive)
    ).rejects.toMatchObject({ status: 429 });
    releaseLookup();
    await expect(exporting).resolves.toMatchObject({
      filename: expect.stringMatching(/^atlas-profile-export-/),
    });
  });

  test("keeps staged profile data hidden until the atomic publication", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedOrganization(db, "org_destination");
    const manifest = createManifest({
      customTools: [
        {
          description: "Atomic tool",
          handlerConfig: { modulePath: "atomic-tool.js" },
          handlerType: "javascript",
          name: "atomic-tool",
        },
      ],
      profileSkillNames: ["atomic-skill"],
      toolNames: ["atomic-tool"],
    });
    const archive = zipSync({
      "custom-tools/atomic-tool.js": Buffer.from(
        "export async function run() { return true; }\n"
      ),
      "SOUL.md": Buffer.from("# Ready before publication\n"),
      [PROFILE_PACK_MANIFEST_FILENAME]: Buffer.from(JSON.stringify(manifest)),
      "skills/atomic/SKILL.md": Buffer.from(
        "---\nname: atomic-skill\ndescription: Atomic skill\n---\n\n# Atomic\n"
      ),
    });
    let announcePublish: (() => void) | undefined;
    const publishStarted = new Promise<void>((resolve) => {
      announcePublish = resolve;
    });
    let releasePublish: (() => void) | undefined;
    const publishReleased = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    const gatedDb = {
      ...db,
      publishProfileImport: async (
        publication: Parameters<typeof db.publishProfileImport>[0]
      ) => {
        announcePublish?.();
        await publishReleased;
        return db.publishProfileImport(publication);
      },
    };

    const importing = importProfilePack(gatedDb, "org_destination", archive, {
      confirm: true,
      restoreCustomTools: true,
    });
    await publishStarted;
    expect(await db.getProfile("imported")).toBeNull();
    expect(await db.listProfilesForOrg("org_destination")).toEqual([]);
    expect(await db.getToolByName("atomic-tool", "org_destination")).toBeNull();
    expect(
      await db.getSkillByName("atomic-skill", "org_destination")
    ).toBeNull();
    expect(
      await pathExists(getProfileSoulDir("org_destination", "imported"))
    ).toBe(true);

    releasePublish?.();
    const imported = await importing;
    expect(await db.getProfile(imported.profileId)).not.toBeNull();
    expect(
      (await db.listToolsForProfile(imported.profileId)).map(
        (tool) => tool.name
      )
    ).toContain("atomic-tool");
    expect(
      (await db.listSkillsForProfile(imported.profileId)).map(
        (skill) => skill.name
      )
    ).toContain("atomic-skill");
  });

  test("aborts publication when the organization is archived during import", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedOrganization(db, "org_destination");
    await seedOrganization(db, "org_rival");
    const archive = zipSync({
      [PROFILE_PACK_MANIFEST_FILENAME]: Buffer.from(
        JSON.stringify(createManifest())
      ),
    });
    let announcePublish: (() => void) | undefined;
    const publishStarted = new Promise<void>((resolve) => {
      announcePublish = resolve;
    });
    let releasePublish: (() => void) | undefined;
    const publishReleased = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    const gatedDb = {
      ...db,
      publishProfileImport: async (
        publication: Parameters<typeof db.publishProfileImport>[0]
      ) => {
        announcePublish?.();
        await publishReleased;
        return db.publishProfileImport(publication);
      },
    };

    const importing = importProfilePack(gatedDb, "org_destination", archive, {
      confirm: true,
    });
    await publishStarted;
    expect(await db.tryMarkOrganizationArchived("org_destination", NOW)).toBe(
      true
    );
    releasePublish?.();
    await expect(importing).rejects.toMatchObject({ status: 404 });
    expect(await db.getProfile("imported")).toBeNull();
    expect(
      await pathExists(getProfileSoulDir("org_destination", "imported"))
    ).toBe(false);
  });

  test("enforces source organization ownership and rejects Super Agent export", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedPortableProfile(db);

    await expect(
      createProfilePackExport(db, "org_destination", "portable")
    ).rejects.toMatchObject({ status: 404 });

    await db.upsertProfile({
      createdAt: NOW,
      id: "super-agent",
      isSuper: true,
      model: null,
      name: "Super Agent",
      orgId: "org_source",
      systemPrompt: "",
      updatedAt: NOW,
    });
    await expect(
      createProfilePackExport(db, "org_source", "super-agent")
    ).rejects.toMatchObject({ status: 400 });
  });

  test("preview rejects traversal, case collisions, and Unix symlink entries", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedOrganization(db, "org_destination");
    const manifest = createManifest();

    const traversal = zipSync({
      "../outside.txt": Buffer.from("escape"),
      [PROFILE_PACK_MANIFEST_FILENAME]: Buffer.from(JSON.stringify(manifest)),
    });
    await expect(
      previewProfilePackImport(db, "org_destination", traversal)
    ).rejects.toThrow(/escapes|relative/i);

    const collision = zipSync({
      "SOUL.md": Buffer.from("one"),
      "soul.md": Buffer.from("two"),
      [PROFILE_PACK_MANIFEST_FILENAME]: Buffer.from(JSON.stringify(manifest)),
    });
    await expect(
      previewProfilePackImport(db, "org_destination", collision)
    ).rejects.toThrow(/colliding/i);

    const unicodeCollision = zipSync({
      "knowledge-base/cafe\u0301.txt": Buffer.from("two"),
      "knowledge-base/café.txt": Buffer.from("one"),
      [PROFILE_PACK_MANIFEST_FILENAME]: Buffer.from(JSON.stringify(manifest)),
    });
    await expect(
      previewProfilePackImport(db, "org_destination", unicodeCollision)
    ).rejects.toThrow(/colliding/i);

    const duplicate = Buffer.from(
      zipSync({
        "A.txt": Buffer.from("one"),
        "B.txt": Buffer.from("two"),
        [PROFILE_PACK_MANIFEST_FILENAME]: Buffer.from(JSON.stringify(manifest)),
      })
    );
    replaceAllBytes(duplicate, "B.txt", "A.txt");
    await expect(
      previewProfilePackImport(db, "org_destination", duplicate)
    ).rejects.toThrow(/duplicate|colliding/i);

    const symlink = zipSync({
      "SOUL.md": [Buffer.from("target"), { attrs: 0o12_0777 * 65_536, os: 3 }],
      [PROFILE_PACK_MANIFEST_FILENAME]: Buffer.from(JSON.stringify(manifest)),
    });
    await expect(
      previewProfilePackImport(db, "org_destination", symlink)
    ).rejects.toThrow(/links|special/i);
  });

  test("accepts safe explicit directories but rejects ambiguous pack roots", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedOrganization(db, "org_destination");
    const manifest = createManifest();
    const withDirectory = zipSync({
      "knowledge-base/": [Buffer.alloc(0), { attrs: 0o4_0755 * 65_536, os: 3 }],
      "knowledge-base/guide.md": Buffer.from("# Guide\n"),
      [PROFILE_PACK_MANIFEST_FILENAME]: Buffer.from(JSON.stringify(manifest)),
    });
    await expect(
      previewProfilePackImport(db, "org_destination", withDirectory)
    ).resolves.toMatchObject({ archiveFileCount: 1 });

    const fileDirectoryCollision = zipSync({
      "skills/conflict": Buffer.from("file"),
      "skills/conflict/SKILL.md": Buffer.from(
        "---\nname: nested\ndescription: Nested\n---\n"
      ),
      [PROFILE_PACK_MANIFEST_FILENAME]: Buffer.from(JSON.stringify(manifest)),
    });
    await expect(
      previewProfilePackImport(db, "org_destination", fileDirectoryCollision)
    ).rejects.toThrow(/both a file and a directory/i);

    const multipleManifests = zipSync({
      "atlas-profile-export.json": Buffer.from(JSON.stringify(manifest)),
      "nakama-profile-export.json": Buffer.from(
        JSON.stringify({ ...manifest, kind: "nakama-profile-export" })
      ),
    });
    await expect(
      previewProfilePackImport(db, "org_destination", multipleManifests)
    ).rejects.toThrow(/multiple.*manifest/i);

    const multipleAvatars = zipSync({
      "avatar.jpg": Buffer.from("one"),
      "avatar.png": Buffer.from("two"),
      [PROFILE_PACK_MANIFEST_FILENAME]: Buffer.from(JSON.stringify(manifest)),
    });
    await expect(
      previewProfilePackImport(db, "org_destination", multipleAvatars)
    ).rejects.toThrow(/multiple.*avatar/i);
  });

  test("rejects a declared zip bomb before inflating its entry", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedOrganization(db, "org_destination");
    const archive = Buffer.from(
      zipSync({
        "SOUL.md": Buffer.from("small"),
        [PROFILE_PACK_MANIFEST_FILENAME]: Buffer.from(
          JSON.stringify(createManifest())
        ),
      })
    );
    const centralOffset = archive.indexOf(
      Buffer.from([0x50, 0x4b, 0x01, 0x02])
    );
    expect(centralOffset).toBeGreaterThanOrEqual(0);
    archive.writeUInt32LE(26 * 1024 * 1024, centralOffset + 24);

    await expect(
      previewProfilePackImport(db, "org_destination", archive)
    ).rejects.toMatchObject({ status: 413 });
  });

  test("bounds emitted inflate bytes when ZIP headers understate actual output", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedOrganization(db, "org_destination");
    const archive = Buffer.from(
      zipSync({
        "SOUL.md": Buffer.alloc(2 * 1024 * 1024, 65),
        [PROFILE_PACK_MANIFEST_FILENAME]: Buffer.from(
          JSON.stringify(createManifest())
        ),
      })
    );
    const centralOffset = findCentralEntryOffset(archive, "SOUL.md");
    const localOffset = archive.readUInt32LE(centralOffset + 42);
    archive.writeUInt32LE(16, centralOffset + 24);
    archive.writeUInt32LE(16, localOffset + 22);

    await expect(
      previewProfilePackImport(db, "org_destination", archive)
    ).rejects.toThrow(/expands beyond its declared size/i);
  });

  test("rolls back the profile and workspace when custom tool validation fails", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedOrganization(db, "org_destination");
    const manifest = createManifest({
      customTools: [
        {
          description: "Broken tool",
          handlerConfig: { modulePath: "broken.js" },
          handlerType: "javascript",
          name: "broken",
        },
      ],
      toolNames: ["broken"],
    });
    const archive = zipSync({
      "custom-tools/broken.js": Buffer.from("export function run( {"),
      [PROFILE_PACK_MANIFEST_FILENAME]: Buffer.from(JSON.stringify(manifest)),
    });

    await expect(
      importProfilePack(db, "org_destination", archive, {
        confirm: true,
        restoreCustomTools: true,
      })
    ).rejects.toThrow(/valid JavaScript/i);
    expect(await db.getProfile("imported")).toBeNull();
    expect(
      await pathExists(getProfileSoulDir("org_destination", "imported"))
    ).toBe(false);
  });

  test("rolls back an imported profile with corrupt avatar pixels", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedOrganization(db, "org_destination");
    const corruptAvatar = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVSH2mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    );
    const archive = zipSync({
      "avatar.png": corruptAvatar,
      [PROFILE_PACK_MANIFEST_FILENAME]: Buffer.from(
        JSON.stringify(createManifest())
      ),
    });

    await expect(
      importProfilePack(db, "org_destination", archive, { confirm: true })
    ).rejects.toMatchObject({ status: 400 });
    expect(await db.getProfile("imported")).toBeNull();
    expect(
      await pathExists(getProfileSoulDir("org_destination", "imported"))
    ).toBe(false);
  });

  test("keeps staged JavaScript inactive when a later database step fails", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedOrganization(db, "org_destination");
    await db.upsertMcpServer({
      cachedTools: [],
      config: {},
      createdAt: NOW,
      enabled: true,
      id: "mcp_destination",
      lastError: null,
      name: "Destination MCP",
      orgId: "org_destination",
      status: "connected",
      transport: "http",
      updatedAt: NOW,
    });
    let importedModulePath: string | null = null;
    const failingDb = {
      ...db,
      publishProfileImport: async (
        publication: Parameters<typeof db.publishProfileImport>[0]
      ) => {
        const importedTool = publication.newTools.find(
          (tool) => tool.name === "staged-code"
        );
        importedModulePath = importedTool
          ? (importedTool.handlerConfig as { modulePath: string }).modulePath
          : null;
        throw new Error("injected assignment failure");
      },
    };
    const manifest = createManifest({
      customTools: [
        {
          description: "Staged code",
          handlerConfig: { modulePath: "staged-code.js" },
          handlerType: "javascript",
          name: "staged-code",
        },
      ],
      mcpServerNames: ["Destination MCP"],
      toolNames: ["staged-code"],
    });
    const archive = zipSync({
      "custom-tools/staged-code.js": Buffer.from(
        'export async function run() { return "ok"; }\n'
      ),
      [PROFILE_PACK_MANIFEST_FILENAME]: Buffer.from(JSON.stringify(manifest)),
    });

    await expect(
      importProfilePack(failingDb, "org_destination", archive, {
        confirm: true,
        restoreCustomTools: true,
      })
    ).rejects.toThrow(/injected assignment failure/i);
    expect(importedModulePath).not.toBeNull();
    expect(await db.getProfile("imported")).toBeNull();
    expect(await db.getToolByName("staged-code", "org_destination")).toBeNull();
    expect(
      await pathExists(join(getCustomToolsDir(), importedModulePath!))
    ).toBe(false);
  });

  test("surfaces incomplete compensating rollback", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedOrganization(db, "org_destination");
    await db.upsertMcpServer({
      cachedTools: [],
      config: {},
      createdAt: NOW,
      enabled: true,
      id: "mcp_destination",
      lastError: null,
      name: "Destination MCP",
      orgId: "org_destination",
      status: "connected",
      transport: "http",
      updatedAt: NOW,
    });
    const failingDb = {
      ...db,
      deleteProfileImportReservation: async () => false,
      publishProfileImport: async () => {
        throw new Error("injected assignment failure");
      },
    };
    const manifest = createManifest({
      mcpServerNames: ["Destination MCP"],
    });
    const archive = zipSync({
      [PROFILE_PACK_MANIFEST_FILENAME]: Buffer.from(JSON.stringify(manifest)),
    });

    await expect(
      importProfilePack(failingDb, "org_destination", archive, {
        confirm: true,
      })
    ).rejects.toMatchObject({
      message: expect.stringMatching(/rollback was incomplete/i),
      status: 500,
    });
  });
});

function createManifest(
  overrides: Partial<ProfilePackManifest["meta"]> = {}
): ProfilePackManifest {
  return {
    apiVersion: ATLAS_API_VERSION,
    createdAt: NOW,
    kind: "atlas-profile-export",
    meta: {
      bundledSkillNames: [],
      composioToolkitSlugs: [],
      mcpServerNames: [],
      model: null,
      name: "Imported",
      profileSkillNames: [],
      skillsPostTurnReview: null,
      skillsWriteApproval: null,
      systemPrompt: "",
      thinkingEffort: null,
      thinkingEnabled: null,
      toolNames: [],
      ...overrides,
    },
    skipped: [],
    sourceProfileId: "source",
    topLevelPaths: [],
    version: 1,
  };
}

function replaceAllBytes(
  data: Buffer,
  searchText: string,
  replacementText: string
): void {
  const search = Buffer.from(searchText);
  const replacement = Buffer.from(replacementText);
  expect(replacement.length).toBe(search.length);
  let offset = data.indexOf(search);
  while (offset >= 0) {
    replacement.copy(data, offset);
    offset = data.indexOf(search, offset + replacement.length);
  }
}

function findCentralEntryOffset(archive: Buffer, name: string): number {
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  let offset = archive.indexOf(signature);
  while (offset >= 0) {
    const filenameLength = archive.readUInt16LE(offset + 28);
    const filename = archive
      .subarray(offset + 46, offset + 46 + filenameLength)
      .toString("utf8");
    if (filename === name) {
      return offset;
    }
    offset = archive.indexOf(signature, offset + 46 + filenameLength);
  }
  throw new Error(`Central ZIP entry not found: ${name}`);
}
