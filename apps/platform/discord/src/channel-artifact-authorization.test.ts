import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createClient, type RemoteChatSession } from "@atlas/client";
import { type ChatMessage, getProfileSoulDir } from "@atlas/core";
import { saveChannelIntegrationPolicy } from "@atlas/core/channel-integration-policy";
import type { TextBasedChannel } from "discord.js";
import { setupTestConfigDir } from "../../../server/src/test-config-dir";
import { createNativeChannelHarness } from "../../../server/src/testing/channel-native-harness";
import {
  deliverDiscordTurnArtifactShares,
  maybeSendRequestedDiscordArtifactAttachment,
  uploadDiscordArtifactFromToolResult,
} from "./channel-artifact-flow";
import type { DiscordMessenger } from "./messenger";
import { SessionStore } from "./session-store";

setupTestConfigDir("atlas-discord-artifact-authority-");
const open: Awaited<ReturnType<typeof createNativeChannelHarness>>[] = [];
afterEach(() => {
  for (const h of open.splice(0)) {
    h.database.close();
  }
});

test("unmentioned file turn retains its origin when artifact delivery rechecks mention policy", async () => {
  const h = await fixture();
  await saveChannelIntegrationPolicy(h.orgId, "discord", {
    groups: { requireMention: true },
    version: 1,
  });
  await expect(
    deliverDiscordTurnArtifactShares({
      ...h.input,
      channelAddressed: false,
    })
  ).rejects.toThrow();
  expect(h.requests.at(-1)?.status).toBe(403);
  expect(h.uploads).toEqual([]);
  expect(h.sent).toEqual([]);
  await deliverDiscordTurnArtifactShares({
    ...h.input,
    channelAddressed: true,
  });
  expect(h.uploads).toHaveLength(1);
});

type Change = "removed" | "room-disabled" | "viewer";
type Flow = "tool" | "attach" | "turn";

async function fixture(count = 1, format: "text" | "svg" = "text") {
  const h = await createNativeChannelHarness("discord");
  open.push(h);
  const directory = join(getProfileSoulDir(h.orgId, h.profileId), "artifacts");
  await mkdir(directory, { recursive: true });
  const content =
    format === "svg"
      ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>'
      : "tenant-secret";
  const extension = format === "svg" ? "svg" : "txt";
  const sizeBytes = Buffer.byteLength(content);
  const artifacts = Array.from({ length: count }, (_, index) => ({
    filename: `report-${index}.${extension}`,
    mimeType: format === "svg" ? "image/svg+xml" : "text/plain",
    path: `report-${index}.${extension}`,
    savedAt: new Date().toISOString(),
    sharePath: null,
    shareUrl: null,
    sizeBytes,
  }));
  const messages: ChatMessage[] = [{ content: "Save reports", role: "user" }];
  for (const [index, artifact] of artifacts.entries()) {
    const path = join(directory, artifact.path);
    await writeFile(path, content);
    messages.push({
      content: JSON.stringify({ bytesWritten: sizeBytes, path }),
      name: "write_file",
      role: "tool",
      toolCallId: `write-${index}`,
    });
  }
  await h.db.appendMessagesForSession(
    h.sessionId,
    messages.map((payload, seq) => ({
      createdAt: new Date().toISOString(),
      id: crypto.randomUUID(),
      payload,
      seq,
      sessionId: h.sessionId,
    }))
  );
  Object.assign(h.routeAgent, {
    readProfileArtifact: h.agent.readProfileArtifact.bind(h.agent),
  });
  const requests: Array<{ path: string; status: number }> = [];
  const hooks: {
    afterRead?: () => Promise<void>;
    afterSend?: () => Promise<void>;
  } = {};
  const client = createClient({
    authToken: h.token,
    baseUrl: "http://localhost:4310",
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      const response = await h.app.fetch(request);
      requests.push({ path, status: response.status });
      if (path.endsWith("/artifacts/content") && response.ok) {
        await hooks.afterRead?.();
      }
      return response;
    }) as typeof fetch,
    orgId: h.orgId,
    tokenAuth: true,
  });
  const uploads: Buffer[] = [];
  const sent: string[] = [];
  const channel = {
    id: h.actor.channelChatId,
    isDMBased: () => false,
    isThread: () => false,
    send: async (payload: { files: Array<{ attachment: Buffer }> }) => {
      uploads.push(Buffer.from(payload.files[0]!.attachment));
      await hooks.afterSend?.();
      return { id: "sent" };
    },
  } as unknown as TextBasedChannel;
  const store = new SessionStore(join(directory, "sessions.json"));
  store.set("conversation", {
    artifactShareUrls: {},
    channelUserId: h.actor.channelUserId,
    deliverableArtifacts: artifacts,
    profileId: h.profileId,
    sessionId: h.sessionId,
    updatedAt: new Date().toISOString(),
  });
  const session = {
    getMessages: async () => messages,
    id: h.sessionId,
  } as RemoteChatSession;
  const input = {
    channel,
    channelUserId: h.actor.channelUserId,
    client,
    conversationKey: "conversation",
    messenger: {
      send: async (text: string) => {
        sent.push(text);
      },
    } as unknown as DiscordMessenger,
    profileId: h.profileId,
    session,
    sessionId: h.sessionId,
    sessionStore: store,
  };
  const change = async (kind: Change) => {
    if (kind === "removed") {
      await h.db.deleteOrgMember(h.orgId, h.userId);
    } else if (kind === "room-disabled") {
      await saveChannelIntegrationPolicy(h.orgId, "discord", {
        rooms: { [h.actor.channelChatId]: { enabled: false } },
        version: 1,
      });
    } else {
      await h.db.upsertOrgMember({
        createdAt: new Date().toISOString(),
        orgId: h.orgId,
        role: "viewer",
        userId: h.userId,
      });
    }
  };
  const run = async (flow: Flow) => {
    if (flow === "tool") {
      await uploadDiscordArtifactFromToolResult({
        ...input,
        result: { ...artifacts[0], ok: true },
      });
    } else if (flow === "attach") {
      await maybeSendRequestedDiscordArtifactAttachment({
        ...input,
        attachUserText: "/attach",
      });
    } else {
      await deliverDiscordTurnArtifactShares(input);
    }
  };
  return {
    ...h,
    artifacts,
    change,
    hooks,
    input,
    requests,
    run,
    sent,
    store,
    uploads,
  };
}

for (const flow of ["tool", "attach", "turn"] as const) {
  for (const change of ["removed", "room-disabled", "viewer"] as const) {
    test(`${flow}: actual HTTP artifact read then ${change} uses current read authority before delivery`, async () => {
      const h = await fixture();
      h.hooks.afterRead = () => h.change(change);
      await h.run(flow).catch(() => undefined);
      expect(
        h.requests
          .filter((r) => r.path.endsWith("/artifacts/content"))
          .map((r) => r.status)
      ).toEqual([200]);
      if (change === "viewer") {
        expect(h.uploads.map((bytes) => bytes.toString())).toEqual([
          "tenant-secret",
        ]);
      } else {
        expect(h.uploads).toEqual([]);
        expect(h.sent).toEqual([]);
        expect(h.requests.at(-1)?.status).toBe(403);
      }
    });
  }
}

for (const change of ["removed", "room-disabled"] as const) {
  test(`cached share footer after store save obeys ${change}`, async () => {
    const h = await fixture();
    // Viewer can read the file but cannot mint a new public share; the genuine
    // HTTP denial exercises the previously saved share URL fallback.
    await h.change("viewer");
    h.store.updateArtifactState("conversation", {
      artifactShareUrls: {
        [h.artifacts[0]!.path]: "https://example.test/s/cached-private",
      },
    });
    const save = h.store.save.bind(h.store);
    h.store.save = async () => {
      await save();
      await h.change(change);
    };
    await deliverDiscordTurnArtifactShares({
      ...h.input,
      skipPaths: h.artifacts.map((a) => a.path),
    }).catch(() => undefined);
    expect(h.uploads).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(
      h.requests
        .filter((r) => r.path.endsWith("/artifacts/shares"))
        .map((r) => r.status)
    ).toEqual([404]);
    expect(h.store.getDeliverableArtifacts("conversation")[0]?.shareUrl).toBe(
      "https://example.test/s/cached-private"
    );
    expect(h.requests.at(-1)?.status).toBe(403);
  });
  test(`after first upload ${change} blocks next artifact read and share footer`, async () => {
    const h = await fixture(2);
    h.hooks.afterSend = () => h.change(change);
    await h.run("turn").catch(() => undefined);
    expect(h.uploads.map((bytes) => bytes.toString())).toEqual([
      "tenant-secret",
    ]);
    expect(
      h.requests.filter((r) => r.path.endsWith("/artifacts/content"))
    ).toHaveLength(1);
    expect(h.sent).toEqual([]);
    expect(h.requests.at(-1)?.status).toBe(403);
  });
}

test("viewer retains ordinary artifact delivery and a previously published share URL", async () => {
  const h = await fixture();
  await h.change("viewer");
  h.store.updateArtifactState("conversation", {
    artifactShareUrls: {
      [h.artifacts[0]!.path]: "https://example.test/s/cached-private",
    },
  });
  await h.run("turn");
  expect(h.uploads.map((bytes) => bytes.toString())).toEqual(["tenant-secret"]);
  expect(h.sent.join("\n")).toContain("https://example.test/s/cached-private");
  expect(
    h.requests
      .filter((r) => r.path.endsWith("/artifacts/shares"))
      .map((r) => r.status)
  ).toEqual([404]);
});

test("SVG artwork remains available through a share link", async () => {
  const h = await fixture(1, "svg");
  const path = h.artifacts[0]!.path;

  await h.run("turn");

  const [artifact] = h.store.getDeliverableArtifacts("conversation");
  const sharePath = artifact?.sharePath ?? "";
  expect(h.uploads).toEqual([]);
  expect(sharePath).toMatch(/^\/s\//);
  expect(h.sent.join("\n")).toContain(sharePath);
  expect(artifact).toMatchObject({ mimeType: "image/svg+xml", path });
});

test("attach cannot deliver old session bytes after its local conversation is replaced", async () => {
  const h = await fixture();
  h.hooks.afterRead = async () => {
    h.store.set("conversation", {
      ...h.store.get("conversation")!,
      sessionId: "replacement-session",
    });
  };
  await h.run("attach");
  expect(
    h.requests
      .filter((r) => r.path.endsWith("/artifacts/content"))
      .map((r) => r.status)
  ).toEqual([200]);
  expect(h.uploads).toEqual([]);
  expect(h.sent).toEqual([]);
});

for (const flow of ["tool", "attach"] as const) {
  test(`${flow}: transport failure after membership removal exposes no saved path`, async () => {
    const h = await fixture();
    h.hooks.afterSend = async () => {
      await h.change("removed");
      throw new Error("Upload failed");
    };
    await h.run(flow).catch(() => undefined);
    expect(h.uploads.map((bytes) => bytes.toString())).toEqual([
      "tenant-secret",
    ]);
    expect(h.sent).toEqual([]);
    expect(h.requests.at(-1)?.status).toBe(403);
  });
}
