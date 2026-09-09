import {
  readdir,
  readFile,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  getUserConfigDir,
  runWithUserConfigDir,
} from "@atlas/core/user-config";
import {
  loadWhatsAppConfigFile,
  normalizePhoneNumberDigits,
} from "@atlas/core/whatsapp-config";
import {
  getWorkspaceChannelDir,
  listConfiguredChannelWorkspaceIds,
} from "@atlas/core/workspace-channel-paths";
import { usePrivateMultiFileAuthState } from "../../apps/platform/whatsapp/src/auth-state";
import { createBaileysLogger } from "../../apps/platform/whatsapp/src/baileys-logger";
import {
  authorizeLivePrincipal,
  digest,
  type LiveManifest,
  LiveProofBlocked,
  type LiveTransport,
  loadScopedPrerequisites,
  parseManifest,
  type RunState,
  requireProof,
  requireSendAuthorization,
} from "./live-messengers";
import { DedicatedWhatsAppProofTransport } from "./live-messengers-whatsapp";

type Socket = ConstructorParameters<
  typeof DedicatedWhatsAppProofTransport
>[1]["socket"];
type Message = Parameters<DedicatedWhatsAppProofTransport["offerInbound"]>[0];
interface CredentialIdentity {
  me?: { id?: string };
  registered?: boolean;
}

function phoneJid(id: string | undefined): string | null {
  if (!id) {
    return null;
  }
  const phone = id.split("@")[0]?.split(":")[0];
  return phone ? `${phone}@s.whatsapp.net` : null;
}

function contains(parent: string, child: string): boolean {
  const remainder = relative(parent, child);
  return (
    remainder === "" || !(remainder.startsWith("..") || isAbsolute(remainder))
  );
}

/** Read-only preflight, including dry run. Never creates authentication state. */
export async function inspectDedicatedWhatsAppCredentials(
  manifest: LiveManifest
): Promise<string> {
  parseManifest(manifest);
  requireProof(
    manifest.channel === "whatsapp" &&
      manifest.dedicatedWhatsAppAuthDir &&
      manifest.dedicatedWhatsAppSenderJid,
    "DEDICATED_WHATSAPP_FILE_SOCKET_REQUIRED"
  );
  const authDir = await realpath(manifest.dedicatedWhatsAppAuthDir);
  const configRoots = new Set([getUserConfigDir(), join(homedir(), ".atlas")]);
  for (const root of configRoots) {
    const configRoot = await realpath(root).catch(() => resolve(root));
    requireProof(
      !(contains(configRoot, authDir) || contains(authDir, configRoot)),
      "OPERATIONAL_WHATSAPP_AUTH_DIRECTORY_DENIED"
    );
  }
  const entries = await readdir(authDir, { withFileTypes: true });
  requireProof(
    entries.every((entry) => entry.isFile() && !entry.isSymbolicLink()),
    "DEDICATED_AUTH_MUST_CONTAIN_REGULAR_FILES_ONLY"
  );
  // Reject a symlinked credentials file that points out of the declared directory.
  requireProof(
    dirname(await realpath(join(authDir, "creds.json"))) === authDir,
    "DEDICATED_CREDENTIAL_SYMLINK_DENIED"
  );
  const credentials = JSON.parse(
    await readFile(join(authDir, "creds.json"), "utf8")
  ) as CredentialIdentity;
  requireProof(
    credentials.registered === true &&
      phoneJid(credentials.me?.id) === manifest.dedicatedWhatsAppSenderJid,
    "REGISTERED_DEDICATED_IDENTITY_REQUIRED"
  );
  const config = await loadWhatsAppConfigFile(manifest.orgId);
  const scope = await loadScopedPrerequisites(manifest);
  requireProof(
    config &&
      `${normalizePhoneNumberDigits(config.phoneNumber)}@s.whatsapp.net` ===
        manifest.dedicatedWhatsAppSenderJid &&
      !scope.workerAlive,
    "WHATSAPP_DEDICATED_SCOPE_MISMATCH"
  );
  // A copied credential directory must not create a duplicate operational identity.
  for (const root of configRoots) {
    await runWithUserConfigDir(root, async () => {
      const orgs: Array<string | null> = [
        null,
        ...(await listConfiguredChannelWorkspaceIds("whatsapp")),
      ];
      for (const orgId of orgs) {
        let existing: CredentialIdentity;
        try {
          existing = JSON.parse(
            await readFile(
              join(
                getWorkspaceChannelDir("whatsapp", orgId),
                "auth",
                "creds.json"
              ),
              "utf8"
            )
          ) as CredentialIdentity;
        } catch {
          continue;
        }
        requireProof(
          phoneJid(existing.me?.id) !== manifest.dedicatedWhatsAppSenderJid,
          "OPERATIONAL_WHATSAPP_IDENTITY_DUPLICATE_DENIED"
        );
      }
    });
  }
  return authDir;
}

/** One opted-in connection with registered credentials; no login, QR or reconnect. */
export async function openDedicatedWhatsAppTransport(
  manifest: LiveManifest,
  manifestText: string,
  expectedReply?: RunState
): Promise<LiveTransport> {
  requireSendAuthorization(
    manifestText,
    process.env.ATLAS_LIVE_AUTHORIZED_MANIFEST_SHA256
  );
  requireProof(
    JSON.stringify(parseManifest(JSON.parse(manifestText))) ===
      JSON.stringify(manifest),
    "DEDICATED_MANIFEST_MISMATCH"
  );
  const authDir = await inspectDedicatedWhatsAppCredentials(manifest);
  await authorizeLivePrincipal(manifest);
  const lockPath = join(authDir, ".atlas-live-proof-socket.lock");
  try {
    await writeFile(lockPath, String(process.pid), { flag: "wx", mode: 0o600 });
  } catch {
    throw new LiveProofBlocked("DEDICATED_WHATSAPP_SOCKET_ALREADY_CLAIMED");
  }
  let socket: Socket | undefined;
  let pendingCredentialWrite = Promise.resolve();
  let closed = false;
  const close = async () => {
    if (closed) {
      return;
    }
    closed = true;
    socket?.end(undefined);
    await pendingCredentialWrite.catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  };
  try {
    const auth = await usePrivateMultiFileAuthState(authDir);
    requireProof(
      auth.state.creds.registered,
      "REGISTERED_DEDICATED_IDENTITY_REQUIRED"
    );
    const requireFromWorker = createRequire(
      new URL("../../apps/platform/whatsapp/package.json", import.meta.url)
    );
    const baileys = (await import(
      requireFromWorker.resolve("@whiskeysockets/baileys")
    )) as { makeWASocket: (options: Record<string, unknown>) => Socket };
    socket = baileys.makeWASocket({
      auth: auth.state,
      browser: ["Atlas Dedicated File Proof", "Chrome", "4.0.0"],
      connectTimeoutMs: 20_000,
      emitOwnEvents: false,
      generateHighQualityLinkPreview: false,
      logger: createBaileysLogger(
        () => undefined,
        () => undefined
      ),
      markOnlineOnConnect: false,
      printQRInTerminal: false,
      shouldSyncHistoryMessage: () => false,
      syncFullHistory: false,
    });
    const active = socket;
    const adapter = new DedicatedWhatsAppProofTransport(manifest, {
      authorizedManifestSha256: digest(JSON.stringify(manifest)),
      dedicatedRuntime: true,
      operationalWorkerAlive: false,
      socket: active,
    });
    if (expectedReply) {
      adapter.expectReply(expectedReply);
    }
    let wakeReceipt: (() => void) | undefined;
    active.ev.on("messages.upsert", (event: { messages: Message[] }) => {
      for (const message of event.messages) {
        if (adapter.offerInbound(message)) {
          wakeReceipt?.();
        }
      }
    });
    active.ev.on("creds.update", () => {
      pendingCredentialWrite = pendingCredentialWrite
        .then(auth.saveCreds)
        .catch(() => {
          active.end(new Error("DEDICATED_CREDENTIAL_SAVE_FAILED"));
        });
    });
    await new Promise<void>((resolveReady, rejectReady) => {
      const timeout = setTimeout(
        () => rejectReady(new Error("DEDICATED_WHATSAPP_CONNECT_TIMEOUT")),
        20_000
      );
      active.ev.on("connection.update", (update) => {
        if (update.qr || update.connection === "close") {
          clearTimeout(timeout);
          rejectReady(
            new Error("DEDICATED_WHATSAPP_LOGIN_OR_RECONNECT_DENIED")
          );
          active.end(undefined);
        } else if (update.connection === "open") {
          clearTimeout(timeout);
          resolveReady();
        }
      });
    });
    return {
      close,
      downloadSent: (sent) => adapter.downloadSent(sent),
      probe: () => adapter.probe(),
      receive: async (state) => {
        const existing = await adapter.receive(state);
        if (existing) {
          return existing;
        }
        await new Promise<void>((resolveReceipt) => {
          const timeout = setTimeout(resolveReceipt, 30_000);
          wakeReceipt = () => {
            clearTimeout(timeout);
            resolveReceipt();
          };
        });
        wakeReceipt = undefined;
        return adapter.receive(state);
      },
      send: (bytes, filename) => adapter.send(bytes, filename),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
