import { afterEach, describe, expect, test } from "bun:test";
import { createWorkspaceWorkerAuthToken } from "@atlas/core";
import {
  type ChannelIntegrationPolicy,
  saveChannelIntegrationPolicy,
} from "@atlas/core/channel-integration-policy";
import {
  type ChannelNativeActionRequest,
  channelActionReceiptSchema,
  channelNativeActionSchema,
} from "@atlas/core/channel-native-actions";
import { setupTestConfigDir } from "../../test-config-dir";
import { createNativeChannelHarness } from "../../testing/channel-native-harness";

setupTestConfigDir("atlas-native-actions-");
const open: Array<Awaited<ReturnType<typeof createNativeChannelHarness>>> = [];
afterEach(() => {
  for (const h of open.splice(0)) {
    h.database.close();
  }
});
async function harness(
  channel: "telegram" | "whatsapp" | "discord",
  timeout = 5000
) {
  const h = await createNativeChannelHarness(channel, timeout);
  open.push(h);
  return h;
}
async function pending(h: Awaited<ReturnType<typeof harness>>) {
  expect((await h.request("/v1/channel-actions/context", h.actor)).status).toBe(
    200
  );
  const emitted = Promise.withResolvers<ChannelNativeActionRequest>();
  const receipt = h.service.request(
    h.context,
    { kind: "poll", question: "Proceed?", options: ["Yes", "No"] },
    emitted.resolve
  );
  const event = await emitted.promise;
  return { event, receipt, claim: { ...h.actor, requestId: event.id } };
}

describe("native channel action real HTTP + SQLite state machine", () => {
  for (const channel of ["telegram", "whatsapp", "discord"] as const) {
    test(`${channel}: model waits for one authorized platform receipt and cannot replay`, async () => {
      const h = await harness(channel);
      const p = await pending(h);
      let completed = false;
      const waiting = p.receipt.then((value) => {
        completed = true;
        return value;
      });
      await Promise.resolve();
      expect(completed).toBe(false);
      const responses = await Promise.all([
        h.request("/v1/channel-actions/claim", p.claim),
        h.request("/v1/channel-actions/claim", p.claim),
      ]);
      expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
      const accepted = {
        status: "accepted" as const,
        messageId: "native-platform-ack",
      };
      expect(
        (
          await h.request("/v1/channel-actions/complete", {
            ...p.claim,
            receipt: accepted,
          })
        ).status
      ).toBe(200);
      expect(await waiting).toEqual(accepted);
      expect(
        (
          await h.request("/v1/channel-actions/complete", {
            ...p.claim,
            receipt: accepted,
          })
        ).status
      ).toBe(404);
      expect(
        (await h.request("/v1/channel-actions/claim", p.claim)).status
      ).toBe(404);
    });
    test(`${channel}: crossed tenant, channel, sender, room, topic and premature receipt produce zero authorized claims`, async () => {
      const h = await harness(channel);
      const p = await pending(h);
      for (const change of [
        { sessionId: "foreign-session" },
        { channelChatId: "foreign-room" },
        { channelThreadId: "foreign-topic" },
        { channelIsGroup: false },
        { channelUserId: "foreign-actor" },
      ]) {
        const r = await h.request("/v1/channel-actions/claim", {
          ...p.claim,
          ...change,
        });
        expect([403, 404]).toContain(r.status);
      }
      expect(
        (
          await h.request("/v1/channel-actions/claim", p.claim, {
            orgId: "foreign-org",
          })
        ).status
      ).toBe(403);
      const otherChannel = channel === "discord" ? "telegram" : "discord";
      const token = await createWorkspaceWorkerAuthToken({
        channel: otherChannel,
        orgId: h.orgId,
      });
      expect(
        (await h.request("/v1/channel-actions/claim", p.claim, { token }))
          .status
      ).toBe(403);
      expect(
        (
          await h.request("/v1/channel-actions/complete", {
            ...p.claim,
            receipt: { status: "accepted" },
          })
        ).status
      ).toBe(409);
      expect(
        (await h.request("/v1/channel-actions/claim", p.claim)).status
      ).toBe(200);
      expect(
        (
          await h.request("/v1/channel-actions/complete", {
            ...p.claim,
            receipt: {
              status: "failed",
              error: "Controlled transport refused execution",
            },
          })
        ).status
      ).toBe(200);
      expect((await p.receipt).status).toBe("failed");
    });
    for (const revoke of [
      "role",
      "membership",
      "assignment",
      "tool-rule",
      "action-rule",
      "sender-rule",
      "room-rule",
    ] as const) {
      test(`${channel}: ${revoke} revoked after request blocks the actual claim`, async () => {
        const h = await harness(channel);
        const p = await pending(h);
        if (revoke === "role") {
          await h.db.upsertOrgMember({
            orgId: h.orgId,
            userId: h.userId,
            role: "viewer",
            createdAt: new Date().toISOString(),
          });
        } else if (revoke === "membership") {
          await h.db.deleteOrgMember(h.orgId, h.userId);
        } else if (revoke === "assignment") {
          await h.db.unassignToolFromProfile(
            h.profileId,
            "native_action_fixture"
          );
        } else {
          const policy: ChannelIntegrationPolicy = { version: 1 };
          if (revoke === "tool-rule") {
            policy.groups = { allowedTools: [] };
          }
          if (revoke === "action-rule") {
            policy.actions = { poll: false };
          }
          if (revoke === "sender-rule") {
            policy.senders = { [h.actor.channelUserId]: { enabled: false } };
          }
          if (revoke === "room-rule") {
            policy.rooms = { [h.actor.channelChatId]: { enabled: false } };
          }
          await saveChannelIntegrationPolicy(h.orgId, channel, policy);
        }
        expect(
          (await h.request("/v1/channel-actions/claim", p.claim)).status
        ).toBe(403);
        expect((await p.receipt).status).toBe("failed");
      });
    }
    test(`${channel}: an acknowledged effect remains recorded after later membership revocation`, async () => {
      const h = await harness(channel);
      const p = await pending(h);
      expect(
        (await h.request("/v1/channel-actions/claim", p.claim)).status
      ).toBe(200);
      await h.db.deleteOrgMember(h.orgId, h.userId);
      expect(
        (
          await h.request("/v1/channel-actions/complete", {
            ...p.claim,
            receipt: { status: "accepted", messageId: "already-sent" },
          })
        ).status
      ).toBe(200);
      expect(await p.receipt).toEqual({
        status: "accepted",
        messageId: "already-sent",
      });
      await expect(
        h.service.request(
          h.context,
          { kind: "delete", messageId: "already-sent" },
          () => {}
        )
      ).rejects.toMatchObject({ status: 403 });
    });
    test(`${channel}: post-claim uncertainty blocks an identical automatic resend`, async () => {
      const h = await harness(channel, 100);
      const p = await pending(h);
      expect(
        (await h.request("/v1/channel-actions/claim", p.claim)).status
      ).toBe(200);
      expect((await p.receipt).status).toBe("unknown");
      await expect(
        h.service.request(h.context, p.event.action, () => {})
      ).rejects.toMatchObject({ status: 409 });
      expect(
        (
          await h.request("/v1/channel-actions/complete", {
            ...p.claim,
            receipt: { status: "accepted" },
          })
        ).status
      ).toBe(404);
    });
    test(`${channel}: turn cancellation before a claim denies later execution`, async () => {
      const h = await harness(channel);
      const controller = new AbortController();
      h.context.signal = controller.signal;
      const p = await pending(h);
      controller.abort();
      expect((await p.receipt).status).toBe("failed");
      expect(
        (await h.request("/v1/channel-actions/claim", p.claim)).status
      ).toBe(404);
    });
  }
});

test("action inputs cannot inject a destination, and failures cannot masquerade as successful tool output", () => {
  expect(
    channelNativeActionSchema.safeParse({
      kind: "react",
      emoji: "✅",
      channelChatId: "foreign",
    }).success
  ).toBe(false);
  expect(
    channelNativeActionSchema.safeParse({ kind: "topic_edit" }).success
  ).toBe(false);
  expect(
    channelNativeActionSchema.safeParse({ kind: "topic_edit", closed: false })
      .success
  ).toBe(true);
  expect(
    channelActionReceiptSchema.safeParse({ status: "unknown" }).success
  ).toBe(false);
  expect(
    channelActionReceiptSchema.safeParse({
      status: "accepted",
      error: "delivery failed",
    }).success
  ).toBe(false);
});

test.each(["telegram", "whatsapp", "discord"] as const)(
  "%s: binding a guest conversation preserves file policy while native effects remain denied",
  async (channel) => {
    const h = await harness(channel);
    const userId = "user_channel_guest_native_fixture";
    const now = new Date().toISOString();
    await h.db.createUser({
      id: userId,
      email: "guest-native@example.test",
      passwordHash: "!disabled!",
      isPlatformAdmin: false,
      createdAt: now,
      updatedAt: now,
    });
    await h.db.upsertOrgMember({
      orgId: h.orgId,
      userId,
      role: "member",
      createdAt: now,
    });
    await h.db.upsertChannelOrgMapping({
      orgId: h.orgId,
      channel,
      channelUserId: h.actor.channelUserId,
      userId,
      createdAt: now,
    });
    await h.db.upsertSession({
      ...(await h.db.getSession(h.sessionId))!,
      userId,
    });
    h.context.userId = userId;
    expect(
      (await h.request("/v1/channel-actions/context", h.actor)).status
    ).toBe(200);
    await expect(
      h.service.authorizeTool(h.orgId, h.sessionId, channel, "calculator")
    ).resolves.toBeUndefined();
    let published = false;
    await expect(
      h.service.request(
        h.context,
        { kind: "poll", question: "No guest effects", options: ["A", "B"] },
        () => {
          published = true;
        }
      )
    ).rejects.toMatchObject({ status: 403 });
    expect(published).toBe(false);
    await saveChannelIntegrationPolicy(h.orgId, channel, {
      version: 1,
      groups: { allowedTools: [] },
    });
    await expect(
      h.service.authorizeTool(h.orgId, h.sessionId, channel, "calculator")
    ).rejects.toMatchObject({ status: 403 });
  }
);

for (const channel of ["telegram", "whatsapp", "discord"] as const) {
  test(`${channel}: a real pending approval cannot be decided from another room or topic`, async () => {
    const { ChatToolApprovalService } = await import(
      "../../services/chat-tool-approval-service"
    );
    const { ExecutionPlaneService } = await import(
      "../../services/execution-plane-service"
    );
    const h = await harness(channel);
    const approvalService = new ChatToolApprovalService(
      h.db,
      new ExecutionPlaneService(h.db)
    );
    h.routeAgent.decideChatToolApproval =
      approvalService.decide.bind(approvalService);
    await h.service.bind(h.orgId, channel, h.actor);
    const principal = {
      orgId: h.orgId,
      userId: h.userId,
      orgRole: "member" as const,
      isPlatformAdmin: false,
    };
    const ready = Promise.withResolvers<void>();
    const waiting = approvalService.request(
      {
        approval: {
          consequenceSummary: "Removes the selected fixture file",
          id: "bound-native-approval",
          status: "pending",
          title: "Delete",
          tool: "delete_file",
          toolCallId: "delete-1",
          createdAt: new Date().toISOString(),
        },
        call: {
          id: "delete-1",
          name: "delete_file",
          arguments: { path: "artifacts/test.txt" },
        },
        runId: "bound-native-run",
        sessionId: h.sessionId,
        principal,
        beforeDecision: () => Promise.resolve(),
      },
      ready.resolve
    );
    await ready.promise;
    const body = {
      ...h.actor,
      approvalId: "bound-native-approval",
      decision: "denied",
    };
    for (const change of [
      { channelChatId: "foreign-room" },
      { channelThreadId: "foreign-topic" },
      { channelIsGroup: false },
    ]) {
      expect(
        (
          await h.request("/v1/channel-principals/approvals/decide", {
            ...body,
            ...change,
          })
        ).status
      ).toBe(403);
      expect(
        (await h.db.getActionApproval("bound-native-approval"))?.status
      ).toBe("pending");
    }
    expect(
      (await h.request("/v1/channel-principals/approvals/decide", body)).status
    ).toBe(200);
    expect(await waiting).toMatchObject({ decision: "denied" });
    expect(
      (await h.db.getActionApproval("bound-native-approval"))?.status
    ).toBe("denied");
    expect(
      (await h.request("/v1/channel-principals/approvals/decide", body)).status
    ).toBe(409);
  });
}
