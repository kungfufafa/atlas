import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createWorkspaceWorkerAuthToken, getUserConfigDir } from "@atlas/core";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { AgentService } from "../../services/agent-service";
import { createPublicationAuthorizer } from "../../services/artifact-publication-access";
import { ArtifactPublicationService } from "../../services/artifact-publication-service";
import { ArtifactPublicationStore } from "../../services/artifact-publication-store";
import { AuthService } from "../../services/auth-service";
import { setupTestConfigDir } from "../../test-config-dir";
import { createMinimalHonoApp } from "../test-app-helpers";
import { loginUserSession } from "../test-session-helpers";

setupTestConfigDir("atlas-publication-routes-");

async function fixture() {
  const db = createInMemoryDatabaseAdapter();
  const authService = new AuthService();
  const now = new Date().toISOString();
  await db.upsertOrganization({
    id: "org",
    slug: "org",
    name: "Org",
    createdAt: now,
    updatedAt: now,
  });
  const passwordHash = await authService.hashPassword("fixture-password");
  for (const id of ["owner", "other"]) {
    await db.createUser({
      id,
      email: `${id}@example.com`,
      passwordHash,
      createdAt: now,
      updatedAt: now,
    });
    await db.upsertOrgMember({
      orgId: "org",
      userId: id,
      role: "member",
      createdAt: now,
    });
  }
  await db.upsertProfile({
    id: "profile",
    orgId: "org",
    name: "Profile",
    isSuper: false,
    model: null,
    systemPrompt: "",
    createdAt: now,
    updatedAt: now,
  });
  for (const [id, userId, channel] of [
    ["s1", "owner", "web"],
    ["s2", "other", "web"],
    ["s3", "owner", "telegram"],
  ]) {
    await db.upsertSession({
      id,
      userId,
      channel,
      profileId: "profile",
      orgId: "org",
      createdAt: now,
      title: null,
      modelOverride: null,
      agentQuestionnaire: null,
      agentTodos: [],
    });
  }
  const agent = new AgentService(null, null, db);
  const { app } = createMinimalHonoApp({
    agent,
    authService,
    databaseAdapter: db,
  });
  const owner = await loginUserSession(
    app,
    "owner@example.com",
    "fixture-password",
    "org"
  );
  const other = await loginUserSession(
    app,
    "other@example.com",
    "fixture-password",
    "org"
  );
  const store = await ArtifactPublicationStore.create(getUserConfigDir());
  const workspace = join(getUserConfigDir(), "workspace");
  await mkdir(join(workspace, "artifacts"), { recursive: true });
  let sequence = 0;
  async function publish(
    sessionId: string,
    content: string,
    sourcePath = "artifacts/shared.txt"
  ) {
    const session = await db.getSession(sessionId);
    const actor = { userId: session!.userId! };
    const service = new ArtifactPublicationService(
      db,
      store,
      createPublicationAuthorizer(db, agent, actor)
    );
    const execution = await service.beginExecution(
      {
        actorId: actor.userId,
        orgId: "org",
        profileId: "profile",
        sessionId,
        executionId: `execution-${++sequence}`,
        runId: "run",
        toolCallId: "reused-call",
      },
      [workspace]
    );
    await writeFile(join(workspace, sourcePath), content);
    await execution.producer.stageBytes({
      bytes: Buffer.from(content),
      sourcePath,
      outputOrdinal: 0,
    });
    const final = await execution.finalize({
      success: true,
      data: { saved: true },
    });
    expect(final.status).toBe("committed");
    return final.publications[0]!;
  }
  const request = (
    path: string,
    headers: Record<string, string>,
    method = "GET"
  ) =>
    app.fetch(new Request(`http://localhost:4310${path}`, { headers, method }));
  return { app, db, owner, other, publish, request, workspace };
}

const base = "/v1/sessions/s1/artifact-publications";

test("session listing and content retain exact private bytes across same-path writes and forged history paths", async () => {
  const f = await fixture();
  const first = await f.publish("s1", "first bytes");
  const second = await f.publish("s2", "other user's bytes");
  const listing = await f.request(base, f.owner.headers());
  expect(listing.status).toBe(200);
  const body = await listing.json();
  expect(body.publications.map((item: { id: string }) => item.id)).toEqual([
    first.id,
  ]);
  expect(body.publications[0]).not.toHaveProperty("snapshotId");
  expect(body.nextCursor).toBeNull();
  const content = await f.request(
    `${base}/${first.id}/content`,
    f.owner.headers()
  );
  expect(content.status).toBe(200);
  expect(await content.text()).toBe("first bytes");
  expect(content.headers.get("Cache-Control")).toBe("private, no-store");
  for (const id of [
    second.id,
    "artifacts%2Fshared.txt",
    "publication_forged",
  ]) {
    expect(
      (await f.request(`${base}/${id}/content`, f.owner.headers())).status
    ).toBe(404);
  }
  expect((await f.request(base, f.other.headers())).status).toBe(404);
  expect((await f.request(base, {})).status).toBe(401);
});

test("bounded keyset pages return every publication once and reject invalid cursors", async () => {
  const f = await fixture();
  const ids = [];
  for (const value of ["one", "two", "three"]) {
    ids.push((await f.publish("s1", value)).id);
  }
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const response = await f.request(
      `${base}?limit=1${cursor ? `&cursor=${cursor}` : ""}`,
      f.owner.headers()
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.publications).toHaveLength(1);
    seen.push(body.publications[0].id);
    cursor = body.nextCursor;
  } while (cursor);
  expect(new Set(seen)).toEqual(new Set(ids));
  expect(seen).toHaveLength(3);
  for (const query of [
    "limit=0",
    "limit=101",
    "limit=1.5",
    "limit=",
    "cursor=",
    "cursor=!!!",
    `cursor=${Buffer.from('{"createdAt":"bad","id":"x"}').toString("base64url")}`,
  ]) {
    expect(
      (await f.request(`${base}?${query}`, f.owner.headers())).status
    ).toBe(400);
  }
});

test("range reads use the captured content and executable browser formats remain attachments", async () => {
  const f = await fixture();
  const file = await f.publish("s1", "0123456789");
  const range = await f.request(
    `${base}/${file.id}/content?inline=1`,
    f.owner.headers({ Range: "bytes=2-5" })
  );
  expect(range.status).toBe(206);
  expect(range.headers.get("Content-Range")).toBe("bytes 2-5/10");
  expect(await range.text()).toBe("2345");
  expect(
    (
      await f.request(
        `${base}/${file.id}/content`,
        f.owner.headers({ Range: "bytes=99-100" })
      )
    ).status
  ).toBe(416);
  const html = await f.publish(
    "s1",
    "<script>alert(1)</script>",
    "artifacts/report.html"
  );
  const response = await f.request(
    `${base}/${html.id}/content?inline=1`,
    f.owner.headers()
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Disposition")).toContain("attachment");
  expect(response.headers.get("Content-Security-Policy")).toContain("sandbox");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
});

test("viewer reads remain allowed but revocation requires current mutation access and CSRF", async () => {
  const f = await fixture();
  const file = await f.publish("s1", "original");
  await f.db.upsertOrgMember({
    orgId: "org",
    userId: "owner",
    role: "viewer",
    createdAt: new Date().toISOString(),
  });
  expect(
    (await f.request(`${base}/${file.id}/content`, f.owner.headers())).status
  ).toBe(200);
  expect(
    (
      await f.request(
        `${base}/${file.id}`,
        f.owner.headers({ "X-CSRF-Token": f.owner.csrfToken }),
        "DELETE"
      )
    ).status
  ).toBe(404);
  await f.db.upsertOrgMember({
    orgId: "org",
    userId: "owner",
    role: "member",
    createdAt: new Date().toISOString(),
  });
  expect(
    (await f.request(`${base}/${file.id}`, f.owner.headers(), "DELETE")).status
  ).toBe(403);
  const revoked = await f.request(
    `${base}/${file.id}`,
    f.owner.headers({ "X-CSRF-Token": f.owner.csrfToken }),
    "DELETE"
  );
  expect(revoked.status).toBe(200);
  expect(
    (await f.request(`${base}/${file.id}/content`, f.owner.headers())).status
  ).toBe(404);
  expect(
    (await (await f.request(base, f.owner.headers())).json()).publications
  ).toHaveLength(0);
});

test("workspace worker reads require the matching channel and live canonical owner membership", async () => {
  const f = await fixture();
  const file = await f.publish("s3", "telegram bytes");
  const workerBase = "/v1/sessions/s3/artifact-publications";
  const headers = {
    Authorization: `Bearer ${await createWorkspaceWorkerAuthToken({ channel: "telegram", orgId: "org" })}`,
  };
  expect((await f.request(workerBase, headers)).status).toBe(200);
  expect(
    await (await f.request(`${workerBase}/${file.id}/content`, headers)).text()
  ).toBe("telegram bytes");
  expect((await f.request(base, headers)).status).toBe(404);
  const wrongChannel = {
    Authorization: `Bearer ${await createWorkspaceWorkerAuthToken({ channel: "discord", orgId: "org" })}`,
  };
  expect((await f.request(workerBase, wrongChannel)).status).toBe(404);
  expect(
    (await f.request(`${workerBase}/${file.id}`, headers, "DELETE")).status
  ).toBe(403);
  await f.db.deleteOrgMember("org", "owner");
  expect(
    (await f.request(`${workerBase}/${file.id}/content`, headers)).status
  ).toBe(404);
});
