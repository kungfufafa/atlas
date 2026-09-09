import { afterEach, expect, test } from "bun:test";
import { saveChannelIntegrationPolicy } from "@atlas/core/channel-integration-policy";
import { setupTestConfigDir } from "../../test-config-dir";
import { createNativeChannelHarness } from "../../testing/channel-native-harness";

setupTestConfigDir("atlas-native-settings-");
const opened: Array<Awaited<ReturnType<typeof createNativeChannelHarness>>> =
  [];
afterEach(() => {
  for (const h of opened.splice(0)) {
    h.database.close();
  }
});
for (const channel of ["telegram", "whatsapp", "discord"] as const) {
  test(`${channel}: real browser role guards, CSRF, tenant switching and exact optional policy roundtrip`, async () => {
    const h = await createNativeChannelHarness(channel);
    opened.push(h);
    const tokens = h.authService.createBrowserSessionTokens();
    await h.db.createBrowserSession({
      id: "browser-native",
      userId: h.userId,
      activeOrgId: h.orgId,
      createdAt: new Date().toISOString(),
      csrfTokenHash: h.authService.hashToken(tokens.csrfToken),
      expiresAt: tokens.expiresAt,
      lastUsedAt: null,
      revokedAt: null,
      sessionTokenHash: h.authService.hashToken(tokens.sessionToken),
    });
    const path = `/v1/settings/channels/${channel}/policy`;
    const body = {
      version: 1,
      enabled: false,
      approvals: false,
      groups: {
        allowedSenders: [],
        roles: [],
        allowedTools: [],
        requireMention: false,
      },
      senders: { "*": { actions: { poll: false } } },
      voice: { enabled: false, allowedRoomIds: [] },
    };
    const browser = (
      method: string,
      orgId = h.orgId,
      csrf = true,
      value: unknown = body
    ) =>
      h.app.fetch(
        new Request(`http://localhost:4310${path}`, {
          method,
          headers: {
            Cookie: `atlas_session=${tokens.sessionToken}; atlas_csrf=${tokens.csrfToken}`,
            "Content-Type": "application/json",
            "X-Org-Id": orgId,
            Origin: "http://localhost:4310",
            ...(csrf ? { "X-CSRF-Token": tokens.csrfToken } : {}),
          },
          ...(method === "GET" ? {} : { body: JSON.stringify(value) }),
        })
      );
    for (const role of ["viewer", "member", "admin"] as const) {
      await h.db.upsertOrgMember({
        orgId: h.orgId,
        userId: h.userId,
        role,
        createdAt: new Date().toISOString(),
      });
      expect((await browser("GET")).status).toBe(role === "admin" ? 200 : 403);
      expect((await browser("PUT")).status).toBe(role === "admin" ? 200 : 403);
    }
    expect(await (await browser("GET")).json()).toEqual(body);
    expect((await browser("PUT", h.orgId, false)).status).toBe(403);
    expect(
      (
        await browser("PUT", h.orgId, true, {
          ...body,
          implicitAdminBypass: true,
        })
      ).status
    ).toBe(400);
    expect((await h.request(path, body, { method: "PUT" })).status).toBe(403);
    expect((await h.request(path, undefined, { method: "GET" })).status).toBe(
      403
    );
    const foreignOrg = "other-native-org";
    const now = new Date().toISOString();
    await h.db.upsertOrganization({
      id: foreignOrg,
      name: "Other",
      slug: foreignOrg,
      createdAt: now,
      updatedAt: now,
    });
    expect((await browser("GET", foreignOrg)).status).toBe(404);
    await h.db.upsertOrgMember({
      orgId: foreignOrg,
      userId: h.userId,
      role: "admin",
      createdAt: now,
    });
    await saveChannelIntegrationPolicy(foreignOrg, channel, {
      version: 1,
      approvals: true,
    });
    expect(await (await browser("GET", foreignOrg)).json()).toEqual({
      version: 1,
      approvals: true,
    });
    expect(await (await browser("GET")).json()).toEqual(body);
  });
}
