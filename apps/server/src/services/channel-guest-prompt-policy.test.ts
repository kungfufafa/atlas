import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import {
  getOrgMemoryFilePath,
  getProfileSoulDir,
  initSoulDirectory,
  ORG_MEMORY_PREAMBLE,
} from "@atlas/core";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { setupTestConfigDir } from "../test-config-dir";
import { AgentService } from "./agent-service";

setupTestConfigDir("atlas-channel-guest-prompt-");

const ORG_ID = "org_public_guest";
const PROFILE_ID = "profile_public_guest";
const PRIVATE_MARKERS = [
  "PRIVATE_PROFILE_MEMORY_MARKER",
  "PRIVATE_ORG_MEMORY_MARKER",
  "PRIVATE_SCOPED_MEMORY_MARKER",
  "PRIVATE_SKILL_CATALOG_MARKER",
  "PRIVATE_BROWSER_CAPABILITY_MARKER",
  "PRIVATE_KB_MARKER.txt",
];

interface PromptResolver {
  resolveProfileSystemPrompt(
    orgId: string,
    profileId: string,
    profilePrompt: string,
    orgRole: "member",
    usageContext: undefined,
    userId: string
  ): Promise<{ systemPrompt: string }>;
}

describe("channel guest public prompt policy", () => {
  test("keeps public identity while omitting every private profile context", async () => {
    const db = createInMemoryDatabaseAdapter();
    const now = new Date().toISOString();
    await db.upsertOrganization({
      createdAt: now,
      id: ORG_ID,
      name: "Public guest org",
      slug: ORG_ID,
      updatedAt: now,
    });
    await db.upsertProfile({
      createdAt: now,
      id: PROFILE_ID,
      isDefault: true,
      isSuper: false,
      model: null,
      name: "Public guest profile",
      orgId: ORG_ID,
      systemPrompt: "PUBLIC_PROFILE_PROMPT_MARKER",
      updatedAt: now,
    });

    const soulDir = getProfileSoulDir(ORG_ID, PROFILE_ID);
    await initSoulDirectory(soulDir);
    await writeFile(`${soulDir}/SOUL.md`, "PUBLIC_SOUL_MARKER", "utf8");
    await writeFile(`${soulDir}/STYLE.md`, "PUBLIC_STYLE_MARKER", "utf8");
    await writeFile(
      `${soulDir}/INSTRUCTIONS.md`,
      "PUBLIC_INSTRUCTIONS_MARKER",
      "utf8"
    );
    await writeFile(
      `${soulDir}/MEMORY.md`,
      "PRIVATE_PROFILE_MEMORY_MARKER",
      "utf8"
    );
    await writeFile(
      getOrgMemoryFilePath(ORG_ID),
      `${ORG_MEMORY_PREAMBLE}\n\n- PRIVATE_ORG_MEMORY_MARKER\n`,
      "utf8"
    );

    const service = new AgentService(null, null, db);
    await service.getMemoryService().writeMemory(ORG_ID, {
      content: "PRIVATE_SCOPED_MEMORY_MARKER",
      ownerId: ORG_ID,
      scope: "organization",
    });
    await service.uploadKnowledgeBaseDocument(ORG_ID, PROFILE_ID, {
      data: Buffer.from("private knowledge base content").toString("base64"),
      filename: "PRIVATE_KB_MARKER.txt",
      mediaType: "text/plain",
    });
    (
      service as unknown as {
        skillsService: {
          composeAgentBrowserCapabilityForProfile: () => Promise<string>;
          composeCatalogForProfile: () => Promise<string>;
        };
      }
    ).skillsService = {
      composeAgentBrowserCapabilityForProfile: async () =>
        "PRIVATE_BROWSER_CAPABILITY_MARKER",
      composeCatalogForProfile: async () => "PRIVATE_SKILL_CATALOG_MARKER",
    };

    const resolver = service as unknown as PromptResolver;
    const guest = await resolver.resolveProfileSystemPrompt(
      ORG_ID,
      PROFILE_ID,
      "PUBLIC_PROFILE_PROMPT_MARKER",
      "member",
      undefined,
      "user_channel_guest_0123456789abcdef"
    );
    const pairedMember = await resolver.resolveProfileSystemPrompt(
      ORG_ID,
      PROFILE_ID,
      "PUBLIC_PROFILE_PROMPT_MARKER",
      "member",
      undefined,
      "user_paired_member"
    );

    for (const marker of [
      "PUBLIC_SOUL_MARKER",
      "PUBLIC_STYLE_MARKER",
      "PUBLIC_INSTRUCTIONS_MARKER",
      "PUBLIC_PROFILE_PROMPT_MARKER",
    ]) {
      expect(guest.systemPrompt).toContain(marker);
    }
    for (const marker of PRIVATE_MARKERS) {
      expect(guest.systemPrompt).not.toContain(marker);
      expect(pairedMember.systemPrompt).toContain(marker);
    }
  });
});
