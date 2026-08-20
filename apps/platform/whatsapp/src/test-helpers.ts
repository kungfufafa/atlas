import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import type { AtlasClient, StreamHandlers } from "@atlas/client";
import {
  assertBridgeClientMethods,
  parseListProfilesResponse,
  parseListUserOrgsResponse,
} from "@atlas/core/bridge-api";
import { ChannelOrgStore } from "@atlas/core/channel-org";
import type { ProfileSummary, UserOrgSummary } from "@atlas/core/contract";

export interface MockStreamControl {
  complete(reply?: string): void;
  fail(error?: Error): void;
  readonly signal: AbortSignal | undefined;
}

type StreamStep =
  | { type: "chunk"; delta: string }
  | { type: "thinking"; delta?: string }
  | { type: "tool_start" }
  | { type: "tool_end" }
  | { type: "error"; message: string }
  | { type: "resolve"; reply?: string };

export function createMultiTestOrgs(): UserOrgSummary[] {
  const now = new Date().toISOString();
  return [
    {
      createdAt: now,
      id: "org_a",
      name: "Acme",
      role: "admin",
      slug: "acme",
      updatedAt: now,
    },
    {
      createdAt: now,
      id: "org_b",
      name: "Beta",
      role: "member",
      slug: "beta",
      updatedAt: now,
    },
  ];
}

export function createDefaultTestOrgs(): UserOrgSummary[] {
  const now = new Date().toISOString();
  return [
    {
      createdAt: now,
      id: "org_test",
      name: "Test Org",
      role: "admin",
      slug: "test-org",
      updatedAt: now,
    },
  ];
}

export function createMockClient(
  options: {
    streaming?: boolean;
    steps?: StreamStep[];
    autoComplete?: boolean;
    profiles?: ProfileSummary[];
    orgs?: UserOrgSummary[];
  } = {}
) {
  const calls = {
    compact: 0,
    createSession: 0,
    listProfiles: 0,
    listUserOrgs: 0,
    profileIds: [] as string[],
    sendStream: 0,
    setOrgId: 0,
  };
  const orgIds: string[] = [];

  let streamControl: MockStreamControl | null = null;

  const sendStream = async (
    _input: unknown,
    handlers: unknown,
    streamOptions?: { signal?: AbortSignal }
  ) => {
    calls.sendStream += 1;

    if (!options.streaming) {
      return "Agent reply";
    }

    const streamHandlers = handlers as StreamHandlers;

    return new Promise<string>((resolve, reject) => {
      let settled = false;

      streamControl = {
        complete(reply = "Agent reply") {
          if (settled) {
            return;
          }
          settled = true;
          resolve(reply);
        },
        fail(error = new Error("Stream failed")) {
          if (settled) {
            return;
          }
          settled = true;
          reject(error);
        },
        get signal() {
          return streamOptions?.signal;
        },
      };

      streamOptions?.signal?.addEventListener(
        "abort",
        () => {
          if (settled) {
            return;
          }
          settled = true;
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true }
      );

      queueMicrotask(() => {
        for (const step of options.steps ?? []) {
          if (settled) {
            break;
          }

          switch (step.type) {
            case "chunk":
              streamHandlers.onChunk(step.delta);
              break;
            case "thinking":
              streamHandlers.onThinking?.(step.delta ?? "");
              break;
            case "tool_start":
              streamHandlers.onToolStart?.({
                input: {},
                tool: "todo_write",
                toolCallId: "tool_call_1",
              });
              break;
            case "tool_end":
              streamHandlers.onToolEnd?.({
                result: {},
                tool: "todo_write",
                toolCallId: "tool_call_1",
              });
              break;
            case "error":
              streamControl?.fail(new Error(step.message));
              break;
            case "resolve":
              streamControl?.complete(step.reply);
              break;
          }
        }

        if (
          !settled &&
          options.steps?.length &&
          options.autoComplete !== false
        ) {
          streamControl?.complete("Agent reply");
        }
      });
    });
  };

  const session = {
    clear: async () => {},
    compact: async () => {
      calls.compact += 1;
      return {
        action: "summarized" as const,
        messagesAfter: 4,
        messagesBefore: 10,
      };
    },
    createAutomation: async () => ({}),
    getMessages: async () => [],
    id: "session_test",
    purge: async () => {},
    send: async () => "ok",
    sendStream,
  };

  const orgs = options.orgs ?? createDefaultTestOrgs();
  let activeOrgId: string | null = orgs[0]?.id ?? null;
  const orgIdScope = new AsyncLocalStorage<{ orgId: string | null }>();

  const client = {
    createChatSession: () => session,
    createSession: async (
      _channel: unknown,
      options: { profileId?: string } = {}
    ) => {
      calls.createSession += 1;
      calls.profileIds.push(options.profileId ?? "default");
      return session;
    },
    getModels: async () => ({
      currentProviderId: null,
      displayName: null,
      models: [],
      provider: null,
      providers: [],
    }),
    health: async () => ({ ok: true, providerConfigured: false }),
    isolateOrgId: <T>(fn: () => T | Promise<T>) =>
      orgIdScope.run({ orgId: activeOrgId }, fn),
    listProfiles: async () => {
      calls.listProfiles += 1;
      return parseListProfilesResponse({
        profiles: options.profiles ?? [createDefaultProfileSummary()],
      });
    },
    listUserOrgs: async () => {
      calls.listUserOrgs += 1;
      return parseListUserOrgsResponse({ orgs });
    },
    setOrgId: (orgId: string | null) => {
      calls.setOrgId += 1;
      const next = orgId?.trim() || null;
      const scope = orgIdScope.getStore();
      if (scope) {
        scope.orgId = next;
      } else {
        activeOrgId = next;
      }
      orgIds.push(next ?? "");
    },
  } as unknown as AtlasClient;

  assertBridgeClientMethods(client);

  return {
    calls,
    client,
    getStreamControl: () => streamControl,
    orgIds,
  };
}

function createDefaultProfileSummary(): ProfileSummary {
  const now = new Date().toISOString();
  return {
    createdAt: now,
    hasAvatar: false,
    id: "default",
    isSuper: false,
    mcpServerCount: 0,
    model: null,
    name: "Default",
    soulActive: false,
    toolCount: 0,
    updatedAt: now,
  };
}

export async function writeWhatsAppConfigIni(
  homeDir: string,
  config: {
    phoneNumber: string;
    profileId?: string;
    pairingCode?: string | null;
    pairedJid?: string | null;
    accessMode?: string;
    allowedNumbers?: string[];
    blockedNumbers?: string[];
  }
): Promise<void> {
  const dir = path.join(homeDir, ".atlas", "whatsapp");
  await mkdir(dir, { recursive: true });

  const lines = [
    "# Atlas WhatsApp bridge",
    `phone_number=${config.phoneNumber}`,
    `profile_id=${config.profileId ?? "default"}`,
  ];

  if (config.accessMode) {
    lines.push(`access_mode=${config.accessMode}`);
  }

  if (config.allowedNumbers?.length) {
    lines.push(`allowed_numbers=${config.allowedNumbers.join(",")}`);
  }

  if (config.blockedNumbers?.length) {
    lines.push(`blocked_numbers=${config.blockedNumbers.join(",")}`);
  }

  if (config.pairingCode) {
    lines.push(`pairing_code=${config.pairingCode}`);
  }

  if (config.pairedJid) {
    lines.push(`paired_jid=${config.pairedJid}`);
  }

  lines.push("");
  await writeFile(path.join(dir, "config.ini"), lines.join("\n"), "utf8");
}

export function createTestOrgStore(homeDir: string): ChannelOrgStore {
  return new ChannelOrgStore(
    path.join(homeDir, ".atlas", "whatsapp", "org-selection.json")
  );
}

let tempHomeChain: Promise<void> = Promise.resolve();

export async function waitForStreamControl(
  getStreamControl: () => MockStreamControl | null,
  timeoutMs = 2000
): Promise<MockStreamControl> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const control = getStreamControl();

    if (control?.signal) {
      return control;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error("Timed out waiting for stream control");
}

export async function withTempHome<T>(
  run: (homeDir: string) => Promise<T>
): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = tempHomeChain;
  tempHomeChain = previous.then(() => gate);

  await previous;

  const homeDir = await mkdtemp(path.join(os.tmpdir(), "atlas-whatsapp-home-"));
  const configDir = path.join(homeDir, ".atlas");
  const previousConfigDir = process.env.ATLAS_CONFIG_DIR;
  process.env.ATLAS_CONFIG_DIR = configDir;

  try {
    return await run(homeDir);
  } finally {
    if (previousConfigDir === undefined) {
      delete process.env.ATLAS_CONFIG_DIR;
    } else {
      process.env.ATLAS_CONFIG_DIR = previousConfigDir;
    }

    await rm(homeDir, { force: true, recursive: true });
    release();
  }
}
