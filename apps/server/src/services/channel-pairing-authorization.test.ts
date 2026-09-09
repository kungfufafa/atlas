import { expect, spyOn, test } from "bun:test";
import path from "node:path";
import { PrincipalRequiredError } from "@atlas/core";
import { writePrivateTextFile } from "@atlas/core/fs";
import { withIsolatedAtlasHome } from "@atlas/core/testing/atlas-home";
import { getWhatsAppLidMapPath } from "@atlas/core/whatsapp-config";
import { getWorkspaceChannelDir } from "@atlas/core/workspace-channel-paths";
import { assertChannelPairingAllowed } from "./channel-pairing-authorization";

const channels = [
  { block: "blocked_user_ids=42", channel: "telegram", sender: "42" },
  {
    block: "blocked_user_ids=424242424242424242",
    channel: "discord",
    sender: "424242424242424242",
  },
  {
    block: "blocked_numbers=628111111111",
    channel: "whatsapp",
    sender: "628111111111@s.whatsapp.net",
  },
] as const;

for (const entry of channels) {
  for (const accessMode of ["pairing", "allowlist", "denylist", "open"]) {
    test(`${entry.channel} pairing assertion admission respects ${accessMode}`, async () => {
      await withIsolatedAtlasHome("atlas-pairing-policy-", async () => {
        const dir = getWorkspaceChannelDir(entry.channel, "org_a");
        await writePrivateTextFile(
          path.join(dir, "config.ini"),
          `bot_token=token\nphone_number=628999999999\naccess_mode=${accessMode}\n${entry.block}\n`,
          { ensureDir: dir }
        );
        const pending = assertChannelPairingAllowed({
          channel: entry.channel,
          channelUserId: entry.sender,
          orgId: "org_a",
        });
        if (accessMode === "denylist") {
          await expect(pending).rejects.toBeInstanceOf(PrincipalRequiredError);
        } else {
          await expect(pending).resolves.toBeUndefined();
        }
      });
    });
  }
  test(`${entry.channel} pairing never falls back to another tenant config`, async () => {
    await withIsolatedAtlasHome("atlas-pairing-policy-", async () => {
      const dir = getWorkspaceChannelDir(entry.channel, "org_b");
      await writePrivateTextFile(
        path.join(dir, "config.ini"),
        "bot_token=token\nphone_number=628999999999\naccess_mode=open\n",
        { ensureDir: dir }
      );
      await expect(
        assertChannelPairingAllowed({
          channel: entry.channel,
          channelUserId: entry.sender,
          orgId: "org_a",
        })
      ).rejects.toBeInstanceOf(PrincipalRequiredError);
    });
  });
}

test("WhatsApp pairing resolves the tenant's trusted LID map before checking its blocked phone", async () => {
  await withIsolatedAtlasHome("atlas-pairing-lid-", async () => {
    const dir = getWorkspaceChannelDir("whatsapp", "org_a");
    await writePrivateTextFile(
      path.join(dir, "config.ini"),
      "phone_number=628999999999\naccess_mode=denylist\nblocked_numbers=628111111111\n",
      { ensureDir: dir }
    );
    await writePrivateTextFile(
      getWhatsAppLidMapPath("org_a"),
      JSON.stringify({ "123456@lid": "628111111111@s.whatsapp.net" }),
      { ensureDir: dir }
    );
    await expect(
      assertChannelPairingAllowed({
        channel: "whatsapp",
        channelUserId: "123456@lid",
        orgId: "org_a",
      })
    ).rejects.toBeInstanceOf(PrincipalRequiredError);
  });
});

for (const input of [
  { channel: "telegram", channelUserId: "-1" },
  { channel: "telegram", channelUserId: "abc" },
  { channel: "telegram", channelUserId: "9007199254740993" },
  { channel: "discord", channelUserId: "not-a-snowflake" },
  { channel: "whatsapp", channelUserId: "120363000@g.us" },
] as const) {
  test(`pairing rejects malformed ${input.channel} identity ${input.channelUserId}`, async () => {
    await withIsolatedAtlasHome("atlas-pairing-source-", async () => {
      const dir = getWorkspaceChannelDir(input.channel, "org_a");
      await writePrivateTextFile(
        path.join(dir, "config.ini"),
        "bot_token=token\nphone_number=628999999999\naccess_mode=open\n",
        { ensureDir: dir }
      );
      await expect(
        assertChannelPairingAllowed({ ...input, orgId: "org_a" })
      ).rejects.toBeInstanceOf(PrincipalRequiredError);
    });
  });
}

for (const changeMap of [false, true]) {
  test(`WhatsApp pairing ${changeMap ? "rejects changed" : "accepts stable"} LID phone between normalization and policy lookup`, async () => {
    await withIsolatedAtlasHome("atlas-pairing-lid-race-", async () => {
      const dir = getWorkspaceChannelDir("whatsapp", "org_a");
      const phoneA = "628111111111@s.whatsapp.net";
      const phoneB = "628222222222@s.whatsapp.net";
      await writePrivateTextFile(
        path.join(dir, "config.ini"),
        `phone_number=628999999999\naccess_mode=denylist\nblocked_numbers=${changeMap ? "628111111111" : "628222222222"}\n`,
        { ensureDir: dir }
      );
      await writePrivateTextFile(
        getWhatsAppLidMapPath("org_a"),
        JSON.stringify({ "123456@lid": phoneA }),
        { ensureDir: dir }
      );
      const identities = await import("./channel-guest-principal-service");
      const normalize = identities.normalizeExternalActor;
      let observedSnapshot = false;
      const normalizeSpy = spyOn(
        identities,
        "normalizeExternalActor"
      ).mockImplementation(async (input) => {
        const snapshot = await normalize(input);
        if (!observedSnapshot) {
          observedSnapshot = true;
          if (changeMap) {
            await writePrivateTextFile(
              getWhatsAppLidMapPath("org_a"),
              JSON.stringify({ "123456@lid": phoneB }),
              { ensureDir: dir }
            );
          }
        }
        return snapshot;
      });
      try {
        const result = assertChannelPairingAllowed({
          channel: "whatsapp",
          channelUserId: "123456@lid",
          orgId: "org_a",
        });
        if (changeMap) {
          await expect(result).rejects.toBeInstanceOf(PrincipalRequiredError);
        } else {
          await expect(result).resolves.toBeUndefined();
        }
        expect(observedSnapshot).toBe(true);
      } finally {
        normalizeSpy.mockRestore();
      }
    });
  });
}
