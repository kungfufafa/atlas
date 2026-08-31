import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "./fs";
import { getWhatsAppConfigDir } from "./whatsapp-config";

const OUTBOUND_AUTH_TOKEN_FILENAME = "outbound-auth-token";
const OUTBOUND_AUTH_TOKEN_PREFIX = "atlas_wa_";
const OUTBOUND_AUTH_TOKEN_PATTERN = /^atlas_wa_[A-Za-z0-9_-]{43}$/;
const NO_FOLLOW_FLAG = constants.O_NOFOLLOW ?? 0;

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isExistingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

function assertPrivateDirectory(stats: Stats, directory: string): void {
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(
      `WhatsApp outbound auth directory is not a private directory: ${directory}`
    );
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { mode: PRIVATE_DIR_MODE, recursive: true });
  const stats = await lstat(directory);
  assertPrivateDirectory(stats, directory);
  await chmod(directory, PRIVATE_DIR_MODE);
}

function assertValidToken(token: string, path: string): string {
  if (!OUTBOUND_AUTH_TOKEN_PATTERN.test(token)) {
    throw new Error(
      `WhatsApp outbound auth token is invalid; remove ${path} and restart the worker to rotate it.`
    );
  }

  return token;
}

async function readPersistedToken(path: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;

  try {
    // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags are bitmasks.
    handle = await open(path, constants.O_RDONLY | NO_FOLLOW_FLAG);
    const stats = await handle.stat();

    if (!stats.isFile()) {
      throw new Error(`WhatsApp outbound auth token is not a file: ${path}`);
    }

    await handle.chmod(PRIVATE_FILE_MODE);
    const token = (await handle.readFile("utf8")).trim();
    return assertValidToken(token, path);
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function generateToken(): string {
  return `${OUTBOUND_AUTH_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function getWhatsAppOutboundAuthTokenPath(
  orgId?: string | null
): string {
  return join(getWhatsAppConfigDir(orgId), OUTBOUND_AUTH_TOKEN_FILENAME);
}

export async function loadOrCreateWhatsAppOutboundAuthToken(
  orgId?: string | null
): Promise<string> {
  const directory = getWhatsAppConfigDir(orgId);
  const path = getWhatsAppOutboundAuthTokenPath(orgId);
  await ensurePrivateDirectory(directory);

  const existing = await readPersistedToken(path);
  if (existing) {
    return existing;
  }

  const token = generateToken();
  const temporaryPath = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;

  try {
    handle = await open(
      temporaryPath,
      // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags are bitmasks.
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        NO_FOLLOW_FLAG,
      PRIVATE_FILE_MODE
    );
    await handle.writeFile(`${token}\n`, "utf8");
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.sync();
    await handle.close();
    handle = null;

    try {
      await link(temporaryPath, path);
      return token;
    } catch (error) {
      if (isExistingFileError(error)) {
        const concurrentToken = await readPersistedToken(path);
        if (concurrentToken) {
          return concurrentToken;
        }
      }
      throw error;
    }
  } finally {
    await handle?.close();
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!isMissingFileError(error)) {
        throw error;
      }
    });
  }
}

export function formatWhatsAppOutboundAuthorization(token: string): string {
  return `Bearer ${token}`;
}

export function verifyWhatsAppOutboundAuthorization(
  authorization: string | null,
  expectedToken: string
): boolean {
  const expected = formatWhatsAppOutboundAuthorization(expectedToken);
  const actualDigest = createHash("sha256")
    .update(authorization ?? "")
    .digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}
