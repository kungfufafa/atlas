import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createClient,
  type SendStreamOptions,
  type StreamHandlers,
} from "@atlas/client";
import {
  createWorkspaceWorkerAuthToken,
  isChannelGuestUserId,
  resolveLocalAuthToken,
} from "@atlas/core";
import { saveChannelIntegrationPolicy } from "@atlas/core/channel-integration-policy";
import type { ChannelActionReceipt } from "@atlas/core/channel-native-actions";
import type { ChannelAccessMode, SendMessageInput } from "@atlas/core/contract";
import { writePrivateTextFile } from "@atlas/core/fs";
import { MAX_DOCUMENT_BYTES } from "@atlas/core/message-content";
import { getProfileSoulDir } from "@atlas/core/soul";
import {
  getWhatsAppConfigDir,
  getWhatsAppConfigPath,
  loadWhatsAppConfigFile,
  regenerateWhatsAppPairingCode,
  rememberWhatsAppLidPhone,
  saveWhatsAppConfig,
} from "@atlas/core/whatsapp-config";
import { createSqliteDatabase } from "@atlas/db";
import type { WASocket } from "@whiskeysockets/baileys";
import { createMinimalHonoApp } from "../../../server/src/http/test-app-helpers";
import { AgentService } from "../../../server/src/services/agent-service";
import {
  registerActiveStream,
  resetActiveStreamsForTests,
} from "./active-stream";
import { WhatsAppAuthStore } from "./auth-store";
import {
  createChatHandler,
  resetChatLocksForTests,
  resolveWhatsAppSessionKey,
} from "./chat-handler";
import { SessionStore } from "./session-store";
import { createTestOrgStore, withTempHome } from "./test-helpers";

const ORG_ID = "org_whatsapp_matrix";
const PROFILE_ID = "profile_whatsapp_matrix";
const SENDER = "6281111111111@s.whatsapp.net";
const OWNER = "6289999999999@s.whatsapp.net";
const GROUP = "120363042000000000@g.us";
const ACTORS = [
  "admin",
  "member",
  "viewer",
  "removed",
  "guest",
  "blocked",
] as const;
type Actor = (typeof ACTORS)[number];

beforeEach(() => {
  resetActiveStreamsForTests();
  resetChatLocksForTests();
});

async function withHarness(
  input: {
    accessMode: ChannelAccessMode;
    actor: Actor;
    isGroup: boolean;
    credential?: "local";
  },
  run: (harness: Awaited<ReturnType<typeof createHarness>>) => Promise<void>
) {
  await withTempHome(async (homeDir) => {
    const harness = await createHarness(homeDir, input);
    try {
      await run(harness);
    } finally {
      harness.database.close();
    }
  });
}

async function createHarness(
  homeDir: string,
  input: {
    accessMode: ChannelAccessMode;
    actor: Actor;
    isGroup: boolean;
    credential?: "local";
  }
) {
  const database = await createSqliteDatabase(":memory:");
  const db = database.adapter;
  const now = new Date().toISOString();
  await db.upsertOrganization({
    createdAt: now,
    id: ORG_ID,
    name: "WhatsApp Matrix",
    slug: "whatsapp-matrix",
    updatedAt: now,
  });
  await db.upsertProfile({
    createdAt: now,
    id: PROFILE_ID,
    isDefault: true,
    isSuper: false,
    model: null,
    name: "Assistant",
    orgId: ORG_ID,
    systemPrompt: "",
    updatedAt: now,
  });
  if (input.actor !== "guest") {
    await db.createUser({
      createdAt: now,
      email: "channel-user@example.test",
      id: "matrix_user",
      isPlatformAdmin: false,
      name: "Channel User",
      passwordHash: "!disabled!",
      updatedAt: now,
    });
    if (input.actor !== "removed") {
      await db.upsertOrgMember({
        createdAt: now,
        orgId: ORG_ID,
        role: input.actor === "blocked" ? "member" : input.actor,
        userId: "matrix_user",
      });
    }
    await db.upsertChannelOrgMapping({
      channel: "whatsapp",
      channelUserId: SENDER,
      createdAt: now,
      orgId: ORG_ID,
      userId: "matrix_user",
    });
  }
  await writePrivateTextFile(
    getWhatsAppConfigPath(ORG_ID),
    [
      `profile_id=${PROFILE_ID}`,
      "phone_number=6289999999999",
      `paired_jid=${input.actor === "guest" || input.actor === "blocked" ? OWNER : SENDER}`,
      `access_mode=${input.accessMode}`,
      `allowed_numbers=${input.actor === "blocked" ? "" : "6281111111111"}`,
      `blocked_numbers=${input.actor === "blocked" ? "6281111111111" : ""}`,
      "",
    ].join("\n"),
    { ensureDir: getWhatsAppConfigDir(ORG_ID) }
  );
  const agent = new AgentService(null, null, db);
  const { app } = createMinimalHonoApp({ agent, databaseAdapter: db });
  const requests: Array<{ path: string; status: number }> = [];
  const client = createClient({
    authToken:
      input.credential === "local"
        ? await resolveLocalAuthToken()
        : await createWorkspaceWorkerAuthToken({
            channel: "whatsapp",
            orgId: ORG_ID,
          }),
    baseUrl: "http://localhost:4310",
    fetch: (async (url, init) => {
      const request = new Request(url, init);
      const response = await app.fetch(request);
      requests.push({
        path: new URL(request.url).pathname,
        status: response.status,
      });
      return response;
    }) as typeof fetch,
    orgId: ORG_ID,
    tokenAuth: true,
  });
  const sessionStore = new SessionStore(path.join(homeDir, "sessions.json"));
  let stream:
    | ((
        sessionId: string,
        input: SendMessageInput,
        handlers: StreamHandlers,
        options?: SendStreamOptions
      ) => Promise<string | undefined>)
    | undefined;
  const originalCreateChatSession = client.createChatSession.bind(client);
  client.createChatSession = (sessionId, channel) => {
    const session = originalCreateChatSession(sessionId, channel);
    const originalSendStream = session.sendStream.bind(session);
    session.sendStream = async (...args) => {
      const [input, handlers, options] = args;
      const result = await stream?.(
        sessionId,
        typeof input === "string" ? { message: input } : input,
        typeof handlers === "function" ? { onChunk: handlers } : handlers,
        options
      );
      return result ?? originalSendStream(...args);
    };
    return session;
  };
  const sent: unknown[] = [];
  let unknownDocumentOutcome = false;
  let downloads = 0;
  let mediaBytes = Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 65);
  let onDownload: (() => Promise<void>) | undefined;
  let onFileSent: (() => Promise<void>) | undefined;
  const socket = {
    sendMessage: async (jid: string, content: unknown) => {
      sent.push(content);
      if (
        typeof content === "object" &&
        content !== null &&
        "document" in content
      ) {
        await onFileSent?.();
      }
      if (
        unknownDocumentOutcome &&
        typeof content === "object" &&
        content !== null &&
        "document" in content
      ) {
        throw new Error("Acknowledgement lost after upload");
      }
      return {
        key: { fromMe: true, id: `sent_${sent.length}`, remoteJid: jid },
      };
    },
    sendPresenceUpdate: async () => undefined,
  } as unknown as WASocket;
  const handler = createChatHandler({
    authStore: new WhatsAppAuthStore(ORG_ID),
    client,
    config: { phoneNumber: "6289999999999", profileId: PROFILE_ID },
    downloadMedia: async () => {
      downloads += 1;
      await onDownload?.();
      return mediaBytes;
    },
    fixedWorkspaceId: ORG_ID,
    getSocket: () => socket,
    orgStore: createTestOrgStore(homeDir),
    sessionStore,
  });
  const message = {
    isGroup: input.isGroup,
    jid: input.isGroup ? GROUP : SENDER,
    senderJid: SENDER,
    senderJids: [SENDER],
    text: "/new",
  };
  const sessionKey = resolveWhatsAppSessionKey(message.jid, SENDER);
  return {
    agent,
    client,
    database,
    db,
    downloads: () => downloads,
    handler,
    message,
    requests,
    sent,
    sessionKey,
    sessionStore,
    setMediaBytes: (bytes: Buffer) => {
      mediaBytes = bytes;
    },
    setOnDownload: (callback: () => Promise<void>) => {
      onDownload = callback;
    },
    setOnFileSent: (callback: () => Promise<void>) => {
      onFileSent = callback;
    },
    setStream: (callback: NonNullable<typeof stream>) => {
      stream = callback;
    },
    setUnknownDocumentOutcome: () => {
      unknownDocumentOutcome = true;
    },
  };
}

describe("WhatsApp production handler, HTTP authorization, and SQLite", () => {
  for (const isGroup of [false, true]) {
    test(`each subsequent ${isGroup ? "group" : "DM"} artifact upload rechecks authority after an earlier delivery`, async () => {
      await withHarness(
        { accessMode: "pairing", actor: "member", isGroup },
        async (h) => {
          await h.handler(h.message);
          const sessionId = h.sessionStore.get(h.sessionKey)!.sessionId;
          const now = new Date().toISOString();
          const folder = path.join(
            getProfileSoulDir(ORG_ID, PROFILE_ID),
            "artifacts"
          );
          await mkdir(folder, { recursive: true });
          const names = ["first.txt", "second.txt"];
          for (const [index, filename] of names.entries()) {
            await writeFile(path.join(folder, filename), filename);
            await h.db.appendMessagesForSession(sessionId, [
              {
                createdAt: now,
                id: filename,
                payload: {
                  content: JSON.stringify({
                    bytesWritten: filename.length,
                    path: `artifacts/${filename}`,
                  }),
                  name: "write_file",
                  role: "tool",
                  toolCallId: filename,
                },
                seq: index + 1,
                sessionId,
              },
            ]);
          }
          h.setStream(async (_session, _input, handlers) => {
            for (const filename of names) {
              handlers.onArtifactCreated?.({
                createdAt: now,
                filename,
                id: filename,
                mimeType: "text/plain",
                path: `artifacts/${filename}`,
                sessionId,
                size: filename.length,
                type: "file",
              });
            }
            return "Files ready.";
          });
          h.setOnFileSent(async () => {
            await h.db.deleteOrgMember(ORG_ID, "matrix_user");
          });
          h.sent.length = 0;
          await h.handler({
            ...h.message,
            me: { id: OWNER },
            mentionedJids: isGroup ? [OWNER] : [],
            text: "Run report",
          });
          const documents = h.sent.filter(
            (item): item is { fileName: string; document: Buffer } =>
              typeof item === "object" && item !== null && "document" in item
          );
          expect(documents.length).toBe(1);
          const withheld = names.find(
            (name) => name !== documents[0]!.fileName
          )!;
          expect(JSON.stringify(h.sent)).not.toContain(withheld);
          expect(
            h.requests.some(
              (item) =>
                item.path === "/v1/channel-principals/authorize" &&
                item.status === 403
            )
          ).toBe(true);
        }
      );
    });
  }
  for (const isGroup of [false, true]) {
    for (const flow of ["turn", "attach", "share"] as const) {
      for (const revocation of [
        "membership",
        "blocked",
        "room",
        "session",
        "viewer",
      ] as const) {
        test(`late ${isGroup ? "group" : "DM"} ${flow} delivery rechecks ${revocation} after actual artifact read`, async () => {
          await withHarness(
            { accessMode: "pairing", actor: "member", isGroup },
            async (h) => {
              await h.handler(h.message);
              const sessionId = h.sessionStore.get(h.sessionKey)!.sessionId;
              const now = new Date().toISOString();
              const bytes = Buffer.from("Sensitive late delivery fixture");
              const folder = path.join(
                getProfileSoulDir(ORG_ID, PROFILE_ID),
                "artifacts"
              );
              await mkdir(folder, { recursive: true });
              await writeFile(path.join(folder, "report.txt"), bytes);
              await h.db.appendMessagesForSession(sessionId, [
                {
                  createdAt: now,
                  id: "late-file",
                  payload: {
                    content: JSON.stringify({
                      bytesWritten: bytes.length,
                      path: "artifacts/report.txt",
                    }),
                    name: "write_file",
                    role: "tool",
                    toolCallId: "late-write",
                  },
                  seq: 1,
                  sessionId,
                },
              ]);
              const shareUrl = "https://example.test/s/late-private-report";
              h.sessionStore.updateArtifactState(h.sessionKey, {
                artifactShareUrls: { "report.txt": shareUrl },
                deliverableArtifacts: [
                  {
                    filename: "report.txt",
                    mimeType: "text/plain",
                    path: "report.txt",
                    savedAt: now,
                    sharePath: "/s/late-private-report",
                    shareUrl,
                    sizeBytes: bytes.length,
                  },
                ],
              });
              h.setStream(async (_sessionId, _input, handlers) => {
                handlers.onArtifactCreated?.({
                  createdAt: now,
                  filename: "report.txt",
                  id: "late-report",
                  mimeType: "text/plain",
                  path: "artifacts/report.txt",
                  sessionId,
                  size: bytes.length,
                  type: "file",
                });
                return "Report ready.";
              });
              const read = h.client.readProfileArtifactContent.bind(h.client);
              let reads = 0;
              h.client.readProfileArtifactContent = async (...args) => {
                const result = await read(...args);
                reads += 1;
                if (revocation === "membership") {
                  await h.db.deleteOrgMember(ORG_ID, "matrix_user");
                } else if (revocation === "blocked") {
                  await saveWhatsAppConfig(
                    {
                      accessMode: "denylist",
                      blockedNumbers: ["6281111111111"],
                    },
                    ORG_ID
                  );
                } else if (revocation === "room") {
                  await saveChannelIntegrationPolicy(ORG_ID, "whatsapp", {
                    rooms: { [h.message.jid]: { enabled: false } },
                    version: 1,
                  });
                } else if (revocation === "session") {
                  const replacement = await h.client.createSession("whatsapp", {
                    externalPrincipal: {
                      channelAddressed: true,
                      channelChatId: h.message.jid,
                      channelIsGroup: isGroup,
                      channelUserId: SENDER,
                    },
                    profileId: PROFILE_ID,
                  });
                  h.sessionStore.set(h.sessionKey, {
                    ...h.sessionStore.get(h.sessionKey)!,
                    sessionId: replacement.id,
                  });
                } else {
                  await h.db.upsertOrgMember({
                    createdAt: now,
                    orgId: ORG_ID,
                    role: "viewer",
                    userId: "matrix_user",
                  });
                }
                return result;
              };
              h.sent.length = 0;
              const text =
                flow === "attach"
                  ? "/attach"
                  : flow === "share"
                    ? "send share link"
                    : "Run report";
              const delivery = h.handler({
                ...h.message,
                me: { id: OWNER },
                mentionedJids: isGroup ? [OWNER] : [],
                text,
              });
              if (revocation === "viewer") {
                await delivery;
              } else {
                await delivery.catch((error) =>
                  revocation === "session"
                    ? expect(error).toBeInstanceOf(Error)
                    : expect(error).toMatchObject({ status: 403 })
                );
                if (revocation === "session") {
                  expect(h.sessionStore.get(h.sessionKey)?.sessionId).not.toBe(
                    sessionId
                  );
                } else {
                  expect(
                    h.requests.some(
                      (item) =>
                        item.path === "/v1/channel-principals/authorize" &&
                        item.status === 403
                    )
                  ).toBe(true);
                }
              }
              expect(reads).toBe(1);
              const documents = h.sent.filter(
                (item) =>
                  typeof item === "object" &&
                  item !== null &&
                  "document" in item
              );
              expect(documents.length).toBe(revocation === "viewer" ? 1 : 0);
              expect(JSON.stringify(h.sent).includes(shareUrl)).toBe(
                revocation === "viewer" && flow === "share"
              );
              if (revocation !== "viewer") {
                expect(JSON.stringify(h.sent)).not.toContain("report.txt");
                expect(JSON.stringify(h.sent)).not.toContain("artifacts/");
              }
            }
          );
        });
      }
    }
  }
  for (const isGroup of [false, true]) {
    for (const revoke of [
      "approvals",
      "room",
      "sender",
      "room-role",
    ] as const) {
      test(`pending ${isGroup ? "group" : "DM"} approval rejects current ${revoke} policy revocation`, async () => {
        await withHarness(
          { accessMode: "pairing", actor: "member", isGroup },
          async (h) => {
            let decisions = 0;
            h.setStream(async (sessionId, _input, handlers, options) => {
              const approval = {
                consequenceSummary: "Changes a file",
                createdAt: new Date().toISOString(),
                id: "policy-approval",
                status: "pending" as const,
                title: "Change",
                tool: "write_file",
                toolCallId: "policy-call",
              };
              await h.agent.chatToolApprovals.request(
                {
                  approval,
                  beforeDecision: async () => {},
                  call: {
                    arguments: { path: "file.txt" },
                    id: "policy-call",
                    name: "write_file",
                  },
                  principal: {
                    isPlatformAdmin: false,
                    orgId: ORG_ID,
                    orgRole: "member",
                    userId: "matrix_user",
                  },
                  runId: "policy-run",
                  sessionId,
                  signal: options?.signal,
                },
                () => handlers.onApprovalRequested?.(approval)
              );
              decisions += 1;
              return "Resumed";
            });
            const turn = h.handler({
              ...h.message,
              me: { id: OWNER },
              mentionedJids: isGroup ? [OWNER] : [],
              text: isGroup ? "@6289999999999 change" : "Change",
            });
            for (
              let attempt = 0;
              attempt < 200 && !h.sent.length;
              attempt += 1
            ) {
              await Bun.sleep(10);
            }
            expect(
              (await h.db.getActionApproval("policy-approval"))?.status
            ).toBe("pending");
            const policy =
              revoke === "approvals"
                ? { approvals: false }
                : revoke === "sender"
                  ? { senders: { [SENDER]: { enabled: false } } }
                  : {
                      rooms: {
                        [h.message.jid]:
                          revoke === "room"
                            ? { enabled: false }
                            : { roles: ["admin"] },
                      },
                    };
            await saveChannelIntegrationPolicy(ORG_ID, "whatsapp", {
              version: 1,
              ...policy,
            });
            await expect(
              h.handler.onReaction({
                actorAliases: [],
                actorId: SENDER,
                destination: h.message.jid,
                emoji: "✅",
                eventId: "policy-reaction",
                target: {
                  fromMe: true,
                  id: "sent_1",
                  remoteJid: h.message.jid,
                },
              })
            ).rejects.toMatchObject({ status: 403 });
            expect(decisions).toBe(0);
            expect(
              (await h.db.getActionApproval("policy-approval"))?.status
            ).toBe("pending");
            expect(
              h.requests.some(
                (item) =>
                  item.path ===
                    (revoke === "approvals"
                      ? "/v1/channel-principals/approvals/decide"
                      : "/v1/channel-principals/authorize") &&
                  item.status === 403
              )
            ).toBe(true);
            await saveChannelIntegrationPolicy(ORG_ID, "whatsapp", {
              version: 1,
            });
            await h.handler({ ...h.message, text: "/stop" });
            await turn;
            expect(decisions).toBe(0);
          }
        );
      });
    }
  }
  for (const unknownOutcome of [false, true]) {
    test(`native media ${unknownOutcome ? "unknown" : "accepted"} is not duplicated by automatic turn artifact delivery`, async () => {
      await withHarness(
        { accessMode: "pairing", actor: "member", isGroup: false },
        async (h) => {
          const now = new Date().toISOString();
          await h.db.upsertTool({
            createdAt: now,
            description: "Native channel operations",
            handlerConfig: {},
            handlerType: "builtin",
            id: "wa-native-file",
            name: "channel_action",
            orgId: ORG_ID,
            updatedAt: now,
          });
          await h.db.assignToolToProfile(PROFILE_ID, "wa-native-file");
          const folder = path.join(
            getProfileSoulDir(ORG_ID, PROFILE_ID),
            "artifacts"
          );
          await mkdir(folder, { recursive: true });
          const bytes = Buffer.from("Exact native file bytes");
          await writeFile(path.join(folder, "report.txt"), bytes);
          if (unknownOutcome) {
            h.setUnknownDocumentOutcome();
          }
          let receipt: ChannelActionReceipt | undefined;
          h.setStream(async (sessionId, _input, handlers) => {
            await h.db.appendMessagesForSession(sessionId, [
              {
                createdAt: now,
                id: "file-written",
                payload: {
                  content: JSON.stringify({
                    bytesWritten: bytes.length,
                    path: "artifacts/report.txt",
                  }),
                  name: "write_file",
                  role: "tool",
                  toolCallId: "write-report",
                },
                seq: 1,
                sessionId,
              },
            ]);
            handlers.onArtifactCreated?.({
              createdAt: now,
              filename: "report.txt",
              id: "native-file",
              mimeType: "text/plain",
              path: "artifacts/report.txt",
              sessionId,
              size: bytes.length,
              type: "file",
            });
            receipt = await h.agent.channelNativeActions.request(
              {
                channel: "whatsapp",
                orgId: ORG_ID,
                profileId: PROFILE_ID,
                sessionId,
                userId: "matrix_user",
              },
              { kind: "send_media", mode: "document", path: "report.txt" },
              (request) => handlers.onChannelActionRequested?.(request)
            );
            return "File handled.";
          });
          await h.handler({ ...h.message, text: "Send this report" });
          const documents = h.sent.filter(
            (item): item is { document: Buffer } =>
              typeof item === "object" && item !== null && "document" in item
          );
          if (receipt?.status === "failed") {
            throw new Error(
              JSON.stringify({ receipt, requests: h.requests, sent: h.sent })
            );
          }
          expect(receipt?.status).toBe(unknownOutcome ? "unknown" : "accepted");
          expect(documents.length).toBe(1);
          expect(documents[0]?.document.equals(bytes)).toBe(true);
          expect(
            h.sessionStore
              .getDeliverableArtifacts(h.sessionKey)
              .map((item) => item.path)
          ).toEqual(["report.txt"]);
        }
      );
    });
  }
  for (const isGroup of [false, true]) {
    test(`questionnaire reactions in ${isGroup ? "group" : "DM"} revalidate HTTP membership before invoking a follow-up`, async () => {
      await withHarness(
        { accessMode: "pairing", actor: "member", isGroup },
        async (h) => {
          const messages: string[] = [];
          h.setStream(async (sessionId, input, handlers) => {
            messages.push(input.message);
            if (messages.length === 1) {
              const questionnaire = {
                id: "choice",
                questions: [
                  {
                    allowCustomAnswer: true,
                    choices: [
                      { id: "red", label: "Red" },
                      { id: "blue", label: "Blue" },
                    ],
                    id: "color",
                    prompt: "Color?",
                  },
                ],
                title: "Choose",
              };
              await h.db.updateSessionQuestionnaire(sessionId, questionnaire);
              handlers.onQuestionnaireUpdated?.(questionnaire);
              return "Ready";
            }
            expect(input.expectedQuestionnaire?.id).toBe("choice");
          });
          await h.handler({
            ...h.message,
            me: { id: OWNER },
            mentionedJids: isGroup ? [OWNER] : [],
            text: isGroup ? "@6289999999999 choose" : "Choose",
          });
          const reaction = {
            actorAliases: [],
            actorId: SENDER,
            destination: h.message.jid,
            emoji: "2️⃣",
            eventId: "choice-1",
            target: { fromMe: true, id: "sent_1", remoteJid: h.message.jid },
          };
          await h.db.upsertOrgMember({
            createdAt: new Date().toISOString(),
            orgId: ORG_ID,
            role: "viewer",
            userId: "matrix_user",
          });
          await expect(h.handler.onReaction(reaction)).rejects.toMatchObject({
            status: 403,
          });
          expect(messages.length).toBe(1);
          await h.db.upsertOrgMember({
            createdAt: new Date().toISOString(),
            orgId: ORG_ID,
            role: "member",
            userId: "matrix_user",
          });
          await h.handler.onReaction(reaction);
          expect(messages.length).toBe(2);
          expect(
            await h.db.getSessionQuestionnaire(
              h.sessionStore.get(h.sessionKey)!.sessionId
            )
          ).toBeNull();
          expect(messages[1]).toContain("Q: Color?\nA: Blue");
          expect(messages[1]?.includes("visible to everyone")).toBe(isGroup);
          await h.handler.onReaction({ ...reaction, eventId: "choice-replay" });
          expect(messages.length).toBe(2);
        }
      );
    });
  }

  test("a questionnaire from a replaced session cannot resume through an old message", async () => {
    await withHarness(
      { accessMode: "pairing", actor: "member", isGroup: false },
      async (h) => {
        let turns = 0;
        h.setStream(async (_sessionId, _input, handlers) => {
          turns += 1;
          handlers.onQuestionnaireUpdated?.({
            id: "old-choice",
            questions: [
              {
                allowCustomAnswer: false,
                choices: [{ id: "yes", label: "Yes" }],
                id: "q",
                prompt: "Continue?",
              },
            ],
            title: "Choose",
          });
          return "Choose";
        });
        await h.handler({ ...h.message, text: "Question" });
        await h.handler({ ...h.message, text: "/new" });
        await expect(
          h.handler.onReaction({
            actorAliases: [],
            actorId: SENDER,
            destination: SENDER,
            emoji: "1️⃣",
            eventId: "old",
            target: { fromMe: true, id: "sent_1", remoteJid: SENDER },
          })
        ).rejects.toThrow();
        expect(turns).toBe(1);
      }
    );
  });

  test("same-id questionnaire mutation between reaction admission and HTTP send rejects the original snapshot", async () => {
    await withHarness(
      { accessMode: "pairing", actor: "member", isGroup: false },
      async (h) => {
        const questionnaire = {
          id: "same-id",
          questions: [
            {
              allowCustomAnswer: false,
              choices: [{ id: "a", label: "Original choice" }],
              id: "q",
              prompt: "Pick",
            },
          ],
          title: "Original",
        };
        let turns = 0;
        h.setStream(async (sessionId, input, handlers) => {
          turns += 1;
          if (turns === 1) {
            await h.db.updateSessionQuestionnaire(sessionId, questionnaire);
            handlers.onQuestionnaireUpdated?.(questionnaire);
            return "Choose";
          }
          expect(input.expectedQuestionnaire).toEqual(questionnaire);
          await h.db.updateSessionQuestionnaire(sessionId, {
            ...questionnaire,
            title: "Changed while answering",
          });
        });
        await h.handler({ ...h.message, text: "Question" });
        await h.handler.onReaction({
          actorAliases: [],
          actorId: SENDER,
          destination: SENDER,
          emoji: "1️⃣",
          eventId: "stale-answer",
          target: { fromMe: true, id: "sent_1", remoteJid: SENDER },
        });
        expect(
          h.requests.some(
            (item) => item.path.endsWith("/messages") && item.status === 409
          )
        ).toBe(true);
        const sessionId = h.sessionStore.get(h.sessionKey)!.sessionId;
        expect((await h.client.getSessionMessages(sessionId)).messages).toEqual(
          []
        );
        expect((await h.db.getSessionQuestionnaire(sessionId))?.title).toBe(
          "Changed while answering"
        );
      }
    );
  });

  test("a questionnaire cleared in the same stream cannot be answered after its queued card sends", async () => {
    await withHarness(
      { accessMode: "pairing", actor: "member", isGroup: false },
      async (h) => {
        let turns = 0;
        h.setStream(async (_sessionId, _input, handlers) => {
          turns += 1;
          handlers.onQuestionnaireUpdated?.({
            id: "transient",
            questions: [
              {
                allowCustomAnswer: false,
                choices: [{ id: "a", label: "A" }],
                id: "q",
                prompt: "Pick",
              },
            ],
            title: "Q",
          });
          handlers.onQuestionnaireUpdated?.(null);
          return "Resolved";
        });
        await h.handler({ ...h.message, text: "Question" });
        await h.handler.onReaction({
          actorAliases: [],
          actorId: SENDER,
          destination: SENDER,
          emoji: "1️⃣",
          eventId: "late",
          target: { fromMe: true, id: "sent_1", remoteJid: SENDER },
        });
        expect(turns).toBe(1);
      }
    );
  });

  test("native action claim rejects a real membership revocation after the request was published", async () => {
    await withHarness(
      { accessMode: "pairing", actor: "member", isGroup: false },
      async (h) => {
        const now = new Date().toISOString();
        await h.db.upsertTool({
          createdAt: now,
          description: "Native channel operations",
          handlerConfig: {},
          handlerType: "builtin",
          id: "wa-native-revoke",
          name: "channel_action",
          orgId: ORG_ID,
          updatedAt: now,
        });
        await h.db.assignToolToProfile(PROFILE_ID, "wa-native-revoke");
        let receipt: ChannelActionReceipt | undefined;
        h.setStream(async (sessionId, _input, handlers) => {
          receipt = await h.agent.channelNativeActions.request(
            {
              channel: "whatsapp",
              orgId: ORG_ID,
              profileId: PROFILE_ID,
              sessionId,
              userId: "matrix_user",
            },
            { kind: "poll", options: ["A", "B"], question: "Q" },
            (request) => {
              void h.db
                .upsertOrgMember({
                  createdAt: now,
                  orgId: ORG_ID,
                  role: "viewer",
                  userId: "matrix_user",
                })
                .then(() => handlers.onChannelActionRequested?.(request));
            }
          );
          return "Denied";
        });
        await h.handler({ ...h.message, text: "Create poll" });
        expect(receipt?.status).toBe("failed");
        expect(h.sent.filter((body) => "poll" in (body as object)).length).toBe(
          0
        );
        expect(
          h.requests.some(
            (item) => item.path.endsWith("/claim") && item.status === 403
          )
        ).toBe(true);
      }
    );
  });
  test("native action traverses real context binding, one-time claim and receipt HTTP routes", async () => {
    await withHarness(
      { accessMode: "pairing", actor: "member", isGroup: false },
      async (h) => {
        const now = new Date().toISOString();
        await h.db.upsertTool({
          createdAt: now,
          description: "Native channel operations",
          handlerConfig: {},
          handlerType: "builtin",
          id: "wa-native",
          name: "channel_action",
          orgId: ORG_ID,
          updatedAt: now,
        });
        await h.db.assignToolToProfile(PROFILE_ID, "wa-native");
        const receipts: ChannelActionReceipt[] = [];
        h.setStream(async (sessionId, _input, handlers) => {
          const receipt = await h.agent.channelNativeActions.request(
            {
              channel: "whatsapp",
              orgId: ORG_ID,
              profileId: PROFILE_ID,
              sessionId,
              userId: "matrix_user",
            },
            {
              kind: "poll",
              options: ["Monday", "Tuesday"],
              question: "Which day?",
            },
            (request) => {
              handlers.onChannelActionRequested?.(request);
              handlers.onChannelActionRequested?.(request);
            }
          );
          receipts.push(receipt);
          return "Poll requested.";
        });
        await h.handler({ ...h.message, text: "Create a poll" });
        if (!receipts.length) {
          throw new Error(
            JSON.stringify({ requests: h.requests, sent: h.sent })
          );
        }
        expect(h.sent.filter((body) => "poll" in (body as object)).length).toBe(
          1
        );
        expect(receipts).toEqual([{ messageId: "sent_1", status: "accepted" }]);
        expect(
          h.requests
            .filter((item) => item.path.endsWith("/claim"))
            .map((item) => item.status)
        ).toEqual([200, 404]);
        expect(
          h.requests.some(
            (item) => item.path.endsWith("/complete") && item.status === 200
          )
        ).toBe(true);
      }
    );
  });

  for (const isGroup of [false, true]) {
    for (const decision of ["approved", "denied"] as const) {
      test(`native approval ${decision} in ${isGroup ? "group" : "DM"} uses current HTTP principal and durable approval`, async () => {
        await withHarness(
          { accessMode: "pairing", actor: "member", isGroup },
          async (h) => {
            let ready = false;
            const decisions: string[] = [];
            h.setStream(async (sessionId, _input, handlers, options) => {
              const approval = {
                consequenceSummary: "The requested change will run",
                createdAt: new Date().toISOString(),
                id: "native-approval",
                status: "pending" as const,
                title: "Apply change",
                tool: "write_file",
                toolCallId: "native-call",
              };
              const result = await h.agent.chatToolApprovals.request(
                {
                  approval,
                  beforeDecision: async () => {},
                  call: {
                    arguments: { path: "report.txt" },
                    id: "native-call",
                    name: "write_file",
                  },
                  principal: {
                    isPlatformAdmin: false,
                    orgId: ORG_ID,
                    orgRole: "member",
                    userId: "matrix_user",
                  },
                  runId: "native-approval-run",
                  sessionId,
                  signal: options?.signal,
                },
                () => {
                  handlers.onApprovalRequested?.(approval);
                  ready = true;
                }
              );
              decisions.push(result.decision);
              return "Decision received.";
            });
            const turn = h.handler({
              ...h.message,
              me: { id: OWNER },
              mentionedJids: isGroup ? [OWNER] : [],
              text: isGroup
                ? "@6289999999999 apply the change"
                : "Apply change",
            });
            for (
              let attempt = 0;
              attempt < 100 && !(ready && h.sent.length);
              attempt += 1
            ) {
              await Bun.sleep(5);
            }
            if (!ready) {
              throw new Error(
                JSON.stringify({ requests: h.requests, sent: h.sent })
              );
            }
            expect(h.sent.length).toBeGreaterThan(0);
            const reaction = {
              actorAliases: [],
              actorId: SENDER,
              destination: h.message.jid,
              emoji: decision === "approved" ? "✅" : "❌",
              eventId: "decision-1",
              target: { fromMe: true, id: "sent_1", remoteJid: h.message.jid },
            };
            // A stale role must not decide a live pending approval.
            await h.db.upsertOrgMember({
              createdAt: new Date().toISOString(),
              orgId: ORG_ID,
              role: "viewer",
              userId: "matrix_user",
            });
            await expect(h.handler.onReaction(reaction)).rejects.toMatchObject({
              status: 403,
            });
            expect(decisions.length).toBe(0);
            expect(
              (await h.db.getActionApproval("native-approval"))?.status
            ).toBe("pending");
            await h.db.upsertOrgMember({
              createdAt: new Date().toISOString(),
              orgId: ORG_ID,
              role: "member",
              userId: "matrix_user",
            });
            await h.handler.onReaction(reaction);
            await turn;
            expect(decisions).toEqual([decision]);
            await h.handler.onReaction({ ...reaction, eventId: "duplicate" });
            expect(decisions.length).toBe(1);
            expect(
              (await h.db.getActionApproval("native-approval"))?.status
            ).toBe(decision);
          }
        );
      });
    }
  }

  for (const requireMention of [true, false]) {
    test(`unaddressed group content honors explicit requireMention=${requireMention} before invoking`, async () => {
      await withHarness(
        { accessMode: "pairing", actor: "member", isGroup: true },
        async (h) => {
          await saveChannelIntegrationPolicy(ORG_ID, "whatsapp", {
            groups: { requireMention },
            version: 1,
          });
          let turns = 0;
          h.setStream(async () => {
            turns += 1;
            return "Received";
          });
          await h.handler({ ...h.message, text: "Unaddressed group message" });
          expect(turns).toBe(requireMention ? 0 : 1);
          expect((await h.db.listSessions()).length).toBe(
            requireMention ? 0 : 1
          );
        }
      );
    });
  }
  for (const channelUserId of [SENDER, "154352568283178@lid"]) {
    test(`direct binding rejects blocked ${channelUserId.endsWith("@lid") ? "LID" : "phone"} without consuming the pairing assertion`, async () => {
      await withHarness(
        { accessMode: "denylist", actor: "blocked", isGroup: false },
        async (harness) => {
          if (channelUserId.endsWith("@lid")) {
            await rememberWhatsAppLidPhone(channelUserId, SENDER, ORG_ID);
          }
          const pairingAssertion =
            await harness.agent.identityService.issuePairingAssertion({
              channel: "whatsapp",
              orgId: ORG_ID,
              userId: "matrix_user",
            });
          const input = {
            channel: "whatsapp" as const,
            channelUserId,
            expectedUserId: "matrix_user",
            pairingAssertion,
          };
          await expect(
            harness.client.bindChannelPrincipal(input)
          ).rejects.toMatchObject({ status: 403 });
          expect(await harness.db.listSessions()).toEqual([]);
          await saveWhatsAppConfig({ blockedNumbers: [] }, ORG_ID);
          await expect(
            harness.client.bindChannelPrincipal(input)
          ).resolves.toMatchObject({
            orgId: ORG_ID,
            userId: "matrix_user",
          });
        }
      );
    });
  }

  test("a legacy local token cannot invoke an external sender in a selected tenant", async () => {
    await withHarness(
      {
        accessMode: "pairing",
        actor: "member",
        credential: "local",
        isGroup: false,
      },
      async (harness) => {
        await harness.handler(harness.message);
        expect(harness.sessionStore.get(harness.sessionKey)).toBeUndefined();
        expect(await harness.db.listSessions()).toEqual([]);
        expect(harness.downloads()).toBe(0);
        expect(harness.requests.some((entry) => entry.status === 403)).toBe(
          true
        );
      }
    );
  });
  for (const blocked of [false, true]) {
    test(`${blocked ? "blocked" : "allowed"} denylist sender pairing respects policy before consuming the code`, async () => {
      await withHarness(
        {
          accessMode: "denylist",
          actor: blocked ? "blocked" : "member",
          isGroup: false,
        },
        async (harness) => {
          const assertion =
            await harness.agent.identityService.issuePairingAssertion({
              channel: "whatsapp",
              orgId: ORG_ID,
              userId: "matrix_user",
            });
          const pending = await regenerateWhatsAppPairingCode(
            ORG_ID,
            "matrix_user",
            assertion
          );
          await harness.handler({
            ...harness.message,
            text: pending.pairingCode ?? "",
          });
          const after = await loadWhatsAppConfigFile(ORG_ID);
          expect(after?.pairingCode).toBe(blocked ? pending.pairingCode : null);
          expect(after?.pairedJid).toBe(blocked ? OWNER : SENDER);
          expect(
            harness.requests.some(
              (entry) => entry.path === "/v1/channel-principals"
            )
          ).toBe(!blocked);
        }
      );
    });
  }
  for (const accessMode of [
    "pairing",
    "open",
    "allowlist",
    "denylist",
  ] as const) {
    for (const isGroup of [false, true]) {
      for (const actor of ACTORS) {
        test(`${accessMode} / ${isGroup ? "group" : "DM"} / ${actor}`, async () => {
          await withHarness({ accessMode, actor, isGroup }, async (harness) => {
            await harness.handler(harness.message);
            const channelAllowed =
              actor === "blocked"
                ? accessMode === "open"
                : actor !== "guest" || accessMode !== "pairing";
            const allowed =
              channelAllowed && actor !== "viewer" && actor !== "removed";
            const session = harness.sessionStore.get(harness.sessionKey);
            expect(Boolean(session)).toBe(allowed);
            expect(harness.downloads()).toBe(0);
            if (session) {
              const persisted = await harness.db.getSession(session.sessionId);
              expect(persisted?.orgId).toBe(ORG_ID);
              expect(persisted?.profileId).toBe(PROFILE_ID);
              if (actor === "guest") {
                expect(isChannelGuestUserId(persisted?.userId)).toBe(true);
              } else {
                expect(persisted?.userId).toBe("matrix_user");
              }
            }
          });
        });
      }
    }
  }

  for (const isGroup of [false, true]) {
    test(`viewer downgrade blocks cached ${isGroup ? "group" : "DM"} document writes before download`, async () => {
      await withHarness(
        { accessMode: "pairing", actor: "member", isGroup },
        async (harness) => {
          await harness.handler(harness.message);
          const originalSession = harness.sessionStore.get(harness.sessionKey);
          expect(originalSession).toBeDefined();
          await harness.db.upsertOrgMember({
            createdAt: new Date().toISOString(),
            orgId: ORG_ID,
            role: "viewer",
            userId: "matrix_user",
          });
          await harness.handler({
            ...harness.message,
            inbound: {
              key: { remoteJid: harness.message.jid },
              message: {
                documentMessage: {
                  fileName: "denied.xlsx",
                  mimetype:
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                },
              },
            },
            me: { id: OWNER },
            mentionedJids: isGroup ? [OWNER] : [],
            text: isGroup ? "@Atlas edit this" : "edit this",
          });
          expect(harness.downloads()).toBe(0);
          expect(
            harness.requests.some(
              (entry) =>
                entry.path === "/v1/channel-principals/authorize" &&
                entry.status === 403
            )
          ).toBe(true);
          expect(harness.sessionStore.get(harness.sessionKey)?.sessionId).toBe(
            originalSession?.sessionId
          );
          const artifactDir = path.join(
            getProfileSoulDir(ORG_ID, PROFILE_ID),
            "artifacts"
          );
          expect(await readdir(artifactDir).catch(() => [])).toEqual([]);
        }
      );
    });
  }

  for (const revokeDuringDownload of [false, true]) {
    test(`${revokeDuringDownload ? "denies revoked" : "allows current"} member persistence after media download`, async () => {
      await withHarness(
        { accessMode: "pairing", actor: "member", isGroup: false },
        async (harness) => {
          await harness.handler(harness.message);
          if (revokeDuringDownload) {
            harness.setOnDownload(async () => {
              await harness.db.deleteOrgMember(ORG_ID, "matrix_user");
            });
          }
          await harness.handler({
            ...harness.message,
            inbound: {
              key: { remoteJid: SENDER },
              message: {
                documentMessage: {
                  fileName: "authorized.xlsx",
                  mimetype:
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                },
              },
            },
            text: "read this workbook",
          });
          expect(harness.downloads()).toBe(1);
          const artifactDir = path.join(
            getProfileSoulDir(ORG_ID, PROFILE_ID),
            "artifacts"
          );
          const files = await readdir(artifactDir).catch(() => []);
          expect(files.length > 0).toBe(!revokeDuringDownload);
          const authorization = harness.requests.filter(
            (entry) => entry.path === "/v1/channel-principals/authorize"
          );
          expect(
            authorization.some(
              (entry) => entry.status === (revokeDuringDownload ? 403 : 200)
            )
          ).toBe(true);
        }
      );
    });
  }

  for (const isGroup of [false, true]) {
    for (const revoke of ["none", "denylist", "viewer"] as const) {
      test(`${isGroup ? "group" : "DM"} /stop honors ${revoke} authorization`, async () => {
        await withHarness(
          { accessMode: "pairing", actor: "member", isGroup },
          async (harness) => {
            await harness.handler(harness.message);
            const signal = registerActiveStream(harness.sessionKey);
            if (revoke === "denylist") {
              await saveWhatsAppConfig(
                {
                  accessMode: "denylist",
                  blockedNumbers: ["6281111111111"],
                },
                ORG_ID
              );
            } else if (revoke === "viewer") {
              await harness.db.upsertOrgMember({
                createdAt: new Date().toISOString(),
                orgId: ORG_ID,
                role: "viewer",
                userId: "matrix_user",
              });
            }
            await harness.handler({ ...harness.message, text: "/stop" });
            expect(signal.aborted).toBe(revoke === "none");
          }
        );
      });
    }
  }

  for (const revocation of ["membership", "identity"] as const) {
    test(`${revocation} revocation blocks a cached group attachment and cached share URL`, async () => {
      await withHarness(
        { accessMode: "pairing", actor: "member", isGroup: true },
        async (harness) => {
          await harness.handler(harness.message);
          const shareUrl = "https://example.test/s/private-snapshot";
          harness.sessionStore.updateArtifactState(harness.sessionKey, {
            artifactShareUrls: { "private.pdf": shareUrl },
            deliverableArtifacts: [
              {
                filename: "private.pdf",
                mimeType: "application/pdf",
                path: "private.pdf",
                savedAt: new Date().toISOString(),
                sharePath: "/s/private-snapshot",
                shareUrl,
                sizeBytes: 1,
              },
            ],
          });
          if (revocation === "membership") {
            await harness.db.deleteOrgMember(ORG_ID, "matrix_user");
          } else {
            await harness.db.deleteChannelOrgMapping(
              ORG_ID,
              "whatsapp",
              SENDER
            );
          }
          const requestCount = harness.requests.length;
          await harness.handler({ ...harness.message, text: "/attach" });
          const requests = harness.requests.slice(requestCount);
          expect(
            requests.some(
              (entry) =>
                entry.path === "/v1/channel-principals/authorize" &&
                entry.status === 403
            )
          ).toBe(true);
          expect(
            requests.some((entry) => entry.path.includes("/artifacts"))
          ).toBe(false);
          expect(JSON.stringify(harness.sent)).not.toContain(shareUrl);
        }
      );
    });
  }
});

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1cAAAAASUVORK5CYII=",
  "base64"
);
const DAILY_WORK_FILES = [
  {
    filename: "workbook.xlsx",
    mediaType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    tool: "spreadsheet",
  },
  { filename: "table.csv", mediaType: "text/csv", tool: "spreadsheet" },
  {
    filename: "report.pdf",
    mediaType: "application/pdf",
    tool: "extract_document_text",
  },
  {
    filename: "report.docx",
    mediaType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    tool: "extract_document_text",
  },
  { filename: "notes.txt", mediaType: "text/plain", tool: "read_file" },
  { filename: "photo.png", mediaType: "image/png", tool: "image" },
];

describe("WhatsApp authorized daily-work attachment pipeline", () => {
  for (const accessMode of ["open", "allowlist"] as const) {
    test.each(DAILY_WORK_FILES)(
      `${accessMode} guest saves original $filename with a tool hint`,
      async (file) => {
        await withHarness(
          { accessMode, actor: "guest", isGroup: false },
          async (h) => {
            const bytes = file.mediaType.startsWith("image/")
              ? TINY_PNG
              : Buffer.from("source content must stay in the workspace");
            h.setMediaBytes(bytes);
            const turns: SendMessageInput[] = [];
            h.setStream(async (_sessionId, input) => {
              turns.push(input);
              return "Completed";
            });
            await h.handler({
              ...h.message,
              inbound: {
                key: { remoteJid: SENDER },
                message: {
                  documentMessage: {
                    caption: "Finish this report",
                    fileName: file.filename,
                    mimetype: file.mediaType,
                  },
                },
              },
              text: "Finish this report",
            });
            expect(h.downloads()).toBe(1);
            expect(turns).toHaveLength(1);
            const turn = turns[0]!;
            expect(turn.message).toContain(`artifacts/${file.filename}`);
            expect(turn.message).toContain(file.tool);
            expect(turn.message).not.toContain("[File:");
            expect(turn.message).not.toContain(
              "source content must stay in the workspace"
            );
            expect(turn.documents).toBeUndefined();
            expect(
              await readFile(
                path.join(
                  getProfileSoulDir(ORG_ID, PROFILE_ID),
                  "artifacts",
                  file.filename
                )
              )
            ).toEqual(bytes);
            if (file.mediaType.startsWith("image/")) {
              expect(turn.images).toEqual([
                { data: bytes.toString("base64"), mediaType: file.mediaType },
              ]);
            }
          }
        );
      }
    );
  }

  test.each(["blocked", "viewer", "removed"] as const)(
    "%s sender cannot ingest media",
    async (actor) => {
      await withHarness(
        { accessMode: "denylist", actor, isGroup: false },
        async (h) => {
          let turns = 0;
          h.setStream(async () => {
            turns += 1;
            return "must not run";
          });
          await h.handler({
            ...h.message,
            inbound: {
              key: { remoteJid: SENDER },
              message: {
                documentMessage: {
                  fileName: "report.pdf",
                  mimetype: "application/pdf",
                },
              },
            },
            text: "Read this",
          });
          expect(h.downloads()).toBe(0);
          expect(turns).toBe(0);
          expect(
            await readdir(
              path.join(getProfileSoulDir(ORG_ID, PROFILE_ID), "artifacts")
            ).catch(() => [])
          ).toEqual([]);
        }
      );
    }
  );

  test.each(["oversized", "download", "empty", "save", "unsupported"] as const)(
    "%s attachment failure sends a rejection without invoking the model",
    async (failure) => {
      await withHarness(
        { accessMode: "open", actor: "guest", isGroup: false },
        async (h) => {
          let turns = 0;
          h.setStream(async () => {
            turns += 1;
            return "must not run";
          });
          h.setMediaBytes(
            failure === "empty" ? Buffer.alloc(0) : Buffer.from("original")
          );
          if (failure === "download") {
            h.setOnDownload(async () => {
              throw new Error("download failed");
            });
          }
          if (failure === "save") {
            await mkdir(getProfileSoulDir(ORG_ID, PROFILE_ID), {
              recursive: true,
            });
            await writeFile(
              path.join(getProfileSoulDir(ORG_ID, PROFILE_ID), "artifacts"),
              "not a directory"
            );
          }
          await h.handler({
            ...h.message,
            inbound: {
              key: { remoteJid: SENDER },
              message: {
                documentMessage: {
                  fileLength:
                    failure === "oversized" ? 26 * 1024 * 1024 : undefined,
                  fileName:
                    failure === "unsupported" ? "archive.zip" : "report.pdf",
                  mimetype:
                    failure === "unsupported"
                      ? "application/zip"
                      : "application/pdf",
                },
              },
            },
            text: "Read this",
          });
          expect(turns).toBe(0);
          expect(h.downloads()).toBe(
            failure === "oversized" || failure === "unsupported" ? 0 : 1
          );
          expect(h.sent.length).toBeGreaterThan(0);
          expect(JSON.stringify(h.sent)).not.toContain("must not run");
        }
      );
    }
  );

  test.each([true, false])(
    "unmentioned group files respect requireMention=%s with a visible outcome",
    async (requireMention) => {
      await withHarness(
        { accessMode: "open", actor: "guest", isGroup: true },
        async (h) => {
          await saveChannelIntegrationPolicy(ORG_ID, "whatsapp", {
            groups: { requireMention },
            version: 1,
          });
          h.setMediaBytes(Buffer.from("original workbook"));
          const turns: SendMessageInput[] = [];
          h.setStream(async (_sessionId, input) => {
            turns.push(input);
            return "Completed";
          });
          await h.handler({
            ...h.message,
            inbound: {
              key: { participant: SENDER, remoteJid: GROUP },
              message: {
                documentMessage: {
                  fileName: "workbook.xlsx",
                  mimetype: DAILY_WORK_FILES[0]!.mediaType,
                },
              },
            },
            text: "Finish this workbook",
          });
          expect(turns.length).toBe(requireMention ? 0 : 1);
          expect(h.downloads()).toBe(requireMention ? 0 : 1);
          if (requireMention) {
            expect(JSON.stringify(h.sent)).toContain("ignored");
            expect(JSON.stringify(h.sent)).toContain("mention");
          } else {
            expect(turns[0]?.message).toContain("WhatsApp group");
            expect(turns[0]?.message).toContain("artifacts/workbook.xlsx");
          }
        }
      );
    }
  );
});
