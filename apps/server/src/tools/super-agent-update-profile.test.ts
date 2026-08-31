import { describe, expect, test } from "bun:test";
import type { ProfileResponse, UpdateProfileRequest } from "@atlas/core";
import type { ProfileService } from "../services/profile-service";
import {
  PROFILE_UPDATE_CANCELLED_MESSAGE,
  PROFILE_UPDATE_CONFIRMATION_MESSAGE,
  SuperAgentSessionState,
} from "../services/super-agent-session-state";
import { createSuperAgentTools } from "./super-agent-tools";

const ORG_ID = "org_update";
const PROFILE_ID = "support";
const SESSION_ID = "session_update";
const USER_ID = "user_admin";

function responseFor(
  profileId: string,
  request: UpdateProfileRequest
): ProfileResponse {
  return {
    profile: {
      createdAt: "2026-01-01T00:00:00.000Z",
      hasAvatar: false,
      id: profileId,
      isDefault: false,
      isSuper: false,
      mcpServerCount: 0,
      mcpServers: [],
      model: request.model ?? null,
      name: request.name ?? "Support",
      skills: [],
      skillsPostTurnReview: request.skillsPostTurnReview ?? null,
      skillsWriteApproval: request.skillsWriteApproval ?? null,
      soulActive: Boolean(request.soulFiles),
      systemPrompt: request.systemPrompt ?? "",
      toolCount: 0,
      tools: [],
      updatedAt: "2026-01-01T00:01:00.000Z",
    },
  };
}

function buildHarness(options?: { now?: () => number; ttl?: number }) {
  const calls: Array<{
    actor: { userId: string };
    changeMeta?: { actorUserId?: string | null; source: string };
    orgId: string;
    profileId: string;
    request: UpdateProfileRequest;
  }> = [];
  const invalidatedProfileIds: string[] = [];
  const state = new SuperAgentSessionState({
    confirmationTtlMs: options?.ttl,
    now: options?.now,
  });
  state.beginTurn(SESSION_ID);
  const service = {
    async updateProfileAsActor(
      orgId: string,
      profileId: string,
      request: UpdateProfileRequest,
      actor: { userId: string },
      changeMeta?: { actorUserId?: string | null; source: string }
    ): Promise<ProfileResponse> {
      calls.push({ actor, changeMeta, orgId, profileId, request });
      return responseFor(profileId, request);
    },
  } as ProfileService;
  const tool = createSuperAgentTools(service, state, {
    onProfileUpdated: (profileId) => invalidatedProfileIds.push(profileId),
  }).find((candidate) => candidate.name === "update_profile");

  if (!tool) {
    throw new Error("update_profile was not registered");
  }

  return { calls, invalidatedProfileIds, state, tool };
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    orgId: ORG_ID,
    orgRole: "admin" as const,
    sessionId: SESSION_ID,
    userId: USER_ID,
    ...overrides,
  };
}

describe("Super Agent update_profile confirmation", () => {
  test("requires an identical draft in a later turn and consumes it once", async () => {
    const { calls, invalidatedProfileIds, state, tool } = buildHarness();
    const draft = {
      name: "Customer Support",
      profileId: PROFILE_ID,
      soulFiles: { "SOUL.md": "# Support\n\nSolve customer issues." },
      systemPrompt: "Handle requests safely.",
    };

    await expect(tool.run(draft, context())).resolves.toEqual({
      message: PROFILE_UPDATE_CONFIRMATION_MESSAGE,
      outcome: "needs_confirmation",
    });
    await expect(tool.run(draft, context())).resolves.toMatchObject({
      outcome: "needs_confirmation",
    });
    expect(calls).toHaveLength(0);

    state.beginTurn(SESSION_ID, "Confirm these changes");
    await expect(tool.run(draft, context())).resolves.toMatchObject({
      profile: { id: PROFILE_ID, name: "Customer Support" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.changeMeta).toEqual({
      actorUserId: USER_ID,
      source: "super_bot",
    });
    expect(invalidatedProfileIds).toEqual([PROFILE_ID]);

    await expect(tool.run(draft, context())).resolves.toMatchObject({
      outcome: "needs_confirmation",
    });
    expect(calls).toHaveLength(1);
    expect(invalidatedProfileIds).toEqual([PROFILE_ID]);
  });

  test("tampering with fields, target, actor, or org invalidates confirmation", async () => {
    const cases = [
      {
        changedContext: context(),
        changedDraft: { profileId: PROFILE_ID, systemPrompt: "Changed" },
      },
      {
        changedContext: context(),
        changedDraft: { profileId: "other", systemPrompt: "Original" },
      },
      {
        changedContext: context({ userId: "user_other" }),
        changedDraft: { profileId: PROFILE_ID, systemPrompt: "Original" },
      },
      {
        changedContext: context({ orgId: "org_other" }),
        changedDraft: { profileId: PROFILE_ID, systemPrompt: "Original" },
      },
    ];

    for (const { changedContext, changedDraft } of cases) {
      const { calls, state, tool } = buildHarness();
      await tool.run(
        { profileId: PROFILE_ID, systemPrompt: "Original" },
        context()
      );
      state.beginTurn(SESSION_ID, "Confirm these changes");

      await expect(
        tool.run(changedDraft, changedContext)
      ).resolves.toMatchObject({ outcome: "needs_confirmation" });
      expect(calls).toHaveLength(0);
    }
  });

  test("expires confirmation and accepts canonical soul-key ordering", async () => {
    let now = 1000;
    const expired = buildHarness({ now: () => now, ttl: 100 });
    const draft = { profileId: PROFILE_ID, systemPrompt: "Prompt" };
    await expired.tool.run(draft, context());
    expired.state.beginTurn(SESSION_ID, "Confirm these changes");
    now = 1101;
    await expect(expired.tool.run(draft, context())).resolves.toMatchObject({
      outcome: "needs_confirmation",
    });
    expect(expired.calls).toHaveLength(0);

    const canonical = buildHarness();
    await canonical.tool.run(
      {
        profileId: PROFILE_ID,
        soulFiles: { "SOUL.md": "Soul", "STYLE.md": "Style" },
      },
      context()
    );
    canonical.state.beginTurn(SESSION_ID, "Confirm these changes");
    const reorderedSoulFiles = Object.fromEntries([
      ["STYLE.md", "Style"],
      ["SOUL.md", "Soul"],
    ]);
    await canonical.tool.run(
      {
        profileId: PROFILE_ID,
        soulFiles: reorderedSoulFiles,
      },
      context()
    );
    expect(canonical.calls).toHaveLength(1);
  });

  test("passes only the allowlisted stored and governance fields", async () => {
    const { calls, state, tool } = buildHarness();
    const draft = {
      model: null,
      name: "Support",
      profileId: PROFILE_ID,
      skillsPostTurnReview: true,
      skillsWriteApproval: null,
      soulFiles: {
        "INSTRUCTIONS.md": "Instructions",
        "MEMORY.md": "Memory",
        "SOUL.md": "Soul",
        "STYLE.md": "Style",
      },
      systemPrompt: "Stored prompt",
    };
    await tool.run(draft, context());
    state.beginTurn(SESSION_ID, "Confirm these changes");
    await tool.run(draft, context());

    expect(calls[0]).toEqual({
      actor: { userId: USER_ID },
      changeMeta: { actorUserId: USER_ID, source: "super_bot" },
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      request: {
        model: null,
        name: "Support",
        skillsPostTurnReview: true,
        skillsWriteApproval: null,
        soulFiles: {
          "INSTRUCTIONS.md": "Instructions",
          "MEMORY.md": "Memory",
          "SOUL.md": "Soul",
          "STYLE.md": "Style",
        },
        systemPrompt: "Stored prompt",
      },
    });
  });

  test("denies non-admin, anonymous, and privilege-escalation fields", async () => {
    const { tool } = buildHarness();

    await expect(
      tool.run(
        { profileId: PROFILE_ID, systemPrompt: "Prompt" },
        context({ orgRole: "member" })
      )
    ).rejects.toThrow(/admin permission/i);
    await expect(
      tool.run(
        { profileId: PROFILE_ID, systemPrompt: "Prompt" },
        context({ userId: undefined })
      )
    ).rejects.toThrow(/authenticated user/i);
    await expect(
      tool.run({ isSuper: true, profileId: PROFILE_ID }, context())
    ).rejects.toThrow(/unsupported profile update field/i);
    await expect(
      tool.run({ isDefault: true, profileId: PROFILE_ID }, context())
    ).rejects.toThrow(/unsupported profile update field/i);
    await expect(
      tool.run({ apiKey: "secret", profileId: PROFILE_ID }, context())
    ).rejects.toThrow(/unsupported profile update field/i);
    await expect(
      tool.run(
        {
          profileId: PROFILE_ID,
          soulFiles: { "../SOUL.md": "escape" },
        },
        context()
      )
    ).rejects.toThrow(/unsupported soul file/i);
  });

  test("cancels a pending draft when the user explicitly declines it", async () => {
    const { calls, state, tool } = buildHarness();
    const draft = { profileId: PROFILE_ID, systemPrompt: "Prompt" };

    await tool.run(draft, context());
    state.beginTurn(SESSION_ID, "Batal, jangan ubah profilnya");
    await expect(tool.run(draft, context())).resolves.toEqual({
      message: PROFILE_UPDATE_CANCELLED_MESSAGE,
      outcome: "cancelled",
    });
    expect(calls).toHaveLength(0);

    state.beginTurn(SESSION_ID, "Confirm these changes");
    await expect(tool.run(draft, context())).resolves.toMatchObject({
      outcome: "needs_confirmation",
    });
    expect(calls).toHaveLength(0);
  });
});
