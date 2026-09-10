import { afterEach, expect, test } from "bun:test";
import type { AgentChatSession } from "@atlas/agent";
import {
  createWorkspaceWorkerAuthToken,
  type SessionStatusResponse,
} from "@atlas/core";
import { createSqliteDatabase } from "@atlas/db";
import { AgentService } from "../../services/agent-service";
import { AuthService } from "../../services/auth-service";
import type { ChatToolApprovalService } from "../../services/chat-tool-approval-service";
import { sessionTurnRegistry } from "../../services/session-turn-registry";
import { setupTestConfigDir } from "../../test-config-dir";
import { streamMessage } from "../shared";
import { createMinimalHonoApp } from "../test-app-helpers";
import { loginUserSession } from "../test-session-helpers";

setupTestConfigDir("atlas-session-cancel-");
const ORG = "cancel-org";
const OTHER_ORG = "cancel-other-org";
const OWNER = "cancel-owner";
const NOW = "2026-09-10T00:00:00.000Z";
const PASSWORD = "test-password";
const fixtures: Array<{ close: () => void; sessionId: string }> = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    sessionTurnRegistry.cancelTurn(fixture.sessionId);
    fixture.close();
  }
});

async function fixture() {
  const database = await createSqliteDatabase(":memory:");
  const db = database.adapter;
  const sessionId = crypto.randomUUID();
  fixtures.push({ close: () => database.close(), sessionId });
  const authService = new AuthService();
  const passwordHash = await authService.hashPassword(PASSWORD);
  for (const orgId of [ORG, OTHER_ORG]) {
    await db.upsertOrganization({
      createdAt: NOW,
      id: orgId,
      name: orgId,
      slug: orgId,
      updatedAt: NOW,
    });
  }
  for (const userId of [OWNER, "cancel-other", "cancel-admin"]) {
    await db.createUser({
      createdAt: NOW,
      email: `${userId}@example.invalid`,
      id: userId,
      isPlatformAdmin: false,
      passwordHash,
      updatedAt: NOW,
    });
    await db.upsertOrgMember({
      createdAt: NOW,
      orgId: ORG,
      role: userId === "cancel-admin" ? "admin" : "member",
      userId,
    });
  }
  await db.upsertOrgMember({
    createdAt: NOW,
    orgId: OTHER_ORG,
    role: "member",
    userId: OWNER,
  });
  await db.upsertProfile({
    createdAt: NOW,
    id: "cancel-profile",
    isSuper: false,
    model: null,
    name: "Cancellation",
    orgId: ORG,
    systemPrompt: "",
    updatedAt: NOW,
  });
  await db.upsertSession({
    agentQuestionnaire: null,
    agentTodos: [],
    channel: "web",
    createdAt: NOW,
    id: sessionId,
    modelOverride: null,
    orgId: ORG,
    profileId: "cancel-profile",
    title: null,
    userId: OWNER,
  });
  const agent = new AgentService(null, null, db);
  const { app } = createMinimalHonoApp({
    agent,
    authService,
    databaseAdapter: db,
  });
  const login = async (userId = OWNER) =>
    loginUserSession(app, `${userId}@example.invalid`, PASSWORD, ORG);
  const owner = await login();
  const headers = owner.headers({
    "Content-Type": "application/json",
    "X-CSRF-Token": owner.csrfToken,
  });
  const post = (body: unknown, requestHeaders = headers, suffix = "cancel") =>
    app.fetch(
      new Request(`http://localhost:4310/v1/sessions/${sessionId}/${suffix}`, {
        body: JSON.stringify(body),
        headers: requestHeaders,
        method: "POST",
      })
    );
  const status = async (): Promise<SessionStatusResponse> => {
    const response = await app.fetch(
      new Request(`http://localhost:4310/v1/sessions/${sessionId}/status`, {
        headers,
      })
    );
    expect(response.status).toBe(200);
    return response.json();
  };
  return { agent, app, db, headers, login, owner, post, sessionId, status };
}

test("HTTP cancellation stops a waiting approval and holds the session until real cleanup", async () => {
  const f = await fixture();
  const cleanup = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  const approvals = (
    f.agent as unknown as { chatToolApprovals: ChatToolApprovalService }
  ).chatToolApprovals;
  const principal = {
    isPlatformAdmin: false,
    orgId: ORG,
    orgRole: "member" as const,
    userId: OWNER,
  };
  const approvalId = crypto.randomUUID();
  let signal: AbortSignal | undefined;
  const session = {
    getContextUsage: () => null,
    async sendStream(
      _input: unknown,
      _handlers: unknown,
      options?: { signal?: AbortSignal }
    ) {
      signal = options?.signal;
      try {
        await approvals.request(
          {
            approval: {
              createdAt: NOW,
              id: approvalId,
              status: "pending",
              title: "Delete artifact",
              tool: "delete_file",
              toolCallId: "delete-call",
            },
            beforeDecision: async () => {},
            call: {
              arguments: { path: "artifacts/report.csv" },
              id: "delete-call",
              name: "delete_file",
            },
            principal,
            runId: crypto.randomUUID(),
            sessionId: f.sessionId,
          },
          ready.resolve
        );
        return "unexpected approval";
      } finally {
        await cleanup.promise;
      }
    },
  } as AgentChatSession;
  sessionTurnRegistry.beginTurn(f.sessionId, ORG);
  const response = streamMessage(f.sessionId, session, { message: "Run tool" });
  try {
    await ready.promise;
    const before = await f.status();
    const cancelled = await f.post({ expectedTurnId: before.turnId });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({
      active: true,
      cancelled: true,
      cancelling: true,
      turnId: before.turnId,
    });
    expect(signal?.aborted).toBe(true);
    expect(
      (await f.post({ message: "Follow-up" }, f.headers, "messages")).status
    ).toBe(409);
    await expect(
      approvals.decide({
        approvalId,
        decision: "approved",
        principal,
        sessionId: f.sessionId,
      })
    ).rejects.toMatchObject({ status: 409 });
    expect((await f.db.getActionApproval(approvalId))?.grantId).toBeNull();
  } finally {
    cleanup.resolve();
    await new Response(response.body).text();
  }
  expect(await f.status()).toEqual({ active: false });
});

test("stale cancellation cannot abort a replacement turn, and idle cancellation is harmless", async () => {
  const f = await fixture();
  sessionTurnRegistry.beginTurn(f.sessionId, ORG);
  const oldTurnId = (await f.status()).turnId;
  sessionTurnRegistry.endTurn(f.sessionId, { reply: "done", type: "done" });
  expect(await (await f.post({ expectedTurnId: oldTurnId })).json()).toEqual({
    active: false,
    cancelled: false,
  });
  sessionTurnRegistry.beginTurn(f.sessionId, ORG);
  const replacement = new AbortController();
  sessionTurnRegistry.attachAbort(f.sessionId, replacement);
  const newTurn = await f.status();
  expect(newTurn.turnId).not.toBe(oldTurnId);
  expect((await f.post({ expectedTurnId: oldTurnId })).status).toBe(409);
  expect(replacement.signal.aborted).toBe(false);
  expect(await f.status()).toEqual(newTurn);
  const staleStream = await f.app.fetch(
    new Request(
      `http://localhost:4310/v1/sessions/${f.sessionId}/stream?expectedTurnId=${oldTurnId}`,
      { headers: f.headers }
    )
  );
  expect(staleStream.status).toBe(409);
  expect(replacement.signal.aborted).toBe(false);
});

test("cancellation rejects other owners, admins, viewers, cross-org requests, and workers", async () => {
  const f = await fixture();
  sessionTurnRegistry.beginTurn(f.sessionId, ORG);
  const abort = new AbortController();
  sessionTurnRegistry.attachAbort(f.sessionId, abort);
  const body = { expectedTurnId: (await f.status()).turnId };
  for (const userId of ["cancel-other", "cancel-admin"]) {
    const login = await f.login(userId);
    expect(
      (
        await f.post(
          body,
          login.headers({
            "Content-Type": "application/json",
            "X-CSRF-Token": login.csrfToken,
          })
        )
      ).status
    ).toBe(404);
  }
  expect(
    (await f.post(body, { ...f.headers, "X-Org-Id": OTHER_ORG })).status
  ).toBe(404);
  const workerHeaders = {
    Authorization: `Bearer ${await createWorkspaceWorkerAuthToken({ channel: "discord", orgId: ORG })}`,
    "Content-Type": "application/json",
    "X-Org-Id": ORG,
  };
  expect((await f.post(body, workerHeaders)).status).toBe(403);
  await f.db.upsertOrgMember({
    createdAt: NOW,
    orgId: ORG,
    role: "viewer",
    userId: OWNER,
  });
  expect((await f.post(body)).status).toBe(403);
  expect(abort.signal.aborted).toBe(false);
});

test("cancellation requires CSRF and a valid bounded expected turn identity", async () => {
  const f = await fixture();
  sessionTurnRegistry.beginTurn(f.sessionId, ORG);
  const abort = new AbortController();
  sessionTurnRegistry.attachAbort(f.sessionId, abort);
  const turnId = (await f.status()).turnId;
  expect(
    (
      await f.post(
        { expectedTurnId: turnId },
        f.owner.headers({ "Content-Type": "application/json" })
      )
    ).status
  ).toBe(403);
  for (const body of [
    {},
    { expectedTurnId: "invalid" },
    { expectedTurnId: turnId, unexpected: true },
  ]) {
    expect((await f.post(body)).status).toBe(400);
  }
  expect((await f.post({ expectedTurnId: "x".repeat(2048) })).status).toBe(413);
  expect(abort.signal.aborted).toBe(false);
});
