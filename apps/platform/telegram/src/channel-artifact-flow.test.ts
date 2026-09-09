import { expect, test } from "bun:test";
import { join } from "node:path";
import { createClient, type RemoteChatSession } from "@atlas/client";
import { saveChannelIntegrationPolicy } from "@atlas/core/channel-integration-policy";
import { setupTestConfigDir } from "../../../server/src/test-config-dir";
import { createNativeChannelHarness } from "../../../server/src/testing/channel-native-harness";
import {
  deliverTelegramTurnArtifactShares,
  maybeSendRequestedTelegramArtifactAttachment,
} from "./channel-artifact-flow";
import { createTelegramRichMessenger } from "./rich-message";
import { SessionStore } from "./session-store";
import { createMessageContext } from "./test-helpers";

setupTestConfigDir("atlas-telegram-artifact-final-authority-");

type Harness = Awaited<ReturnType<typeof createNativeChannelHarness>>;
type AuthorityChange = "unchanged" | "viewer" | "removed" | "room-disabled";
async function changeAuthority(h: Harness, change: AuthorityChange) {
  if (change === "viewer") {
    await h.db.upsertOrgMember({
      createdAt: new Date().toISOString(),
      orgId: h.orgId,
      role: "viewer",
      userId: h.userId,
    });
  } else if (change === "removed") {
    await h.db.deleteOrgMember(h.orgId, h.userId);
  } else if (change === "room-disabled") {
    await saveChannelIntegrationPolicy(h.orgId, "telegram", {
      rooms: { "-100": { enabled: false } },
      version: 1,
    });
  }
}

async function fixture(
  stage: "read" | "save" | "send",
  options: {
    oversize?: boolean;
    native?: boolean;
    second?: boolean;
    failedSend?: boolean;
  } = {}
) {
  const h = await createNativeChannelHarness("telegram");
  const paused = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const mock = createMessageContext({
    chatId: -100,
    chatType: "supergroup",
    messageThreadId: 77,
    replyToBot: true,
    text: "/attach",
    userId: Number(h.actor.channelUserId),
  });
  const artifact = {
    filename: "private-note.txt",
    mimeType: "text/plain",
    path: "artifacts/private-note.txt",
    savedAt: new Date().toISOString(),
    sharePath: "/shared/private-token",
    shareUrl: "https://example.test/shared/private-token",
    sizeBytes: options.oversize ? 30_000_000 : 12,
  };
  const second = {
    ...artifact,
    filename: "second-private.txt",
    path: "artifacts/second-private.txt",
  };
  const store = new SessionStore(
    join(process.env.ATLAS_CONFIG_DIR!, "sessions.json")
  );
  store.set("conversation", {
    artifactShareUrls: {
      [artifact.path]: artifact.shareUrl,
      [second.path]: second.shareUrl,
    },
    channelUserId: h.actor.channelUserId,
    deliverableArtifacts: [artifact],
    profileId: h.profileId,
    sessionId: h.sessionId,
    updatedAt: artifact.savedAt,
  });
  const originalSave = store.save.bind(store);
  store.save = async () => {
    await originalSave();
    if (stage === "save") {
      paused.resolve();
      await release.promise;
    }
  };
  const originalSend = mock.ctx.api.sendDocument.bind(mock.ctx.api);
  mock.ctx.api.sendDocument = async (...args) => {
    const result = await originalSend(...args);
    if (stage === "send") {
      paused.resolve();
      await release.promise;
    }
    if (options.failedSend) {
      throw new Error("Synthetic upload rejection");
    }
    return result;
  };
  const client = createClient({
    authToken: h.token,
    baseUrl: "http://localhost:4310",
    fetch: ((url, init) => h.app.fetch(new Request(url, init))) as typeof fetch,
    orgId: h.orgId,
    tokenAuth: true,
  });
  let reads = 0;
  client.readProfileArtifactContent = async () => {
    reads += 1;
    if (stage === "read") {
      paused.resolve();
      await release.promise;
    }
    return {
      contentType: "text/plain",
      data: new TextEncoder().encode("tenant bytes").buffer,
    };
  };
  client.publishProfileArtifactShare = async () => {
    throw new Error("Synthetic publication outage; exercise the cached link");
  };
  const input = {
    client,
    conversationKey: "conversation",
    ctx: mock.ctx,
    messenger: createTelegramRichMessenger(mock.ctx),
    profileId: h.profileId,
    sessionStore: store,
  };
  return {
    artifact,
    h,
    mock,
    paused,
    reads: () => reads,
    release,
    run: (kind: "attach" | "turn") =>
      kind === "attach"
        ? maybeSendRequestedTelegramArtifactAttachment({
            ...input,
            attachUserText: "/attach",
          })
        : deliverTelegramTurnArtifactShares({
            ...input,
            nativeMediaPaths: options.native
              ? new Set([artifact.path])
              : undefined,
            session: {
              getMessages: async () => [],
              id: h.sessionId,
            } as unknown as RemoteChatSession,
            streamedArtifacts: options.second ? [artifact, second] : [artifact],
          }),
    store,
  };
}

test("attach: replacing the saved session during a deferred read cannot authorize bytes from the old session", async () => {
  const f = await fixture("read");
  const running = f.run("attach").catch(() => undefined);
  try {
    await f.paused.promise;
    const original = await f.h.db.getSession(f.h.sessionId);
    expect(original).not.toBeNull();
    const newSessionId = `replacement-${crypto.randomUUID()}`;
    await f.h.db.upsertSession({ ...original!, id: newSessionId });
    f.store.set("conversation", {
      ...f.store.get("conversation")!,
      sessionId: newSessionId,
    });
    f.release.resolve();
    await running;
    expect(f.mock.documentSends).toBe(0);
    const output = f.mock.replies.join("\n");
    expect(output).not.toContain(f.artifact.filename);
    expect(output).not.toContain(f.artifact.path);
    expect(output).not.toContain(f.artifact.shareUrl);
  } finally {
    f.release.resolve();
    await running;
    f.h.database.close();
  }
});

for (const kind of ["attach", "turn"] as const) {
  for (const change of [
    "unchanged",
    "viewer",
    "removed",
    "room-disabled",
  ] as const) {
    test(`${kind}: deferred read rechecks ${change} canonical authority before bytes or cached links`, async () => {
      const f = await fixture("read");
      const running = f.run(kind).catch(() => undefined);
      try {
        await f.paused.promise;
        expect(f.mock.documentSends).toBe(0);
        await changeAuthority(f.h, change);
        f.release.resolve();
        await running;
        const allowed = change === "unchanged" || change === "viewer";
        expect(f.mock.documentSends).toBe(allowed ? 1 : 0);
        const output = f.mock.replies.join("\n");
        if (allowed && kind === "turn") {
          expect(output).toContain(f.artifact.shareUrl);
        }
        if (!allowed) {
          expect(output).not.toContain(f.artifact.filename);
          expect(output).not.toContain(f.artifact.path);
          expect(output).not.toContain(f.artifact.shareUrl);
        }
      } finally {
        f.release.resolve();
        await running;
        f.h.database.close();
      }
    });
  }
}

for (const variant of [
  "oversize",
  "cached-native-footer",
  "second-file",
  "failed-upload",
] as const) {
  test(`turn: ${variant} disclosure rechecks policy after its preceding asynchronous effect`, async () => {
    const f = await fixture(
      variant === "oversize" || variant === "cached-native-footer"
        ? "save"
        : "send",
      {
        failedSend: variant === "failed-upload",
        native: variant === "cached-native-footer",
        oversize: variant === "oversize",
        second: variant === "second-file",
      }
    );
    const running = f.run("turn").catch(() => undefined);
    try {
      await f.paused.promise;
      const sendsBeforeRevocation = f.mock.documentSends;
      const readsBeforeRevocation = f.reads();
      await changeAuthority(f.h, "room-disabled");
      f.release.resolve();
      await running;
      expect(f.mock.documentSends).toBe(sendsBeforeRevocation);
      expect(f.reads()).toBe(readsBeforeRevocation);
      const output = f.mock.replies.join("\n");
      expect(output).not.toContain(f.artifact.filename);
      expect(output).not.toContain(f.artifact.path);
      expect(output).not.toContain(f.artifact.shareUrl);
      expect(output).not.toContain("second-private");
    } finally {
      f.release.resolve();
      await running;
      f.h.database.close();
    }
  });
}
