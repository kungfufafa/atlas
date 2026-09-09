import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AtlasClient } from "@atlas/client";
import { loadDiscordConfigFile } from "@atlas/core/discord-config";
import { loadTelegramConfigFile } from "@atlas/core/telegram-config";
import { loadWhatsAppConfigFile } from "@atlas/core/whatsapp-config";
import { getWorkspaceChannelDir } from "@atlas/core/workspace-channel-paths";
import { makeLiveTransport } from "./live-messengers-transport";
import {
  inspectDedicatedWhatsAppCredentials,
  openDedicatedWhatsAppTransport,
} from "./live-messengers-whatsapp-runtime";

export type Messenger = "telegram" | "discord" | "whatsapp";
export interface LiveManifest {
  authorizationExpiresAt: string;
  authorizationReference: string;
  channel: Messenger;
  dedicatedTelegramPolling?: boolean;
  dedicatedWhatsAppAuthDir?: string;
  dedicatedWhatsAppSenderJid?: string;
  destination: string;
  orgId: string;
  profileId: string;
  receiverUserId: string;
  schemaVersion: 1;
  serverUrl: string;
  topicId?: number;
}

const SCOPE_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const TELEGRAM_USER = /^[1-9]\d{0,14}$/;
const TELEGRAM_CHAT = /^-?[1-9]\d{0,14}$/;
const DISCORD_ID = /^\d{17,20}$/;
const WHATSAPP_USER = /^[1-9]\d{7,14}@s\.whatsapp\.net$/;
const MESSAGE_IDS = {
  discord: DISCORD_ID,
  telegram: TELEGRAM_USER,
  whatsapp: /^[a-zA-Z0-9_-]{1,128}$/,
};
const MAX_AUTH_AGE_MS = 24 * 60 * 60 * 1000;
export const MAX_FILE_BYTES = 64 * 1024;

export function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export class LiveProofBlocked extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function requireProof(
  condition: unknown,
  code: string
): asserts condition {
  if (!condition) {
    throw new LiveProofBlocked(code);
  }
}

export function parseManifest(value: unknown, now = Date.now()): LiveManifest {
  requireProof(typeof value === "object" && value !== null, "INVALID_MANIFEST");
  const m = value as LiveManifest;
  requireProof(m.schemaVersion === 1, "INVALID_MANIFEST_VERSION");
  requireProof(
    ["telegram", "discord", "whatsapp"].includes(m.channel),
    "INVALID_CHANNEL"
  );
  for (const id of [m.orgId, m.profileId]) {
    requireProof(
      typeof id === "string" && SCOPE_ID.test(id),
      "EXPLICIT_SCOPE_REQUIRED"
    );
  }
  requireProof(
    typeof m.authorizationReference === "string" &&
      m.authorizationReference.trim().length > 0,
    "AUTHORIZATION_REFERENCE_REQUIRED"
  );
  const expiry = Date.parse(m.authorizationExpiresAt);
  requireProof(
    expiry > now && expiry <= now + MAX_AUTH_AGE_MS,
    "AUTHORIZATION_EXPIRED_OR_TOO_LONG"
  );
  let server: URL;
  try {
    server = new URL(m.serverUrl);
  } catch {
    throw new LiveProofBlocked("INVALID_SERVER_URL");
  }
  requireProof(
    server.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(server.hostname) &&
      !server.username &&
      !server.password &&
      server.pathname === "/" &&
      !server.search &&
      !server.hash,
    "LOOPBACK_SERVER_REQUIRED"
  );
  requireProof(
    typeof m.destination === "string" && typeof m.receiverUserId === "string",
    "EXPLICIT_DESTINATION_REQUIRED"
  );
  if (m.channel === "telegram") {
    requireProof(
      TELEGRAM_CHAT.test(m.destination) && TELEGRAM_USER.test(m.receiverUserId),
      "INVALID_TELEGRAM_DESTINATION"
    );
    requireProof(
      m.destination.startsWith("-") || m.destination === m.receiverUserId,
      "TELEGRAM_DM_RECEIVER_MISMATCH"
    );
    requireProof(
      m.topicId === undefined ||
        (Number.isSafeInteger(m.topicId) &&
          m.topicId > 0 &&
          m.destination.startsWith("-")),
      "INVALID_TOPIC"
    );
  } else if (m.channel === "discord") {
    requireProof(
      DISCORD_ID.test(m.destination) &&
        DISCORD_ID.test(m.receiverUserId) &&
        m.topicId === undefined,
      "INVALID_DISCORD_DESTINATION"
    );
  } else {
    // A direct chat is the only WhatsApp live proof destination currently supported.
    requireProof(
      WHATSAPP_USER.test(m.destination) &&
        m.destination === m.receiverUserId &&
        m.topicId === undefined,
      "INVALID_WHATSAPP_DESTINATION"
    );
    if (
      m.dedicatedWhatsAppAuthDir !== undefined ||
      m.dedicatedWhatsAppSenderJid !== undefined
    ) {
      requireProof(
        typeof m.dedicatedWhatsAppAuthDir === "string" &&
          m.dedicatedWhatsAppAuthDir.startsWith("/") &&
          typeof m.dedicatedWhatsAppSenderJid === "string" &&
          WHATSAPP_USER.test(m.dedicatedWhatsAppSenderJid) &&
          m.dedicatedWhatsAppSenderJid !== m.destination,
        "EXPLICIT_DEDICATED_WHATSAPP_IDENTITY_REQUIRED"
      );
    }
  }
  return m;
}

export interface SentFile {
  fileId: string;
  messageId: string;
  sentAt: number;
}
export interface Receipt {
  bytes: Uint8Array;
  destination: string;
  filename: string;
  messageId: string;
  receivedAt: number;
  receiverUserId: string;
  replyToMessageId: string;
  topicId?: number;
}
export interface RunState {
  filename: string;
  manifestSha256: string;
  nonce: string;
  sent: SentFile;
  sha256: string;
}
export interface LiveTransport {
  close?: () => Promise<void>;
  downloadSent: (sent: SentFile) => Promise<Uint8Array>;
  probe: () => Promise<void>;
  receive: (state: RunState) => Promise<Receipt | null>;
  send: (bytes: Uint8Array, filename: string) => Promise<SentFile>;
}

export function syntheticFile(nonce: string): Uint8Array {
  requireProof(/^[a-f0-9-]{36}$/.test(nonce), "INVALID_NONCE");
  return new TextEncoder().encode(
    `Atlas live messenger proof\nnonce=${nonce}\nASCII, Bahasa Indonesia, العربية, 日本語\nSynthetic test bytes only.\n`
  );
}

export function verifyReceipt(
  manifest: LiveManifest,
  state: RunState,
  receipt: Receipt
): void {
  requireProof(
    receipt.destination === manifest.destination &&
      receipt.receiverUserId === manifest.receiverUserId,
    "RECEIPT_WRONG_ACTOR_OR_DESTINATION"
  );
  requireProof(
    receipt.replyToMessageId === state.sent.messageId &&
      receipt.messageId !== state.sent.messageId,
    "RECEIPT_NOT_AN_INDEPENDENT_REPLY"
  );
  requireProof(
    receipt.filename === state.filename && receipt.topicId === manifest.topicId,
    "RECEIPT_WRONG_FILE_OR_TOPIC"
  );
  requireProof(
    receipt.receivedAt >= state.sent.sentAt &&
      receipt.receivedAt <= Date.now() + 60_000,
    "RECEIPT_STALE_OR_FUTURE"
  );
  requireProof(
    receipt.bytes.length <= MAX_FILE_BYTES &&
      digest(receipt.bytes) === state.sha256,
    "RECEIPT_BYTE_MISMATCH"
  );
}

export function parseRunState(
  value: unknown,
  manifest: LiveManifest,
  manifestSha256: string
): RunState {
  requireProof(
    typeof value === "object" && value !== null,
    "INVALID_RUN_STATE"
  );
  const state = value as RunState;
  requireProof(
    state.manifestSha256 === manifestSha256,
    "RUN_MANIFEST_MISMATCH"
  );
  requireProof(
    digest(syntheticFile(state.nonce)) === state.sha256 &&
      state.filename === `atlas-live-${state.nonce}.txt`,
    "INVALID_RUN_STATE"
  );
  requireProof(
    state.sent &&
      typeof state.sent.messageId === "string" &&
      MESSAGE_IDS[manifest.channel].test(state.sent.messageId),
    "INVALID_SENT_MESSAGE_ID"
  );
  requireProof(
    typeof state.sent.fileId === "string" &&
      state.sent.fileId.length > 0 &&
      state.sent.fileId.length < 1024,
    "INVALID_SENT_FILE_ID"
  );
  requireProof(
    Number.isFinite(state.sent.sentAt) &&
      state.sent.sentAt <= Date.now() + 60_000 &&
      state.sent.sentAt > Date.now() - MAX_AUTH_AGE_MS,
    "STALE_RUN_STATE"
  );
  return state;
}

export async function claimSingleSend(
  manifestSha256: string,
  directory = tmpdir()
): Promise<void> {
  requireProof(/^[a-f0-9]{64}$/.test(manifestSha256), "INVALID_MANIFEST_HASH");
  try {
    await writeFile(
      join(directory, `atlas-live-messenger-send-${manifestSha256}.lock`),
      "A live send was attempted. Do not retry an ambiguous send.\n",
      { flag: "wx", mode: 0o600 }
    );
  } catch {
    throw new LiveProofBlocked("MANIFEST_SEND_ALREADY_ATTEMPTED");
  }
}

export async function loadScopedPrerequisites(manifest: LiveManifest) {
  const loaders = {
    discord: loadDiscordConfigFile,
    telegram: loadTelegramConfigFile,
    whatsapp: loadWhatsAppConfigFile,
  };
  const config = await loaders[manifest.channel](manifest.orgId);
  requireProof(config, "SCOPED_CHANNEL_NOT_CONFIGURED");
  requireProof(
    config.profileId === manifest.profileId,
    "CONFIG_PROFILE_MISMATCH"
  );
  let workerAlive = false;
  try {
    const heartbeat = JSON.parse(
      await readFile(
        join(
          getWorkspaceChannelDir(manifest.channel, manifest.orgId),
          "worker-heartbeat.json"
        ),
        "utf8"
      )
    ) as { pid: number; updatedAt: string };
    if (
      Number.isSafeInteger(heartbeat.pid) &&
      heartbeat.pid > 0 &&
      Date.now() - Date.parse(heartbeat.updatedAt) < 45_000
    ) {
      process.kill(heartbeat.pid, 0);
      workerAlive = true;
    }
  } catch {
    /* Missing/stale worker heartbeat does not start a worker. */
  }
  const botToken = "botToken" in config ? config.botToken : null;
  return { accessMode: config.accessMode, botToken, workerAlive };
}

export async function authorizeLivePrincipal(
  manifest: LiveManifest
): Promise<void> {
  parseManifest(manifest);
  await loadScopedPrerequisites(manifest);
  const token = process.env.ATLAS_WORKSPACE_AUTH_TOKEN;
  requireProof(token, "SCOPED_WORKER_TOKEN_REQUIRED");
  const client = new AtlasClient({
    authToken: token,
    baseUrl: manifest.serverUrl,
    fetch: ((input, init) =>
      fetch(input, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      })) as typeof fetch,
    orgId: manifest.orgId,
    redirect: "error",
    tokenAuth: true,
  });
  const principal = await client.authorizeChannelPrincipal({
    channel: manifest.channel,
    channelUserId: manifest.receiverUserId,
    intent: "files",
    profileId: manifest.profileId,
  });
  requireProof(
    principal.orgId === manifest.orgId &&
      ["admin", "member"].includes(principal.orgRole) &&
      !principal.userId.startsWith("user_channel_guest_"),
    "CANONICAL_MEMBER_REQUIRED"
  );
}

export function requireSendAuthorization(
  manifestText: string,
  authorizedHash: string | undefined
): void {
  requireProof(
    authorizedHash === digest(manifestText),
    "EXACT_MANIFEST_AUTHORIZATION_REQUIRED"
  );
}

interface MessengerOperationIO {
  allocateDirectory: () => Promise<string>;
  authorize: () => Promise<void>;
  claimSend: () => Promise<void>;
  writeJson: (
    directory: string,
    filename: string,
    value: unknown
  ) => Promise<void>;
}

function operationError(error: unknown, fallback: string): string {
  return error instanceof LiveProofBlocked ? error.code : fallback;
}

/** Owns an already opened transport, including allocation, probe and teardown failures. */
export async function executeOpenedMessengerOperation(input: {
  inputState?: RunState;
  io?: Partial<MessengerOperationIO>;
  manifest: LiveManifest;
  manifestText: string;
  mode: string;
  report: Record<string, unknown>;
  transport: LiveTransport;
}): Promise<{
  exitCode: number;
  outputDir?: string;
  report: Record<string, unknown>;
}> {
  const { manifest, manifestText, report, transport } = input;
  const io: MessengerOperationIO = {
    allocateDirectory: () => mkdtemp(join(tmpdir(), "atlas-live-messengers-")),
    authorize: () => authorizeLivePrincipal(manifest),
    claimSend: () => claimSingleSend(digest(manifestText)),
    writeJson: async (directory, filename, value) => {
      await writeFile(
        join(directory, filename),
        JSON.stringify(value, null, 2),
        { mode: 0o600 }
      );
    },
    ...input.io,
  };
  let outputDir: string | undefined;
  try {
    requireProof(
      ["--probe", "--send", "--receive"].includes(input.mode),
      "INVALID_MODE"
    );
    await transport.probe();
    if (input.mode === "--probe") {
      report.status = "READ_ONLY_PROBE_PASS";
    } else {
      outputDir = await io.allocateDirectory();
      if (input.mode === "--send") {
        // Recheck current membership/ACL immediately before the only send.
        await io.authorize();
        const nonce = randomUUID();
        const bytes = syntheticFile(nonce);
        const filename = `atlas-live-${nonce}.txt`;
        await io.claimSend();
        report.sendAttempted = true;
        report.uploadAcceptance = "UNKNOWN_UNTIL_RESPONSE";
        const sent = await transport.send(bytes, filename);
        report.uploadAccepted = true;
        report.uploadAcceptance = "PLATFORM_CONFIRMED";
        const state: RunState = {
          filename,
          manifestSha256: digest(manifestText),
          nonce,
          sent,
          sha256: digest(bytes),
        };
        await io.writeJson(outputDir, "private-run-state.json", state);
        const downloaded = await transport.downloadSent(sent);
        requireProof(
          digest(downloaded) === state.sha256,
          "PLATFORM_DOWNLOAD_BYTE_MISMATCH"
        );
        report.platformDownloadByteMatch = true;
        report.sha256 = state.sha256;
        report.bytes = bytes.length;
        report.status = "WAITING_FOR_INDEPENDENT_RECEIPT";
      } else {
        const state = input.inputState;
        requireProof(state, "PRIVATE_RUN_STATE_REQUIRED");
        const receipt = await transport.receive(state);
        requireProof(receipt, "INDEPENDENT_RECEIPT_NOT_FOUND");
        verifyReceipt(manifest, state, receipt);
        report.independentReceiptByteMatch = true;
        report.sha256 = state.sha256;
        report.status = "INDEPENDENT_FILE_ROUNDTRIP_PASS";
      }
    }
  } catch (error) {
    report.status = "BLOCKED";
    report.reason = operationError(
      error,
      "LIVE_OPERATION_FAILED_DETAILS_REDACTED"
    );
  } finally {
    try {
      await transport.close?.();
    } catch (error) {
      // A failed teardown must never turn a confirmed upload/receipt into "unsent".
      report.cleanupError = operationError(
        error,
        "TRANSPORT_CLEANUP_FAILED_DETAILS_REDACTED"
      );
    }
  }
  if (outputDir) {
    try {
      await io.writeJson(outputDir, "evidence.json", report);
    } catch (error) {
      // Printing the accumulated evidence remains possible even if disk recording fails.
      report.evidenceWriteError = operationError(
        error,
        "EVIDENCE_WRITE_FAILED_DETAILS_REDACTED"
      );
    }
  }
  const failed =
    report.status === "BLOCKED" ||
    report.cleanupError !== undefined ||
    report.evidenceWriteError !== undefined;
  return { exitCode: failed ? 2 : 0, outputDir, report };
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const manifestPath = args[0];
  requireProof(
    manifestPath && !manifestPath.startsWith("--"),
    "MANIFEST_PATH_REQUIRED"
  );
  const mode = args[1] ?? "--dry-run";
  requireProof(
    ["--dry-run", "--probe", "--send", "--receive"].includes(mode),
    "INVALID_MODE"
  );
  requireProof(
    args.length <= (mode === "--receive" ? 3 : 2),
    "UNEXPECTED_ARGUMENT"
  );
  const manifestText = await readFile(manifestPath, "utf8");
  const manifest = parseManifest(JSON.parse(manifestText));
  const scope = await loadScopedPrerequisites(manifest);
  if (manifest.channel === "whatsapp" && manifest.dedicatedWhatsAppAuthDir) {
    await inspectDedicatedWhatsAppCredentials(manifest);
  }
  const report: Record<string, unknown> = {
    accessMode: scope.accessMode,
    channel: manifest.channel,
    destinationRef: digest(manifest.destination),
    handlerEndToEnd: "NOT_RUN",
    independentReceiptByteMatch: false,
    manifestSha256: digest(manifestText),
    mode,
    orgRef: digest(manifest.orgId),
    platformDownloadByteMatch: false,
    profileRef: digest(manifest.profileId),
    uploadAccepted: false,
    workerAlive: scope.workerAlive,
  };
  if (mode === "--dry-run") {
    console.log(
      JSON.stringify({
        ...report,
        blocker:
          manifest.channel === "whatsapp" && !manifest.dedicatedWhatsAppAuthDir
            ? "DEDICATED_WHATSAPP_FILE_SOCKET_REQUIRED"
            : null,
        networkRequests: 0,
        status: "DRY_RUN",
      })
    );
    return;
  }
  if (mode === "--send" || mode === "--receive") {
    requireSendAuthorization(
      manifestText,
      process.env.ATLAS_LIVE_AUTHORIZED_MANIFEST_SHA256
    );
  }
  await authorizeLivePrincipal(manifest);
  if (manifest.channel === "whatsapp" && mode === "--probe") {
    await inspectDedicatedWhatsAppCredentials(manifest);
    console.log(
      JSON.stringify({
        ...report,
        externalTransport: "NOT_CONNECTED",
        status: "READ_ONLY_PROBE_PASS",
      })
    );
    return;
  }
  const inputState =
    mode === "--receive"
      ? parseRunState(
          JSON.parse(await readFile(args[2] ?? "", "utf8")),
          manifest,
          digest(manifestText)
        )
      : undefined;
  const transport =
    manifest.channel === "whatsapp"
      ? await openDedicatedWhatsAppTransport(manifest, manifestText, inputState)
      : makeLiveTransport(manifest, scope.botToken ?? "", scope.workerAlive);
  const result = await executeOpenedMessengerOperation({
    inputState,
    manifest,
    manifestText,
    mode,
    report,
    transport,
  });
  process.exitCode = result.exitCode;
  console.log(
    JSON.stringify({ ...result.report, evidenceDirectory: result.outputDir })
  );
}

if (import.meta.main) {
  run().catch((error: unknown) => {
    console.log(
      JSON.stringify({
        independentReceiptByteMatch: false,
        platformDownloadByteMatch: false,
        reason:
          error instanceof LiveProofBlocked
            ? error.code
            : "PREFLIGHT_FAILED_DETAILS_REDACTED",
        status: "BLOCKED",
        uploadAccepted: false,
      })
    );
    process.exitCode = 2;
  });
}
