import { describe, expect, test } from "bun:test";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { AgentService } from "../../services/agent-service";
import { SkillProposalService } from "../../services/skill-proposal-service";
import { SkillSuggestionService } from "../../services/skill-suggestion-service";
import { SkillsService } from "../../services/skills-service";
import { setupTestConfigDir } from "../../test-config-dir";
import { createMinimalHonoApp } from "../test-app-helpers";
import {
  loginUserSession,
  setupFreshInstallSession,
} from "../test-session-helpers";

setupTestConfigDir("atlas-skill-suggestions-routes-test-");

const sampleSkillMarkdown = `---
name: deploy-notes
description: Notes about deploy process.
---

Run the deploy checklist before shipping.
`;

function createApp() {
  const databaseAdapter = createInMemoryDatabaseAdapter();
  const skillsService = new SkillsService(databaseAdapter);
  const skillProposalService = new SkillProposalService(
    databaseAdapter,
    skillsService
  );
  const skillSuggestionService = new SkillSuggestionService(
    databaseAdapter,
    skillsService,
    skillProposalService
  );
  const agent = new AgentService(null, null, databaseAdapter);
  return {
    ...createMinimalHonoApp({
      agent,
      databaseAdapter,
      skillProposalService,
      skillSuggestionService,
    }),
    skillProposalService,
    skillSuggestionService,
    skillsService,
  };
}

const BASE = "http://localhost:4310";

describe("skill suggestion routes (v1)", () => {
  test("admin can list and apply suggestions; viewer is forbidden", async () => {
    const { app, databaseAdapter, skillSuggestionService } = createApp();
    const adminSession = await setupFreshInstallSession(
      app,
      databaseAdapter,
      "admin@org.com"
    );
    const orgId = adminSession.orgId!;
    const profiles = await databaseAdapter.listProfilesForOrg(orgId);
    const profileId = profiles[0]!.id;

    const created = await skillSuggestionService.createSuggestion({
      orgId,
      outcome: {
        action: "create",
        content: sampleSkillMarkdown,
        name: "deploy-notes",
      },
      profileId,
    });

    const listResp = await app.fetch(
      new Request(`${BASE}/v1/orgs/${orgId}/skill-suggestions?status=pending`, {
        headers: adminSession.headers({}, orgId),
      })
    );
    expect(listResp.status).toBe(200);
    const listBody = (await listResp.json()) as {
      suggestions: { id: string; skillName: string }[];
    };
    expect(listBody.suggestions).toHaveLength(1);
    expect(listBody.suggestions[0]?.skillName).toBe("deploy-notes");

    const applyResp = await app.fetch(
      new Request(
        `${BASE}/v1/orgs/${orgId}/skill-suggestions/${created.id}/apply`,
        {
          headers: adminSession.headers(
            { "X-CSRF-Token": adminSession.csrfToken },
            orgId
          ),
          method: "POST",
        }
      )
    );
    expect(applyResp.status).toBe(200);
    const applyBody = (await applyResp.json()) as {
      outcome: string;
      suggestion: { status: string };
    };
    expect(applyBody.outcome).toBe("applied");
    expect(applyBody.suggestion.status).toBe("applied");

    const memberResp = await app.fetch(
      new Request(`${BASE}/v1/orgs/${orgId}/members`, {
        body: JSON.stringify({
          email: "viewer@org.com",
          name: "Viewer",
          role: "viewer",
        }),
        headers: adminSession.headers(
          { "X-CSRF-Token": adminSession.csrfToken },
          orgId
        ),
        method: "POST",
      })
    );
    const viewerProvisioned = (await memberResp.json()) as {
      temporaryPassword: string;
    };
    const viewerSession = await loginUserSession(
      app,
      "viewer@org.com",
      viewerProvisioned.temporaryPassword,
      orgId
    );
    const viewerListResp = await app.fetch(
      new Request(`${BASE}/v1/orgs/${orgId}/skill-suggestions`, {
        headers: viewerSession.headers({}, orgId),
      })
    );
    expect(viewerListResp.status).toBe(403);
  });

  test("member can only filter suggestions by an owned session", async () => {
    const { app, databaseAdapter, skillSuggestionService } = createApp();
    const adminSession = await setupFreshInstallSession(
      app,
      databaseAdapter,
      "session-admin@org.com"
    );
    const orgId = adminSession.orgId!;
    const profileId = (await databaseAdapter.listProfilesForOrg(orgId))[0]!.id;

    const provisionMember = async (
      email: string,
      name: string
    ): Promise<Awaited<ReturnType<typeof loginUserSession>>> => {
      const response = await app.fetch(
        new Request(`${BASE}/v1/orgs/${orgId}/members`, {
          body: JSON.stringify({ email, name, role: "member" }),
          headers: adminSession.headers(
            { "X-CSRF-Token": adminSession.csrfToken },
            orgId
          ),
          method: "POST",
        })
      );
      const provisioned = (await response.json()) as {
        temporaryPassword: string;
      };
      return loginUserSession(app, email, provisioned.temporaryPassword, orgId);
    };

    const memberA = await provisionMember("member-a@org.com", "Member A");
    const memberB = await provisionMember("member-b@org.com", "Member B");
    const userA = await databaseAdapter.getUserByEmail("member-a@org.com");
    const userB = await databaseAdapter.getUserByEmail("member-b@org.com");
    expect(userA).not.toBeNull();
    expect(userB).not.toBeNull();
    const now = new Date().toISOString();
    for (const [sessionId, userId] of [
      ["suggestion-session-a", userA!.id],
      ["suggestion-session-b", userB!.id],
    ] as const) {
      await databaseAdapter.upsertSession({
        agentQuestionnaire: null,
        agentTodos: [],
        channel: "web",
        createdAt: now,
        id: sessionId,
        modelOverride: null,
        orgId,
        profileId,
        title: null,
        userId,
      });
    }
    await skillSuggestionService.createSuggestion({
      orgId,
      outcome: {
        action: "create",
        content: sampleSkillMarkdown.replace("deploy-notes", "member-b-notes"),
        name: "member-b-notes",
      },
      profileId,
      proposedByUserId: userB!.id,
      sessionId: "suggestion-session-b",
    });
    const memberBUrl = `${BASE}/v1/orgs/${orgId}/skill-suggestions?sessionId=suggestion-session-b`;

    expect(
      (
        await app.fetch(
          new Request(`${BASE}/v1/orgs/${orgId}/skill-suggestions`, {
            headers: memberA.headers({}, orgId),
          })
        )
      ).status
    ).toBe(403);
    expect(
      (
        await app.fetch(
          new Request(memberBUrl, { headers: memberA.headers({}, orgId) })
        )
      ).status
    ).toBe(404);
    expect(
      (
        await app.fetch(
          new Request(memberBUrl, { headers: memberB.headers({}, orgId) })
        )
      ).status
    ).toBe(200);
    expect(
      (
        await app.fetch(
          new Request(memberBUrl, { headers: adminSession.headers({}, orgId) })
        )
      ).status
    ).toBe(200);

    const applyUrl = `${BASE}/v1/orgs/${orgId}/skill-suggestions/${
      (
        await skillSuggestionService.listSuggestions(orgId, {
          sessionId: "suggestion-session-b",
        })
      )[0]!.id
    }/apply`;
    expect(
      (
        await app.fetch(
          new Request(applyUrl, {
            headers: memberA.headers(
              { "X-CSRF-Token": memberA.csrfToken },
              orgId
            ),
            method: "POST",
          })
        )
      ).status
    ).toBe(404);
    expect(
      (
        await app.fetch(
          new Request(applyUrl, {
            headers: memberB.headers(
              { "X-CSRF-Token": memberB.csrfToken },
              orgId
            ),
            method: "POST",
          })
        )
      ).status
    ).toBe(200);
  });

  test("apply suggestion from wrong org returns 404", async () => {
    const { app, databaseAdapter, skillSuggestionService } = createApp();
    const adminSession = await setupFreshInstallSession(
      app,
      databaseAdapter,
      "admin3@org.com"
    );
    const orgId = adminSession.orgId!;
    const profileId = (await databaseAdapter.listProfilesForOrg(orgId))[0]!.id;

    const created = await skillSuggestionService.createSuggestion({
      orgId,
      outcome: {
        action: "create",
        content: sampleSkillMarkdown,
        name: "deploy-notes",
      },
      profileId,
    });

    const otherOrgResp = await app.fetch(
      new Request(
        `${BASE}/v1/orgs/org_other/skill-suggestions/${created.id}/apply`,
        {
          headers: adminSession.headers(
            { "X-CSRF-Token": adminSession.csrfToken },
            orgId
          ),
          method: "POST",
        }
      )
    );
    expect(otherOrgResp.status).toBe(404);
  });

  test("gate flip on apply stages a proposal instead of writing", async () => {
    const {
      app,
      databaseAdapter,
      skillSuggestionService,
      skillProposalService,
    } = createApp();
    const adminSession = await setupFreshInstallSession(
      app,
      databaseAdapter,
      "admin4@org.com"
    );
    const orgId = adminSession.orgId!;
    const profileId = (await databaseAdapter.listProfilesForOrg(orgId))[0]!.id;

    const created = await skillSuggestionService.createSuggestion({
      orgId,
      outcome: {
        action: "create",
        content: sampleSkillMarkdown,
        name: "deploy-notes",
      },
      profileId,
    });

    const org = await databaseAdapter.getOrganizationById(orgId);
    await databaseAdapter.upsertOrganization({
      ...org!,
      skillsWriteApproval: true,
    });

    const applyResp = await app.fetch(
      new Request(
        `${BASE}/v1/orgs/${orgId}/skill-suggestions/${created.id}/apply`,
        {
          headers: adminSession.headers(
            { "X-CSRF-Token": adminSession.csrfToken },
            orgId
          ),
          method: "POST",
        }
      )
    );
    expect(applyResp.status).toBe(200);
    const applyBody = (await applyResp.json()) as {
      outcome: string;
      proposalId?: string;
    };
    expect(applyBody.outcome).toBe("staged_as_proposal");
    expect(applyBody.proposalId).toBeTruthy();

    const { proposals } = await skillProposalService.listProposals(orgId, {
      profileId,
    });
    expect(
      proposals.some((proposal) => proposal.id === applyBody.proposalId)
    ).toBe(true);
  });
});
