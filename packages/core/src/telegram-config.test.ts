import { describe, expect, test } from "bun:test";
import {
  generateHandshakeCode,
  isTelegramUserAuthorized,
  loadTelegramConfigFile,
  maskBotToken,
  normalizeHandshakeInput,
  parseAllowedUserIds,
  resolveTelegramConfigFromSources,
  saveTelegramConfig,
  verifyAndPairTelegramUser,
} from "./telegram-config";
import {
  describeSharedChannelConfigTests,
  withTempHomedir,
  writeChannelIniConfig,
} from "./testing/channel-config-fixtures";

describe("parseAllowedUserIds", () => {
  test("parses comma-separated ids", () => {
    expect(parseAllowedUserIds("123, 456")).toEqual([123, 456]);
  });

  test("rejects invalid ids", () => {
    expect(() => parseAllowedUserIds("abc")).toThrow(
      "Invalid Telegram user ID"
    );
    expect(() => parseAllowedUserIds("0")).toThrow("Invalid Telegram user ID");
    expect(() => parseAllowedUserIds("-5")).toThrow("Invalid Telegram user ID");
  });
});

describe("resolveTelegramConfigFromSources", () => {
  test("ignores env credentials when workspace-scoped", () => {
    const resolved = resolveTelegramConfigFromSources({
      allowEnvCredentials: false,
      env: {
        TELEGRAM_ALLOWED_USER_IDS: "42",
        TELEGRAM_BOT_TOKEN: "env-token",
      },
      file: {
        accessMode: "pairing",
        allowedUserIds: [99],
        blockedUserIds: [],
        botToken: "file-token",
        handshakeCode: null,
        handshakeUserId: null,
        pairedUserIds: [1],
        profileId: "profile_from_file",
      },
    });

    expect(resolved).toMatchObject({
      allowedUserIds: [99],
      botToken: "file-token",
      profileId: "profile_from_file",
    });
  });
});

describeSharedChannelConfigTests({
  allowlistInput: "42, 43",
  allowlistParsed: [42, 43],
  authorize: {
    allowlisted: 2,
    paired: 1,
    unauthorized: 3,
  },
  botToken: "1234567890:TEST",
  env: {
    allowlistKey: "TELEGRAM_ALLOWED_USER_IDS",
    allowlistParsed: [42, 43],
    allowlistValue: "42, 43",
    botTokenKey: "TELEGRAM_BOT_TOKEN",
  },
  generateHandshakeCode,
  isUserAuthorized: isTelegramUserAuthorized,
  label: "Telegram",
  loadConfigFile: loadTelegramConfigFile,
  mask: maskBotToken,
  name: "telegram",
  normalize: normalizeHandshakeInput,
  resolveConfigFromSources: resolveTelegramConfigFromSources,
  resolveFile: {
    allowedUserIds: [99],
    pairedUserIds: [1],
  },
  sampleId: 9001,
  saveConfig: saveTelegramConfig,
  verifyAndPair: verifyAndPairTelegramUser,
});

describe("verifyAndPairTelegramUser concurrency", () => {
  test("serializes concurrent pairing so only one user consumes the code", async () => {
    await withTempHomedir("atlas-tg-pair-race-", async (homeDir) => {
      await writeChannelIniConfig(homeDir, "telegram", {
        botToken: "1234567890:TEST",
        handshakeCode: "AABBCCDD",
      });

      const [first, second] = await Promise.all([
        verifyAndPairTelegramUser("AABBCCDD", 111),
        verifyAndPairTelegramUser("AABBCCDD", 222),
      ]);

      expect([first.ok, second.ok].sort()).toEqual([false, true]);
      const saved = await loadTelegramConfigFile();
      expect(saved?.handshakeCode).toBeNull();
      expect(saved?.pairedUserIds).toHaveLength(1);
      expect([111, 222]).toContain(saved?.pairedUserIds[0]);
    });
  });

  test("binds before atomically consuming the pairing state", async () => {
    await withTempHomedir("atlas-tg-pair-assert-", async (homeDir) => {
      await writeChannelIniConfig(homeDir, "telegram", {
        botToken: "1234567890:TEST",
        handshakeAssertion: "assert_keep",
        handshakeCode: "AABBCCDD",
        handshakeUserId: "user_admin",
      });

      const bindings: unknown[] = [];
      const result = await verifyAndPairTelegramUser(
        "AABBCCDD",
        111,
        undefined,
        async (input) => {
          bindings.push(input);
        }
      );
      expect(result.ok).toBe(true);
      expect(bindings).toEqual([
        {
          channelUserId: "111",
          pairingAssertion: "assert_keep",
          pairingUserId: "user_admin",
        },
      ]);
      const saved = await loadTelegramConfigFile();
      expect(saved?.handshakeCode).toBeNull();
      expect(saved?.handshakeAssertion).toBeNull();
      expect(saved?.handshakeUserId).toBeNull();
      expect(saved?.pairedUserIds).toEqual([111]);
    });
  });

  test("clears pairing fields when switching away from pairing mode", async () => {
    await withTempHomedir("atlas-tg-open-mode-clear-", async (homeDir) => {
      await writeChannelIniConfig(homeDir, "telegram", {
        botToken: "1234567890:TEST",
        handshakeAssertion: "assert_keep",
        handshakeCode: "AABBCCDD",
      });

      await saveTelegramConfig({
        accessMode: "open",
        botToken: "1234567890:TEST",
      });

      const saved = await loadTelegramConfigFile();
      expect(saved?.accessMode).toBe("open");
      expect(saved?.handshakeCode).toBeNull();
      expect(saved?.handshakeAssertion).toBeNull();
      expect(saved?.handshakeUserId).toBeNull();
    });
  });

  test("keeps pairing fields while remaining in pairing mode", async () => {
    await withTempHomedir("atlas-tg-pair-mode-keep-", async (homeDir) => {
      await writeChannelIniConfig(homeDir, "telegram", {
        botToken: "1234567890:TEST",
        handshakeAssertion: "assert_keep",
        handshakeCode: "AABBCCDD",
      });

      await saveTelegramConfig({
        accessMode: "pairing",
        botToken: "1234567890:TEST",
      });

      const saved = await loadTelegramConfigFile();
      expect(saved?.accessMode).toBe("pairing");
      expect(saved?.handshakeCode).toBe("AABBCCDD");
      expect(saved?.handshakeAssertion).toBe("assert_keep");
      expect(saved?.handshakeUserId).toBeNull();
    });
  });

  test("keeps pairing state retryable when canonical bind fails", async () => {
    await withTempHomedir("atlas-tg-pair-bind-fail-", async (homeDir) => {
      await writeChannelIniConfig(homeDir, "telegram", {
        botToken: "1234567890:TEST",
        handshakeAssertion: "assert_retry",
        handshakeCode: "AABBCCDD",
        handshakeUserId: "user_admin",
      });

      await expect(
        verifyAndPairTelegramUser("AABBCCDD", 111, undefined, async () => {
          throw new Error("network down");
        })
      ).rejects.toThrow("network down");

      const saved = await loadTelegramConfigFile();
      expect(saved?.handshakeCode).toBe("AABBCCDD");
      expect(saved?.handshakeAssertion).toBe("assert_retry");
      expect(saved?.handshakeUserId).toBe("user_admin");
      expect(saved?.pairedUserIds).toEqual([]);
    });
  });

  test("rebinds an already authorized sender only with the exact fresh code", async () => {
    await withTempHomedir("atlas-tg-pair-rebind-", async (homeDir) => {
      await writeChannelIniConfig(homeDir, "telegram", {
        botToken: "1234567890:TEST",
        handshakeAssertion: "assert_rebind",
        handshakeCode: "AABBCCDD",
        handshakeUserId: "user_new",
        pairedUserIds: [111],
      });

      const bindings: unknown[] = [];
      const wrongCode = await verifyAndPairTelegramUser(
        "DEADBEEF",
        111,
        undefined,
        async (input) => {
          bindings.push(input);
        }
      );
      expect(wrongCode.ok).toBe(true);
      expect(bindings).toEqual([]);
      expect((await loadTelegramConfigFile())?.handshakeCode).toBe("AABBCCDD");

      const result = await verifyAndPairTelegramUser(
        "AABBCCDD",
        111,
        undefined,
        async (input) => {
          bindings.push(input);
        }
      );
      expect(result.ok).toBe(true);
      expect(bindings).toEqual([
        {
          channelUserId: "111",
          pairingAssertion: "assert_rebind",
          pairingUserId: "user_new",
        },
      ]);
      expect((await loadTelegramConfigFile())?.handshakeCode).toBeNull();
    });
  });
});
