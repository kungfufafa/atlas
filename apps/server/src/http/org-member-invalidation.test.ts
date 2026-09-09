import { describe, expect, test } from "bun:test";
import type { OrgRole } from "@atlas/core";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { AgentService } from "../services/agent-service";
import { AuthService } from "../services/auth-service";
import { sessionTurnRegistry } from "../services/session-turn-registry";
import { setupTestConfigDir } from "../test-config-dir";
import { createMinimalHonoApp } from "./test-app-helpers";
import { loginUserSession, seedOrgAdmin } from "./test-session-helpers";

setupTestConfigDir("atlas-org-member-invalidation-");
const NOW = "2026-09-06T00:00:00.000Z";
const ORG = "org_member_invalidation";
const OTHER_ORG = "org_member_unrelated";
const TARGET = "user_member_target";
const OTHER_USER = "user_member_unrelated";

async function fixture(targetRole: OrgRole = "member") {
  const db = createInMemoryDatabaseAdapter();
  const authService = new AuthService();
  const admin = await seedOrgAdmin(db, { authService, orgId: ORG });
  await db.upsertOrganization({
    createdAt: NOW,
    id: OTHER_ORG,
    name: OTHER_ORG,
    slug: OTHER_ORG,
    updatedAt: NOW,
  });
  for (const id of [TARGET, OTHER_USER]) {
    await db.createUser({
      createdAt: NOW,
      email: `${id}@example.com`,
      id,
      passwordHash: "test",
      updatedAt: NOW,
    });
    await db.upsertOrgMember({
      createdAt: NOW,
      orgId: ORG,
      role: id === TARGET ? targetRole : "member",
      userId: id,
    });
  }
  await db.upsertOrgMember({
    createdAt: NOW,
    orgId: OTHER_ORG,
    role: targetRole,
    userId: TARGET,
  });
  for (const orgId of [ORG, OTHER_ORG]) {
    await db.upsertProfile({
      createdAt: NOW,
      id: `profile_${orgId}`,
      isDefault: true,
      isSuper: false,
      model: null,
      name: "Profile",
      orgId,
      systemPrompt: "",
      updatedAt: NOW,
    });
  }
  const agent = new AgentService(null, null, db);
  const { app } = createMinimalHonoApp({
    agent,
    authService,
    databaseAdapter: db,
  });
  const browser = await loginUserSession(app, admin.email, admin.password, ORG);
  const sessions = [
    {
      cached: true,
      channel: "whatsapp",
      key: "cached_target",
      orgId: ORG,
      userId: TARGET,
    },
    {
      cached: false,
      channel: "telegram",
      key: "uncached_target",
      orgId: ORG,
      userId: TARGET,
    },
    {
      cached: true,
      channel: "discord",
      key: "discord_target",
      orgId: ORG,
      userId: TARGET,
    },
    {
      cached: true,
      channel: "web",
      key: "other_user",
      orgId: ORG,
      userId: OTHER_USER,
    },
    {
      cached: true,
      channel: "whatsapp",
      key: "other_org",
      orgId: OTHER_ORG,
      userId: TARGET,
    },
  ].map((spec) => ({
    ...spec,
    abort: new AbortController(),
    events: [] as string[],
    id: `${spec.key}_${crypto.randomUUID()}`,
  }));
  for (const spec of sessions) {
    await db.upsertSession({
      agentQuestionnaire: null,
      agentTodos: [],
      channel: spec.channel,
      createdAt: NOW,
      id: spec.id,
      modelOverride: null,
      orgId: spec.orgId,
      profileId: `profile_${spec.orgId}`,
      title: null,
      userId: spec.userId,
    });
    if (spec.cached) {
      expect(await agent.resolveSession(spec.orgId, spec.id)).not.toBeNull();
    }
  }
  for (const spec of sessions) {
    expect(await agent.beginSessionTurn(spec.orgId, spec.id)).toBe(true);
    sessionTurnRegistry.attachAbort(spec.id, spec.abort);
    expect(
      sessionTurnRegistry.subscribe(spec.id, (event) => {
        spec.events.push(event.type);
      })
    ).not.toBeNull();
  }
  const approvals = await Promise.all(
    sessions.map(async (spec) => {
      const id = `approval_${spec.id}`;
      const ready = Promise.withResolvers<void>();
      let settled = false;
      const waiting = agent.chatToolApprovals.request(
        {
          approval: {
            createdAt: NOW,
            id,
            status: "pending",
            title: "Delete test artifact",
            tool: "delete_file",
            toolCallId: `call_${id}`,
          },
          beforeDecision: async () => {},
          call: {
            arguments: { path: "artifacts/test.txt" },
            id: `call_${id}`,
            name: "delete_file",
          },
          principal: {
            isPlatformAdmin: false,
            orgId: spec.orgId,
            orgRole: spec.userId === TARGET ? targetRole : "member",
            userId: spec.userId,
          },
          runId: `run_${spec.id}`,
          sessionId: spec.id,
        },
        ready.resolve
      );
      void waiting.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      await ready.promise;
      return { id, settled: () => settled, spec, waiting };
    })
  );
  const mutate = (method: string, body?: Record<string, unknown>) =>
    app.fetch(
      new Request(`http://localhost:4310/v1/orgs/${ORG}/members/${TARGET}`, {
        body: body ? JSON.stringify(body) : undefined,
        headers: browser.headers({ "X-CSRF-Token": browser.csrfToken }),
        method,
      })
    );
  const cleanup = async () => {
    for (const spec of sessions) {
      agent.chatToolApprovals.cancelSession(spec.id);
      sessionTurnRegistry.cancelTurn(spec.id);
    }
    await Promise.allSettled(approvals.map(({ waiting }) => waiting));
  };
  return { agent, approvals, cleanup, db, mutate, sessions };
}

describe("membership mutation cancels only the affected principal's running sessions", () => {
  test.each([
    {
      body: { role: "viewer" },
      change: "viewer downgrade",
      initialRole: "member" as const,
      method: "PATCH",
      status: 200,
    },
    {
      body: { role: "member" },
      change: "admin downgrade",
      initialRole: "admin" as const,
      method: "PATCH",
      status: 200,
    },
    {
      body: undefined,
      change: "membership removal",
      initialRole: "member" as const,
      method: "DELETE",
      status: 204,
    },
  ])(
    "$change cancels cached and uncached target streams and pending approvals",
    async ({ initialRole, method, body, status }) => {
      const f = await fixture(initialRole);
      try {
        expect((await f.mutate(method, body)).status).toBe(status);
        for (const approval of f.approvals) {
          const affected =
            approval.spec.orgId === ORG && approval.spec.userId === TARGET;
          expect(approval.spec.abort.signal.aborted).toBe(affected);
          expect(sessionTurnRegistry.isActive(approval.spec.id)).toBe(
            !affected
          );
          expect(approval.spec.events).toEqual(affected ? ["error"] : []);
          if (affected) {
            await expect(approval.waiting).rejects.toMatchObject({
              name: "AbortError",
            });
            expect(approval.settled()).toBe(true);
            expect(
              (await f.db.getActionApproval(approval.id))?.grantId
            ).toBeNull();
          } else {
            expect(approval.settled()).toBe(false);
          }
        }
      } finally {
        await f.cleanup();
      }
    }
  );

  test.each([
    {
      body: { name: "Updated display name" },
      change: "name-only edit",
      status: 200,
    },
    { body: { role: "member" }, change: "unchanged role", status: 200 },
    { body: { role: "owner" }, change: "invalid role", status: 400 },
  ])(
    "$change preserves active streams and approvals",
    async ({ body, status }) => {
      const f = await fixture();
      try {
        expect((await f.mutate("PATCH", body)).status).toBe(status);
        for (const approval of f.approvals) {
          expect(approval.spec.abort.signal.aborted).toBe(false);
          expect(sessionTurnRegistry.isActive(approval.spec.id)).toBe(true);
          expect(approval.spec.events).toEqual([]);
          expect(approval.settled()).toBe(false);
        }
      } finally {
        await f.cleanup();
      }
    }
  );
});
