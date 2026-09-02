import { describe, expect, test } from "bun:test";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { AgentService } from "../../services/agent-service";
import { SkillProposalService } from "../../services/skill-proposal-service";
import { SkillsService } from "../../services/skills-service";
import { setupTestConfigDir } from "../../test-config-dir";
import { createMinimalHonoApp } from "../test-app-helpers";
import {
  loginUserSession,
  setupFreshInstallSession,
} from "../test-session-helpers";

setupTestConfigDir("atlas-skill-proposals-routes-test-");

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
  const agent = new AgentService(null, null, databaseAdapter);
  return {
    ...createMinimalHonoApp({ agent, databaseAdapter, skillProposalService }),
    skillProposalService,
    skillsService,
  };
}

const BASE = "http://localhost:4310";

describe("skill proposal routes (v1)", () => {
  test("admin can list, approve, and reject proposals; member needs sessionId to list", async () => {
    const { app, authService, databaseAdapter, skillProposalService } =
      createApp();
    const adminSession = await setupFreshInstallSession(
      app,
      databaseAdapter,
      "admin@org.com"
    );
    const orgId = adminSession.orgId!;
    const profiles = await databaseAdapter.listProfilesForOrg(orgId);
    const profileId = profiles[0]!.id;
    const sessionId = "sess_post_turn_notice";

    const staged = await skillProposalService.stageProposal({
      action: "create",
      content: sampleSkillMarkdown,
      orgId,
      profileId,
      sessionId,
    });
    expect(staged.outcome).toBe("created");

    const listResp = await app.fetch(
      new Request(
        `${BASE}/v1/orgs/${orgId}/skill-proposals?status=pending&profileId=${profileId}`,
        {
          headers: adminSession.headers({}, orgId),
        }
      )
    );
    expect(listResp.status).toBe(200);
    const listBody = (await listResp.json()) as {
      proposals: { id: string; skillName: string }[];
      pendingCount: number;
    };
    expect(listBody.pendingCount).toBe(1);
    expect(listBody.proposals[0]?.skillName).toBe("deploy-notes");

    const approveResp = await app.fetch(
      new Request(
        `${BASE}/v1/orgs/${orgId}/skill-proposals/${staged.proposalId}/approve`,
        {
          headers: adminSession.headers(
            { "X-CSRF-Token": adminSession.csrfToken },
            orgId
          ),
          method: "POST",
        }
      )
    );
    expect(approveResp.status).toBe(200);
    const approveBody = (await approveResp.json()) as {
      proposal: { status: string };
    };
    expect(approveBody.proposal.status).toBe("approved");

    const memberResp = await app.fetch(
      new Request(`${BASE}/v1/orgs/${orgId}/members`, {
        body: JSON.stringify({
          email: "member@org.com",
          name: "Member",
          role: "member",
        }),
        headers: adminSession.headers(
          { "X-CSRF-Token": adminSession.csrfToken },
          orgId
        ),
        method: "POST",
      })
    );
    const memberProvisioned = (await memberResp.json()) as {
      temporaryPassword: string;
    };
    const memberSession = await loginUserSession(
      app,
      "member@org.com",
      memberProvisioned.temporaryPassword,
      orgId
    );
    const memberUser = await databaseAdapter.getUserByEmail("member@org.com");
    expect(memberUser).not.toBeNull();
    await databaseAdapter.upsertSession({
      agentQuestionnaire: null,
      agentTodos: [],
      channel: "web",
      createdAt: new Date().toISOString(),
      id: sessionId,
      modelOverride: null,
      orgId,
      profileId,
      title: null,
      userId: memberUser!.id,
    });
    const memberListResp = await app.fetch(
      new Request(`${BASE}/v1/orgs/${orgId}/skill-proposals`, {
        headers: memberSession.headers({}, orgId),
      })
    );
    expect(memberListResp.status).toBe(403);

    const otherStaged = await skillProposalService.stageProposal({
      action: "create",
      content: sampleSkillMarkdown
        .replace("deploy-notes", "rollback-notes")
        .replace("Notes about deploy process.", "Notes about rollback."),
      orgId,
      profileId,
      sessionId,
    });
    expect(otherStaged.outcome).toBe("created");

    const memberSessionListResp = await app.fetch(
      new Request(
        `${BASE}/v1/orgs/${orgId}/skill-proposals?status=pending&sessionId=${encodeURIComponent(sessionId)}`,
        {
          headers: memberSession.headers({}, orgId),
        }
      )
    );
    expect(memberSessionListResp.status).toBe(200);
    const memberSessionBody = (await memberSessionListResp.json()) as {
      proposals: { skillName: string; sessionId: string | null }[];
      pendingCount: number;
    };
    expect(memberSessionBody.pendingCount).toBe(1);
    expect(memberSessionBody.proposals).toHaveLength(1);
    expect(memberSessionBody.proposals[0]?.skillName).toBe("rollback-notes");
    expect(memberSessionBody.proposals[0]?.sessionId).toBe(sessionId);

    const secondMemberResp = await app.fetch(
      new Request(`${BASE}/v1/orgs/${orgId}/members`, {
        body: JSON.stringify({
          email: "member-b@org.com",
          name: "Member B",
          role: "member",
        }),
        headers: adminSession.headers(
          { "X-CSRF-Token": adminSession.csrfToken },
          orgId
        ),
        method: "POST",
      })
    );
    const secondMemberProvisioned = (await secondMemberResp.json()) as {
      temporaryPassword: string;
    };
    const secondMemberSession = await loginUserSession(
      app,
      "member-b@org.com",
      secondMemberProvisioned.temporaryPassword,
      orgId
    );
    const secondMemberUser =
      await databaseAdapter.getUserByEmail("member-b@org.com");
    expect(secondMemberUser).not.toBeNull();
    const secondMemberSessionId = "sess_member_b";
    await databaseAdapter.upsertSession({
      agentQuestionnaire: null,
      agentTodos: [],
      channel: "web",
      createdAt: new Date().toISOString(),
      id: secondMemberSessionId,
      modelOverride: null,
      orgId,
      profileId,
      title: null,
      userId: secondMemberUser!.id,
    });
    await skillProposalService.stageProposal({
      action: "create",
      content: sampleSkillMarkdown
        .replace("deploy-notes", "member-b-notes")
        .replace("Notes about deploy process.", "Member B private notes."),
      orgId,
      profileId,
      sessionId: secondMemberSessionId,
    });

    const secondMemberUrl = `${BASE}/v1/orgs/${orgId}/skill-proposals?sessionId=${secondMemberSessionId}`;
    expect(
      (
        await app.fetch(
          new Request(secondMemberUrl, {
            headers: memberSession.headers({}, orgId),
          })
        )
      ).status
    ).toBe(404);
    expect(
      (
        await app.fetch(
          new Request(secondMemberUrl, {
            headers: secondMemberSession.headers({}, orgId),
          })
        )
      ).status
    ).toBe(200);
    expect(
      (
        await app.fetch(
          new Request(secondMemberUrl, {
            headers: adminSession.headers({}, orgId),
          })
        )
      ).status
    ).toBe(200);
  });

  test("admin can reject a pending proposal", async () => {
    const { app, databaseAdapter, skillProposalService } = createApp();
    const adminSession = await setupFreshInstallSession(
      app,
      databaseAdapter,
      "admin2@org.com"
    );
    const orgId = adminSession.orgId!;
    const profileId = (await databaseAdapter.listProfilesForOrg(orgId))[0]!.id;

    const staged = await skillProposalService.stageProposal({
      action: "create",
      content: sampleSkillMarkdown,
      orgId,
      profileId,
    });

    const rejectResp = await app.fetch(
      new Request(
        `${BASE}/v1/orgs/${orgId}/skill-proposals/${staged.proposalId}/reject`,
        {
          headers: adminSession.headers(
            { "X-CSRF-Token": adminSession.csrfToken },
            orgId
          ),
          method: "POST",
        }
      )
    );
    expect(rejectResp.status).toBe(200);
    const rejectBody = (await rejectResp.json()) as {
      proposal: { status: string };
    };
    expect(rejectBody.proposal.status).toBe("rejected");
  });

  test("approve proposal from wrong org returns 404 (AE6)", async () => {
    const { app, databaseAdapter, skillProposalService } = createApp();
    const adminSession = await setupFreshInstallSession(
      app,
      databaseAdapter,
      "admin3@org.com"
    );
    const orgId = adminSession.orgId!;
    const profileId = (await databaseAdapter.listProfilesForOrg(orgId))[0]!.id;

    const staged = await skillProposalService.stageProposal({
      action: "create",
      content: sampleSkillMarkdown,
      orgId,
      profileId,
    });

    const otherOrgResp = await app.fetch(
      new Request(
        `${BASE}/v1/orgs/org_other/skill-proposals/${staged.proposalId}/approve`,
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
});
