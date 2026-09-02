import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { nanoid } from "nanoid";
import type { ChannelType } from "./contract";
import { readTextOrNull, writePrivateTextFile } from "./fs";
import {
  getUserConfigDir,
  loadUserConfig,
  saveUserConfig,
  type UserConfig,
} from "./user-config";

export const LOCAL_CLIENT_EMAIL = "local-client@atlas.internal";
export const LOCAL_CLIENT_USER_ID = "user_local_client";
const LOCAL_AUTH_TOKEN_PREFIX = "tc_local_";
const LOCAL_AUTH_TOKEN_FILENAME = "local-auth-token";
const WORKSPACE_WORKER_AUTH_TOKEN_PREFIX = "tc_worker_v1_";
export const WORKSPACE_WORKER_AUTH_TOKEN_ENV = "ATLAS_WORKSPACE_AUTH_TOKEN";
const WORKSPACE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const WORKSPACE_WORKER_CHANNELS = new Set<ChannelType>([
  "telegram",
  "whatsapp",
  "discord",
]);

export interface WorkspaceWorkerAuthClaim {
  channel: ChannelType;
  orgId: string;
}

export class LocalAuthTokenManagedExternallyError extends Error {
  constructor() {
    super(
      "Local auth token is managed by ATLAS_LOCAL_AUTH_TOKEN and cannot be rotated on disk."
    );
    this.name = "LocalAuthTokenManagedExternallyError";
  }
}

function generateLocalAuthToken(): string {
  return `${LOCAL_AUTH_TOKEN_PREFIX}${nanoid(48)}`;
}

function hashLocalAuthToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function getLocalAuthTokenPath(): string {
  return join(getUserConfigDir(), LOCAL_AUTH_TOKEN_FILENAME);
}

function toPersistedUserConfig(
  config: Awaited<ReturnType<typeof loadUserConfig>>
): UserConfig {
  return {
    defaultProviderId: config?.defaultProviderId ?? null,
    providers: config?.providers ?? [],
    ...(config?.timezone ? { timezone: config.timezone } : {}),
    ...(config?.thinkingEnabled === undefined
      ? {}
      : { thinkingEnabled: config.thinkingEnabled }),
    ...(config?.thinkingEffort
      ? { thinkingEffort: config.thinkingEffort }
      : {}),
    ...(config?.localAuthTokenHash
      ? { localAuthTokenHash: config.localAuthTokenHash }
      : {}),
    ...(config?.localAuthToken
      ? { localAuthToken: config.localAuthToken }
      : {}),
  };
}

async function loadStoredLocalAuthToken(): Promise<string | null> {
  const token = await readTextOrNull(getLocalAuthTokenPath());
  return token?.trim() || null;
}

async function persistLocalAuthToken(token: string): Promise<void> {
  await writePrivateTextFile(getLocalAuthTokenPath(), `${token}\n`, {
    ensureDir: getUserConfigDir(),
  });
}

function compareTokenHash(token: string, expectedHashHex: string): boolean {
  const actualHash = createHash("sha256").update(token).digest();
  const expectedHash = Buffer.from(expectedHashHex, "hex");

  return (
    actualHash.length === expectedHash.length &&
    timingSafeEqual(actualHash, expectedHash)
  );
}

function workspaceWorkerTokenSignature(
  payload: string,
  signingSecret: string
): Buffer {
  return createHmac("sha256", signingSecret).update(payload).digest();
}

function normalizeWorkspaceWorkerClaim(
  claim: WorkspaceWorkerAuthClaim
): WorkspaceWorkerAuthClaim {
  const orgId = claim.orgId.trim();
  if (!WORKSPACE_ID_PATTERN.test(orgId)) {
    throw new Error("Invalid workspace id for worker credential.");
  }
  if (!WORKSPACE_WORKER_CHANNELS.has(claim.channel)) {
    throw new Error("Invalid channel for worker credential.");
  }
  return { channel: claim.channel, orgId };
}

export function isWorkspaceWorkerAuthToken(token: string): boolean {
  return token.startsWith(WORKSPACE_WORKER_AUTH_TOKEN_PREFIX);
}

/**
 * Mint a bearer credential that is cryptographically restricted to one
 * workspace and one bridge channel. The host local token is only used as the
 * signing key and is never embedded in the worker credential.
 */
export async function createWorkspaceWorkerAuthToken(
  claim: WorkspaceWorkerAuthClaim
): Promise<string> {
  const normalized = normalizeWorkspaceWorkerClaim(claim);
  const payload = Buffer.from(
    JSON.stringify({ ...normalized, version: 1 })
  ).toString("base64url");
  const signingSecret = await resolveLocalAuthToken();
  const signature = workspaceWorkerTokenSignature(
    payload,
    signingSecret
  ).toString("base64url");
  return `${WORKSPACE_WORKER_AUTH_TOKEN_PREFIX}${payload}.${signature}`;
}

export async function verifyWorkspaceWorkerAuthToken(
  token: string
): Promise<WorkspaceWorkerAuthClaim | null> {
  if (!(token.length <= 4096 && isWorkspaceWorkerAuthToken(token))) {
    return null;
  }

  const encoded = token.slice(WORKSPACE_WORKER_AUTH_TOKEN_PREFIX.length);
  const [payload, signature, extra] = encoded.split(".");
  if (!(payload && signature) || extra !== undefined) {
    return null;
  }

  const signingSecret = await resolveLocalAuthToken();
  const expected = workspaceWorkerTokenSignature(payload, signingSecret);
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      channel?: unknown;
      orgId?: unknown;
      version?: unknown;
    };
    if (
      parsed.version !== 1 ||
      typeof parsed.channel !== "string" ||
      typeof parsed.orgId !== "string"
    ) {
      return null;
    }
    return normalizeWorkspaceWorkerClaim({
      channel: parsed.channel as ChannelType,
      orgId: parsed.orgId,
    });
  } catch {
    return null;
  }
}

/**
 * Workspace workers must fail closed when their scoped token was not injected;
 * legacy/global workers keep using the host local credential.
 */
export async function loadPlatformWorkerAuthToken(
  channel: ChannelType,
  workspaceId: string | undefined,
  env: Record<string, string | undefined> = process.env
): Promise<string> {
  if (!WORKSPACE_WORKER_CHANNELS.has(channel)) {
    throw new Error("Invalid platform worker channel.");
  }
  if (workspaceId) {
    const token = env[WORKSPACE_WORKER_AUTH_TOKEN_ENV]?.trim();
    if (!token) {
      throw new Error(
        `${WORKSPACE_WORKER_AUTH_TOKEN_ENV} is required for a workspace worker.`
      );
    }
    return token;
  }

  return resolveLocalAuthToken();
}

function envManagedLocalAuthToken(): string | undefined {
  return (
    process.env.ATLAS_LOCAL_AUTH_TOKEN?.trim() ||
    process.env.atlas_LOCAL_AUTH_TOKEN?.trim() ||
    undefined
  );
}

export async function resolveLocalAuthToken(): Promise<string> {
  const envToken = envManagedLocalAuthToken();
  if (envToken) {
    return envToken;
  }

  const config = await loadUserConfig();
  const storedToken = await loadStoredLocalAuthToken();

  if (
    config?.localAuthTokenHash?.trim() &&
    storedToken &&
    compareTokenHash(storedToken, config.localAuthTokenHash.trim())
  ) {
    return storedToken;
  }

  const legacyToken = config?.localAuthToken?.trim();
  if (legacyToken) {
    await persistLocalAuthToken(legacyToken);
    await saveUserConfig({
      ...toPersistedUserConfig(config),
      localAuthTokenHash: hashLocalAuthToken(legacyToken),
    });
    return legacyToken;
  }

  const generated = generateLocalAuthToken();
  const newConfig = toPersistedUserConfig(config);
  await persistLocalAuthToken(generated);
  await saveUserConfig({
    ...newConfig,
    localAuthTokenHash: hashLocalAuthToken(generated),
  });
  return generated;
}

export async function loadLocalAuthToken(
  _email = LOCAL_CLIENT_EMAIL
): Promise<string | null> {
  return resolveLocalAuthToken();
}

export async function rotateLocalAuthToken(): Promise<string> {
  if (envManagedLocalAuthToken()) {
    throw new LocalAuthTokenManagedExternallyError();
  }

  const config = await loadUserConfig();
  const token = generateLocalAuthToken();

  await persistLocalAuthToken(token);
  await saveUserConfig({
    ...toPersistedUserConfig(config),
    localAuthTokenHash: hashLocalAuthToken(token),
  });

  return token;
}

export async function verifyLocalAuthToken(
  token: string
): Promise<{ email: string } | null> {
  if (!token) {
    return null;
  }

  const envToken = envManagedLocalAuthToken();
  if (envToken) {
    return compareTokenHash(token, hashLocalAuthToken(envToken))
      ? { email: LOCAL_CLIENT_EMAIL }
      : null;
  }

  const config = await loadUserConfig();
  const expectedHash = config?.localAuthTokenHash?.trim();
  if (expectedHash) {
    return compareTokenHash(token, expectedHash)
      ? { email: LOCAL_CLIENT_EMAIL }
      : null;
  }

  const legacyToken = config?.localAuthToken?.trim();
  if (legacyToken && compareTokenHash(token, hashLocalAuthToken(legacyToken))) {
    return { email: LOCAL_CLIENT_EMAIL };
  }

  return null;
}
