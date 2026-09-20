import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { usePrivateMultiFileAuthState } from "./auth-state";

const POSIX = process.platform !== "win32";
const temporaryDirectories: string[] = [];
const PRE_KEY = {
  private: Buffer.from([1, 2, 3]),
  public: Buffer.from([4, 5, 6]),
};
let previousUmask: number | null = null;

beforeEach(() => {
  if (POSIX) {
    previousUmask = process.umask(0o022);
  }
});

afterEach(async () => {
  if (previousUmask !== null) {
    process.umask(previousUmask);
    previousUmask = null;
  }
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function createAuthDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atlas-whatsapp-auth-state-"));
  temporaryDirectories.push(root);
  return join(root, "auth");
}

async function modeOf(path: string): Promise<number> {
  // biome-ignore lint/suspicious/noBitwiseOperators: permission bits are stored in st_mode.
  return (await stat(path)).mode & 0o777;
}

async function expectPrivate(
  directory: string,
  files: string[]
): Promise<void> {
  expect(await modeOf(directory)).toBe(0o700);
  for (const file of files) {
    expect(await modeOf(file)).toBe(0o600);
  }
}

describe("private WhatsApp auth state", () => {
  test("refuses corrupt credentials without replacing the saved identity", async () => {
    const directory = await createAuthDirectory();
    await mkdir(directory);
    const path = join(directory, "creds.json");
    const truncated = '{"signedIdentityKey":';
    await writeFile(path, truncated);
    await expect(usePrivateMultiFileAuthState(directory)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(truncated);
  });

  test("does not treat damaged Signal state as an absent session", async () => {
    const directory = await createAuthDirectory();
    const { state } = await usePrivateMultiFileAuthState(directory);
    await writeFile(join(directory, "session-peer.json"), "{broken");
    await expect(state.keys.get("session", ["peer"])).rejects.toThrow();
    expect(await state.keys.get("session", ["missing"])).toEqual({});
  });

  test("serializes concurrent key writes and preserves the previous complete inode", async () => {
    const directory = await createAuthDirectory();
    const { state } = await usePrivateMultiFileAuthState(directory);
    await state.keys.set({ "pre-key": { "1": PRE_KEY } });
    const originalFile = await open(join(directory, "pre-key-1.json"), "r");
    const originalBytes = await originalFile.readFile();
    const firstInode = (await originalFile.stat()).ino;
    const lastKey = { private: Buffer.from([9]), public: Buffer.from([8]) };
    await Promise.all([
      state.keys.set({ "pre-key": { "1": PRE_KEY } }),
      state.keys.set({ "pre-key": { "1": lastKey } }),
    ]);
    expect(await state.keys.get("pre-key", ["1"])).toEqual({ "1": lastKey });
    expect((await stat(join(directory, "pre-key-1.json"))).ino).not.toBe(
      firstInode
    );
    const previousBytes = Buffer.alloc(originalBytes.length);
    await originalFile.read(previousBytes, 0, previousBytes.length, 0);
    expect(previousBytes).toEqual(originalBytes);
    await originalFile.close();
    await state.keys.set({ "pre-key": { "1": null } });
    expect(await state.keys.get("pre-key", ["1"])).toEqual({});
  });

  test.skipIf(!POSIX)(
    "creates fresh credentials and Signal keys privately",
    async () => {
      const authDirectory = await createAuthDirectory();
      const { saveCreds, state } =
        await usePrivateMultiFileAuthState(authDirectory);

      await saveCreds();
      await state.keys.set({ "pre-key": { "1": PRE_KEY } });

      expect(process.umask()).toBe(0o077);
      await expectPrivate(authDirectory, [
        join(authDirectory, "creds.json"),
        join(authDirectory, "pre-key-1.json"),
      ]);
    }
  );

  test.skipIf(!POSIX)(
    "preserves a stricter existing process umask",
    async () => {
      const authDirectory = await createAuthDirectory();
      process.umask(0o177);

      const { saveCreds } = await usePrivateMultiFileAuthState(authDirectory);
      await saveCreds();

      expect(process.umask()).toBe(0o177);
      await expectPrivate(authDirectory, [join(authDirectory, "creds.json")]);
    }
  );

  test.skipIf(!POSIX)(
    "repairs existing loose permissions during startup",
    async () => {
      const authDirectory = await createAuthDirectory();
      const existingFile = join(authDirectory, "existing.json");
      await mkdir(authDirectory, { mode: 0o755 });
      await writeFile(existingFile, "{}", { mode: 0o644 });
      await chmod(authDirectory, 0o755);
      await chmod(existingFile, 0o644);

      await usePrivateMultiFileAuthState(authDirectory);

      await expectPrivate(authDirectory, [existingFile]);
    }
  );

  test.skipIf(!POSIX)(
    "keeps credentials private across resave and reconnect",
    async () => {
      const authDirectory = await createAuthDirectory();
      const credentialsPath = join(authDirectory, "creds.json");
      const keyPath = join(authDirectory, "pre-key-1.json");
      const files = [credentialsPath, keyPath];
      const { saveCreds, state } =
        await usePrivateMultiFileAuthState(authDirectory);
      await saveCreds();
      await state.keys.set({ "pre-key": { "1": PRE_KEY } });

      await saveCreds();
      await state.keys.set({ "pre-key": { "1": PRE_KEY } });
      await expectPrivate(authDirectory, files);

      const reconnected = await usePrivateMultiFileAuthState(authDirectory);
      await reconnected.saveCreds();
      await reconnected.state.keys.set({ "pre-key": { "1": PRE_KEY } });
      await expectPrivate(authDirectory, files);
    }
  );
});
