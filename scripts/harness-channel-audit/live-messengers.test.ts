import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithUserConfigDir } from "@atlas/core/user-config";
import {
  claimSingleSend,
  digest,
  executeOpenedMessengerOperation,
  type LiveManifest,
  LiveProofBlocked,
  parseManifest,
  parseRunState,
  type Receipt,
  type RunState,
  requireSendAuthorization,
  syntheticFile,
  verifyReceipt,
} from "./live-messengers";
import { makeLiveTransport } from "./live-messengers-transport";
import { DedicatedWhatsAppProofTransport } from "./live-messengers-whatsapp";
import {
  inspectDedicatedWhatsAppCredentials,
  openDedicatedWhatsAppTransport,
} from "./live-messengers-whatsapp-runtime";

function manifest(channel: LiveManifest["channel"] = "telegram"): LiveManifest {
  const destination = {
    discord: "123456789012345678",
    telegram: "123456789",
    whatsapp: "12025550123@s.whatsapp.net",
  }[channel];
  return {
    authorizationExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    authorizationReference: "Explicit synthetic test fixture",
    channel,
    destination,
    orgId: "org_test",
    profileId: "profile_test",
    receiverUserId: destination,
    schemaVersion: 1,
    serverUrl: "http://127.0.0.1:4310",
  };
}

function unconfirmedReport(): Record<string, unknown> {
  return {
    independentReceiptByteMatch: false,
    platformDownloadByteMatch: false,
    uploadAccepted: false,
  };
}

test("output directory allocation failure closes the opened transport and releases its lock without sending", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "atlas-opened-transport-test-")
  );
  const lock = join(directory, "fixture-socket.lock");
  await writeFile(lock, "test connection owns this lock");
  let connected = true;
  let closes = 0;
  let sends = 0;
  let authorized = 0;
  try {
    const m = manifest("whatsapp");
    const result = await executeOpenedMessengerOperation({
      io: {
        allocateDirectory: () =>
          Promise.reject(new Error("fixture storage allocation failure")),
        authorize: () => {
          authorized += 1;
          return Promise.resolve();
        },
      },
      manifest: m,
      manifestText: JSON.stringify(m),
      mode: "--send",
      report: unconfirmedReport(),
      transport: {
        close: async () => {
          closes += 1;
          connected = false;
          await rm(lock);
        },
        downloadSent: () => Promise.resolve(syntheticFile(state().nonce)),
        probe: () => Promise.resolve(),
        receive: () => Promise.resolve(null),
        send: () => {
          sends += 1;
          return Promise.resolve(state().sent);
        },
      },
    });
    expect(result.exitCode).toBe(2);
    expect(result.outputDir).toBeUndefined();
    expect(result.report).toMatchObject({
      status: "BLOCKED",
      uploadAccepted: false,
    });
    expect({ authorized, closes, connected, sends }).toEqual({
      authorized: 0,
      closes: 1,
      connected: false,
      sends: 0,
    });
    expect(await Bun.file(lock).exists()).toBe(false);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

for (const fault of [
  "cleanup",
  "cleanup-after-download-failure",
  "evidence-write",
] as const) {
  test(`confirmed upload evidence survives ${fault} without another send`, async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "atlas-live-evidence-test-")
    );
    let sentBytes = new Uint8Array();
    let sends = 0;
    let closes = 0;
    let downloads = 0;
    let claims = 0;
    const m = manifest("whatsapp");
    try {
      const result = await executeOpenedMessengerOperation({
        io: {
          allocateDirectory: () => Promise.resolve(directory),
          authorize: () => Promise.resolve(),
          claimSend: () => {
            claims += 1;
            return Promise.resolve();
          },
          writeJson: async (dir, filename, value) => {
            if (fault === "evidence-write" && filename === "evidence.json") {
              throw new Error("fixture failed evidence write");
            }
            await writeFile(join(dir, filename), JSON.stringify(value));
          },
        },
        manifest: m,
        manifestText: JSON.stringify(m),
        mode: "--send",
        report: unconfirmedReport(),
        transport: {
          close: () => {
            closes += 1;
            return fault === "evidence-write"
              ? Promise.resolve()
              : Promise.reject(
                  new Error("fixture cleanup failure with secret details")
                );
          },
          downloadSent: () => {
            downloads += 1;
            if (fault === "cleanup-after-download-failure") {
              return Promise.reject(
                new LiveProofBlocked("FIXTURE_DOWNLOAD_FAILED")
              );
            }
            return Promise.resolve(sentBytes);
          },
          probe: () => Promise.resolve(),
          receive: () => Promise.resolve(null),
          send: (bytes) => {
            sends += 1;
            sentBytes = new Uint8Array(bytes);
            return Promise.resolve(state().sent);
          },
        },
      });
      expect(result.exitCode).toBe(2);
      expect(result.report.uploadAccepted).toBe(true);
      expect(result.report.uploadAcceptance).toBe("PLATFORM_CONFIRMED");
      expect(result.report.sendAttempted).toBe(true);
      expect(result.report.platformDownloadByteMatch).toBe(
        fault !== "cleanup-after-download-failure"
      );
      expect(result.report.independentReceiptByteMatch).toBe(false);
      expect({ claims, closes, downloads, sends }).toEqual({
        claims: 1,
        closes: 1,
        downloads: 1,
        sends: 1,
      });
      expect(JSON.stringify(result.report)).not.toContain("secret details");
      if (fault === "evidence-write") {
        expect(result.report.evidenceWriteError).toBe(
          "EVIDENCE_WRITE_FAILED_DETAILS_REDACTED"
        );
      } else {
        expect(result.report.cleanupError).toBe(
          "TRANSPORT_CLEANUP_FAILED_DETAILS_REDACTED"
        );
        expect(
          await Bun.file(join(directory, "evidence.json")).json()
        ).toMatchObject({
          cleanupError: "TRANSPORT_CLEANUP_FAILED_DETAILS_REDACTED",
          uploadAccepted: true,
        });
      }
      if (fault === "cleanup-after-download-failure") {
        expect(result.report.reason).toBe("FIXTURE_DOWNLOAD_FAILED");
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
}

test("confirmed independent receipt remains confirmed when teardown fails", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "atlas-live-receipt-cleanup-")
  );
  const m = manifest("discord");
  const s = state();
  let sends = 0;
  let closes = 0;
  try {
    const result = await executeOpenedMessengerOperation({
      inputState: s,
      io: { allocateDirectory: () => Promise.resolve(directory) },
      manifest: m,
      manifestText: JSON.stringify(m),
      mode: "--receive",
      report: unconfirmedReport(),
      transport: {
        close: () => {
          closes += 1;
          return Promise.reject(new Error("fixture close failure"));
        },
        downloadSent: () => Promise.resolve(syntheticFile(s.nonce)),
        probe: () => Promise.resolve(),
        receive: () => Promise.resolve(receipt(m, s)),
        send: () => {
          sends += 1;
          return Promise.resolve(s.sent);
        },
      },
    });
    expect(result.exitCode).toBe(2);
    expect(result.report).toMatchObject({
      cleanupError: "TRANSPORT_CLEANUP_FAILED_DETAILS_REDACTED",
      independentReceiptByteMatch: true,
      status: "INDEPENDENT_FILE_ROUNDTRIP_PASS",
    });
    expect({ closes, sends }).toEqual({ closes: 1, sends: 0 });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("probe failure retains its cause while cleanup also fails", async () => {
  let allocated = 0;
  let closes = 0;
  const m = manifest();
  const result = await executeOpenedMessengerOperation({
    io: {
      allocateDirectory: () => {
        allocated += 1;
        return Promise.resolve("unused");
      },
    },
    manifest: m,
    manifestText: JSON.stringify(m),
    mode: "--probe",
    report: unconfirmedReport(),
    transport: {
      close: () => {
        closes += 1;
        return Promise.reject(new Error("fixture cleanup failed"));
      },
      downloadSent: () => Promise.resolve(syntheticFile(state().nonce)),
      probe: () => Promise.reject(new LiveProofBlocked("FIXTURE_PROBE_DENIED")),
      receive: () => Promise.resolve(null),
      send: () => Promise.resolve(state().sent),
    },
  });
  expect(result.exitCode).toBe(2);
  expect(result.report).toMatchObject({
    cleanupError: "TRANSPORT_CLEANUP_FAILED_DETAILS_REDACTED",
    reason: "FIXTURE_PROBE_DENIED",
    uploadAccepted: false,
  });
  expect({ allocated, closes }).toEqual({ allocated: 0, closes: 1 });
});
function state(): RunState {
  const nonce = "12345678-1234-1234-1234-123456789abc";
  return {
    filename: `atlas-live-${nonce}.txt`,
    manifestSha256: digest("manifest"),
    nonce,
    sent: {
      fileId: "fixture-file",
      messageId: "123456789012345679",
      sentAt: Date.now() - 1000,
    },
    sha256: digest(syntheticFile(nonce)),
  };
}
function receipt(m: LiveManifest, s: RunState): Receipt {
  return {
    bytes: syntheticFile(s.nonce),
    destination: m.destination,
    filename: s.filename,
    messageId: "123456789012345680",
    receivedAt: Date.now(),
    receiverUserId: m.receiverUserId,
    replyToMessageId: s.sent.messageId,
    topicId: m.topicId,
  };
}

for (const channel of ["telegram", "discord", "whatsapp"] as const) {
  test(`${channel}: explicit manifest is required, no destination inference`, () => {
    const m = manifest(channel);
    expect(parseManifest(m)).toEqual(m);
    for (const key of [
      "orgId",
      "profileId",
      "destination",
      "receiverUserId",
      "authorizationReference",
    ] as const) {
      expect(() => parseManifest({ ...m, [key]: "" })).toThrow();
    }
  });
}

for (const [label, patch] of Object.entries({
  expired: { authorizationExpiresAt: new Date(0).toISOString() },
  foreignServer: { serverUrl: "https://example.com" },
  injectedServer: { serverUrl: "http://user:password@localhost:4310" },
  multipleDestinations: { destination: "123456789,987654321" },
  overlong: {
    authorizationExpiresAt: new Date(
      Date.now() + 48 * 60 * 60 * 1000
    ).toISOString(),
  },
  recipientMismatch: { receiverUserId: "987654321" },
  serverPath: { serverUrl: "http://localhost:4310/other" },
  topicInDm: { topicId: 20 },
  traversalOrg: { orgId: "../org_other" },
  traversalProfile: { profileId: "../profile_other" },
})) {
  test(`manifest rejects ${label}`, () => {
    expect(() => parseManifest({ ...manifest(), ...patch })).toThrow();
  });
}

test("sending requires authorization bound to exact manifest bytes", () => {
  const text = JSON.stringify(manifest());
  expect(() => requireSendAuthorization(text, undefined)).toThrow();
  expect(() => requireSendAuthorization(text, "1")).toThrow();
  expect(() => requireSendAuthorization(`${text}\n`, digest(text))).toThrow();
  expect(() => requireSendAuthorization(text, digest(text))).not.toThrow();
});

test("one manifest can claim only one potentially irreversible send", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "atlas-live-send-claim-test-")
  );
  try {
    await claimSingleSend(digest("fixture"), directory);
    await expect(
      claimSingleSend(digest("fixture"), directory)
    ).rejects.toThrow();
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("independent author/reply/file/topic and bytes all match", () => {
  const m = manifest("discord");
  const s = state();
  expect(() => verifyReceipt(m, s, receipt(m, s))).not.toThrow();
});

for (const [label, patch] of Object.entries({
  foreignAuthor: { receiverUserId: "234567890123456789" },
  foreignDestination: { destination: "234567890123456789" },
  future: { receivedAt: Date.now() + 120_000 },
  otherTopic: { topicId: 25 },
  sameMessage: { messageId: "123456789012345679" },
  stale: { receivedAt: 0 },
  wrongBytes: { bytes: new TextEncoder().encode("other tenant's bytes") },
  wrongFilename: { filename: "different.txt" },
  wrongReply: { replyToMessageId: "234567890123456789" },
})) {
  test(`receipt cannot pass on ${label}`, () => {
    const m = manifest("discord");
    const s = state();
    expect(() => verifyReceipt(m, s, { ...receipt(m, s), ...patch })).toThrow();
  });
}

test("private state cannot substitute manifest, bytes, message path or a stale run", () => {
  const m = manifest("discord");
  const s = state();
  expect(parseRunState(s, m, s.manifestSha256)).toEqual(s);
  expect(() => parseRunState(s, m, digest("other manifest"))).toThrow();
  expect(() =>
    parseRunState({ ...s, sha256: digest("other bytes") }, m, s.manifestSha256)
  ).toThrow();
  expect(() =>
    parseRunState(
      { ...s, sent: { ...s.sent, messageId: "../other" } },
      m,
      s.manifestSha256
    )
  ).toThrow();
  expect(() =>
    parseRunState({ ...s, sent: { ...s.sent, sentAt: 0 } }, m, s.manifestSha256)
  ).toThrow();
});

async function controlledFetch<T>(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
  run: () => Promise<T>
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init)) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("Telegram production helper emits the synthetic bytes; downloaded platform bytes are separate evidence", async () => {
  const m = manifest();
  const s = state();
  const bytes = syntheticFile(s.nonce);
  const paths: string[] = [];
  await controlledFetch(
    async (url, init) => {
      paths.push(new URL(url).pathname);
      if (url.endsWith("/sendDocument")) {
        expect(init?.body).toBeInstanceOf(FormData);
        const form = init?.body as FormData;
        expect(form.get("chat_id")).toBe(m.destination);
        const file = form.get("document") as File;
        expect(digest(new Uint8Array(await file.arrayBuffer()))).toBe(s.sha256);
        expect(file.name).toBe(s.filename);
        return Response.json({
          ok: true,
          result: {
            chat: { id: Number(m.destination) },
            date: Math.floor(Date.now() / 1000),
            document: { file_id: "file1", file_name: s.filename },
            message_id: 1,
          },
        });
      }
      if (url.endsWith("/getFile")) {
        return Response.json({
          ok: true,
          result: { file_path: "documents/file1.txt" },
        });
      }
      return new Response(Buffer.from(bytes));
    },
    async () => {
      const transport = makeLiveTransport(m, "fixture-token", false);
      const sent = await transport.send(bytes, s.filename);
      expect(digest(await transport.downloadSent(sent))).toBe(s.sha256);
    }
  );
  expect(paths).toEqual([
    "/botfixture-token/sendDocument",
    "/botfixture-token/getFile",
    "/file/botfixture-token/documents/file1.txt",
  ]);
});

test("Discord production helper emits exact attachment bytes and fetches only the authorized message", async () => {
  const m = manifest("discord");
  const s = state();
  const bytes = syntheticFile(s.nonce);
  let uploads = 0;
  await controlledFetch(
    async (url, init) => {
      if (init?.method === "POST") {
        uploads += 1;
        expect(url).toBe(
          `https://discord.com/api/v10/channels/${m.destination}/messages`
        );
        const file = (init.body as FormData).get("files[0]") as File;
        expect(digest(new Uint8Array(await file.arrayBuffer()))).toBe(s.sha256);
        return Response.json({
          channel_id: m.destination,
          id: s.sent.messageId,
          timestamp: new Date().toISOString(),
        });
      }
      if (url.startsWith("https://cdn.discordapp.com/")) {
        return new Response(Buffer.from(bytes));
      }
      expect(url).toBe(
        `https://discord.com/api/v10/channels/${m.destination}/messages/${s.sent.messageId}`
      );
      return Response.json({
        attachments: [
          {
            filename: s.filename,
            url: "https://cdn.discordapp.com/attachments/fixture.txt",
          },
        ],
        channel_id: m.destination,
        id: s.sent.messageId,
      });
    },
    async () => {
      const transport = makeLiveTransport(m, "fixture-token", false);
      expect(
        digest(
          await transport.downloadSent(await transport.send(bytes, s.filename))
        )
      ).toBe(s.sha256);
    }
  );
  expect(uploads).toBe(1);
});

test("Telegram never polls an operational bot or an active webhook", async () => {
  let requests = 0;
  await controlledFetch(
    () => {
      requests += 1;
      return Response.json({
        ok: true,
        result: { url: "https://example.com/webhook" },
      });
    },
    async () => {
      const m = { ...manifest(), dedicatedTelegramPolling: true };
      await expect(
        makeLiveTransport(m, "fixture-token", true).receive(state())
      ).rejects.toThrow();
      expect(requests).toBe(0);
      await expect(
        makeLiveTransport(manifest(), "fixture-token", false).receive(state())
      ).rejects.toThrow();
      expect(requests).toBe(0);
      await expect(
        makeLiveTransport(m, "fixture-token", false).receive(state())
      ).rejects.toThrow();
      expect(requests).toBe(1);
    }
  );
});

test("Discord unrelated or bot-authored replies never trigger attachment download", async () => {
  const m = manifest("discord");
  const s = state();
  let requests = 0;
  await controlledFetch(
    () => {
      requests += 1;
      return Response.json([
        {
          attachments: [{ filename: s.filename }],
          author: { id: "234567890123456789" },
          channel_id: m.destination,
          id: "123456789012345681",
          message_reference: { message_id: s.sent.messageId },
        },
        {
          attachments: [{ filename: s.filename }],
          author: { bot: true, id: m.receiverUserId },
          channel_id: m.destination,
          id: "123456789012345682",
          message_reference: { message_id: s.sent.messageId },
        },
      ]);
    },
    async () => {
      expect(
        await makeLiveTransport(m, "fixture-token", false).receive(s)
      ).toBeNull();
    }
  );
  expect(requests).toBe(1);
});

test("WhatsApp cannot silently open an operational socket", () => {
  expect(() =>
    makeLiveTransport(manifest("whatsapp"), "ignored", false)
  ).toThrow();
});

test("CLI dry run uses only explicit scoped config; send without authorization cannot reach a transport", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-live-cli-test-"));
  try {
    const m = manifest();
    const manifestPath = join(directory, "manifest.json");
    const channelPath = join(
      directory,
      "orgs",
      m.orgId,
      "channels",
      "telegram"
    );
    await mkdir(channelPath, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(m));
    await writeFile(
      join(channelPath, "config.ini"),
      `bot_token=fixture-secret-never-print\nprofile_id=${m.profileId}\naccess_mode=pairing\n`
    );
    const invoke = async (mode: string) => {
      const process = Bun.spawn(
        [
          Bun.which("bun") ?? "bun",
          "scripts/harness-channel-audit/live-messengers.ts",
          manifestPath,
          mode,
        ],
        {
          cwd: join(import.meta.dir, "../.."),
          env: {
            ...Bun.env,
            ATLAS_CONFIG_DIR: directory,
            ATLAS_LIVE_AUTHORIZED_MANIFEST_SHA256: "",
            ATLAS_WORKSPACE_AUTH_TOKEN: "",
          },
          stderr: "pipe",
          stdout: "pipe",
        }
      );
      const text = await new Response(process.stdout).text();
      expect(text).not.toContain("fixture-secret-never-print");
      return { code: await process.exited, report: JSON.parse(text) };
    };
    expect(await invoke("--dry-run")).toMatchObject({
      code: 0,
      report: {
        independentReceiptByteMatch: false,
        networkRequests: 0,
        status: "DRY_RUN",
        uploadAccepted: false,
      },
    });
    expect(await invoke("--send")).toMatchObject({
      code: 2,
      report: {
        reason: "EXACT_MANIFEST_AUTHORIZATION_REQUIRED",
        uploadAccepted: false,
      },
    });
    await writeFile(manifestPath, JSON.stringify({ ...m, orgId: "org_other" }));
    expect(await invoke("--dry-run")).toMatchObject({
      code: 2,
      report: { reason: "SCOPED_CHANNEL_NOT_CONFIGURED" },
    });
    await writeFile(
      manifestPath,
      JSON.stringify({ ...m, profileId: "profile_other" })
    );
    expect(await invoke("--dry-run")).toMatchObject({
      code: 2,
      report: { reason: "CONFIG_PROFILE_MISMATCH" },
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("dedicated WhatsApp adapter uses production sender and accepts only the exact independent direct reply", async () => {
  const m = manifest("whatsapp");
  const s = state();
  const bytes = Buffer.from(syntheticFile(s.nonce));
  let sends = 0;
  let downloads = 0;
  let authorizations = 0;
  const socket = {
    sendMessage: (
      jid: string,
      content: { document: Buffer; fileName: string }
    ) => {
      sends += 1;
      expect(jid).toBe(m.destination);
      expect(digest(content.document)).toBe(s.sha256);
      return Promise.resolve({
        key: { fromMe: true, id: "SENT1", remoteJid: m.destination },
        message: { documentMessage: { fileName: content.fileName } },
        messageTimestamp: Math.floor(Date.now() / 1000),
      });
    },
    user: { id: "12025550999@s.whatsapp.net" },
  } as unknown as ConstructorParameters<
    typeof DedicatedWhatsAppProofTransport
  >[1]["socket"];
  const transport = new DedicatedWhatsAppProofTransport(m, {
    authorizeCurrent: () => {
      authorizations += 1;
      return Promise.resolve();
    },
    authorizedManifestSha256: digest(JSON.stringify(m)),
    dedicatedRuntime: true,
    download: () => {
      downloads += 1;
      return Promise.resolve(bytes);
    },
    operationalWorkerAlive: false,
    socket,
  });
  const sent = await transport.send(bytes, s.filename);
  const run = { ...s, sent };
  expect(digest(await transport.downloadSent(sent))).toBe(s.sha256);
  const message = {
    key: { fromMe: false, id: "REPLY1", remoteJid: m.destination },
    message: {
      documentMessage: {
        contextInfo: { stanzaId: sent.messageId },
        fileName: s.filename,
      },
    },
    messageTimestamp: Math.floor(Date.now() / 1000),
  };
  transport.offerInbound({
    ...message,
    key: { ...message.key, remoteJid: "12025550456@s.whatsapp.net" },
  });
  transport.offerInbound({ ...message, key: { ...message.key, fromMe: true } });
  expect(await transport.receive(run)).toBeNull();
  expect(downloads).toBe(1);
  transport.offerInbound(message);
  const received = await transport.receive(run);
  expect(received).not.toBeNull();
  verifyReceipt(m, run, received as Receipt);
  expect(downloads).toBe(2);
  expect(authorizations).toBe(3);
  await expect(transport.send(bytes, s.filename)).rejects.toThrow();
  expect(sends).toBe(1);
});

test("revoked WhatsApp principal causes zero send and zero download", async () => {
  let sends = 0;
  const socket = {
    sendMessage: () => {
      sends += 1;
      return Promise.resolve();
    },
    user: { id: "fixture" },
  } as unknown as ConstructorParameters<
    typeof DedicatedWhatsAppProofTransport
  >[1]["socket"];
  const m = manifest("whatsapp");
  const transport = new DedicatedWhatsAppProofTransport(m, {
    authorizeCurrent: () => Promise.reject(new Error("fixture-revoked")),
    authorizedManifestSha256: digest(JSON.stringify(m)),
    dedicatedRuntime: true,
    operationalWorkerAlive: false,
    socket,
  });
  await expect(
    transport.send(syntheticFile(state().nonce), state().filename)
  ).rejects.toThrow();
  expect(sends).toBe(0);
});

for (const branch of [
  "valid",
  "operational-directory",
  "unregistered",
  "wrong-identity",
  "wrong-config-phone",
  "active-worker",
  "duplicate-operational-identity",
  "symlinked-key",
] as const) {
  test(`dedicated WhatsApp credential preflight: ${branch}, zero external requests`, async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "atlas-dedicated-wa-preflight-")
    );
    let requests = 0;
    try {
      const root = join(directory, "config");
      const auth = join(directory, "dedicated-auth");
      const m = {
        ...manifest("whatsapp"),
        dedicatedWhatsAppAuthDir: auth,
        dedicatedWhatsAppSenderJid: "12025550789@s.whatsapp.net",
      };
      const channel = join(root, "orgs", m.orgId, "channels", "whatsapp");
      await mkdir(channel, { recursive: true });
      await mkdir(auth);
      await writeFile(
        join(channel, "config.ini"),
        `phone_number=${branch === "wrong-config-phone" ? "12025550678" : "12025550789"}\nprofile_id=${m.profileId}\naccess_mode=allowlist\n`
      );
      const credentials = {
        me: {
          id:
            branch === "wrong-identity"
              ? "12025550890:1@s.whatsapp.net"
              : "12025550789:1@s.whatsapp.net",
        },
        registered: branch !== "unregistered",
      };
      await writeFile(join(auth, "creds.json"), JSON.stringify(credentials));
      if (branch === "operational-directory") {
        m.dedicatedWhatsAppAuthDir = channel;
      }
      if (branch === "active-worker") {
        await writeFile(
          join(channel, "worker-heartbeat.json"),
          JSON.stringify({
            pid: process.pid,
            updatedAt: new Date().toISOString(),
          })
        );
      }
      if (branch === "duplicate-operational-identity") {
        await mkdir(join(root, "whatsapp", "auth"), { recursive: true });
        await writeFile(
          join(root, "whatsapp", "auth", "creds.json"),
          JSON.stringify(credentials)
        );
      }
      if (branch === "symlinked-key") {
        await symlink(
          join(channel, "config.ini"),
          join(auth, "session-key.json")
        );
      }
      await controlledFetch(
        () => {
          requests += 1;
          throw new Error("No external requests allowed");
        },
        async () => {
          await runWithUserConfigDir(root, async () => {
            if (branch === "valid") {
              expect(await inspectDedicatedWhatsAppCredentials(m)).toBe(
                await realpath(auth)
              );
            } else {
              await expect(
                inspectDedicatedWhatsAppCredentials(m)
              ).rejects.toThrow();
            }
            await expect(
              openDedicatedWhatsAppTransport(m, "{}")
            ).rejects.toThrow();
          });
        }
      );
      expect(requests).toBe(0);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
}
