import { chmod, mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  writePrivateTextFile,
} from "@atlas/core/fs";
import {
  type AuthenticationCreds,
  type AuthenticationState,
  BufferJSON,
  initAuthCreds,
  proto,
  type SignalDataTypeMap,
} from "@whiskeysockets/baileys";

const PRIVATE_UMASK = 0o077;
const authFileWrites = new Map<string, Promise<void>>();
const PATH_SLASH = /\//g;
const PATH_COLON = /:/g;

interface PrivateMultiFileAuthState {
  saveCreds: () => Promise<void>;
  state: AuthenticationState;
}

export async function usePrivateMultiFileAuthState(
  directory: string
): Promise<PrivateMultiFileAuthState> {
  if (process.platform !== "win32") {
    // The bridge is a dedicated process whose only child starts before auth setup.
    // Keep this mask in place for every later Baileys credential and key creation.
    // biome-ignore lint/suspicious/noBitwiseOperators: preserve stricter existing process restrictions.
    process.umask(process.umask() | PRIVATE_UMASK);
  }

  await mkdir(directory, { mode: PRIVATE_DIR_MODE, recursive: true });
  await chmod(directory, PRIVATE_DIR_MODE);

  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile()) {
      await chmod(join(directory, entry.name), PRIVATE_FILE_MODE);
    }
  }

  const filePath = (file: string) =>
    resolve(directory, file.replace(PATH_SLASH, "__").replace(PATH_COLON, "-"));
  const read = async (file: string): Promise<unknown> => {
    const path = filePath(file);
    await authFileWrites.get(path);
    try {
      return JSON.parse(await readFile(path, "utf8"), BufferJSON.reviver);
    } catch (error) {
      if (isMissingFile(error)) {
        return;
      }
      // A damaged ratchet or credential is not a new identity. Keep the source
      // intact for recovery instead of silently replacing it with fresh keys.
      throw new Error(
        "WhatsApp authentication state could not be read. Restore its backup or reconnect the linked device."
      );
    }
  };
  const write = async (file: string, data: unknown): Promise<void> => {
    const path = filePath(file);
    const serialized =
      data == null ? undefined : JSON.stringify(data, BufferJSON.replacer);
    await serializeAuthFileWrite(path, async () => {
      if (serialized !== undefined) {
        await writePrivateTextFile(path, serialized);
        return;
      }
      try {
        await unlink(path);
      } catch (error) {
        if (!isMissingFile(error)) {
          throw error;
        }
      }
    });
  };
  const storedCreds = await read("creds.json");
  if (storedCreds !== undefined && !isStoredCredentials(storedCreds)) {
    throw new Error(
      "WhatsApp credentials are invalid. Restore their backup or reconnect the linked device."
    );
  }
  const creds = storedCreds ?? initAuthCreds();
  return {
    saveCreds: () => write("creds.json", creds),
    state: {
      creds,
      keys: {
        async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
          const result: Record<string, SignalDataTypeMap[T]> = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await read(`${type}-${id}.json`);
              if (value === undefined || value === null) {
                return;
              }
              if (type === "app-state-sync-key") {
                value = proto.Message.AppStateSyncKeyData.fromObject(
                  value as Record<string, unknown>
                );
              }
              result[id] = value as SignalDataTypeMap[T];
            })
          );
          return result;
        },
        async set(data) {
          const writes: Promise<void>[] = [];
          for (const [category, values] of Object.entries(data)) {
            for (const [id, value] of Object.entries(values ?? {})) {
              writes.push(write(`${category}-${id}.json`, value));
            }
          }
          await Promise.all(writes);
        },
      },
    },
  };
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isStoredCredentials(value: unknown): value is AuthenticationCreds {
  return Boolean(
    value &&
      typeof value === "object" &&
      "signedIdentityKey" in value &&
      "signedPreKey" in value &&
      "noiseKey" in value &&
      "registrationId" in value
  );
}

async function serializeAuthFileWrite(
  path: string,
  operation: () => Promise<void>
): Promise<void> {
  const previous = authFileWrites.get(path);
  const next = (async () => {
    // A failed write must still reach its caller, but cannot poison future saves.
    await previous?.catch(() => undefined);
    await operation();
  })();
  authFileWrites.set(path, next);
  try {
    await next;
  } finally {
    if (authFileWrites.get(path) === next) {
      authFileWrites.delete(path);
    }
  }
}
