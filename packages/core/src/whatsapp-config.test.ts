import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { withTempHomedir } from "./testing/channel-config-fixtures";
import {
  generatePairingCode,
  isWhatsAppUserAuthorized,
  loadWhatsAppConfigFile,
  loadWhatsAppLidMap,
  lookupWhatsAppLidPhone,
  maskPhoneNumber,
  normalizePairingCode,
  normalizePhoneNumberDigits,
  normalizeWhatsAppUserJid,
  regenerateWhatsAppPairingCode,
  rememberWhatsAppLidPhone,
  resetWhatsAppSessionForReconnect,
  resolveWhatsAppAuthIdentity,
  resolveWhatsAppConfigFromSources,
  resolveWhatsAppOutboundDestination,
  saveWhatsAppConfig,
  syncWhatsAppOwnerPairing,
  toWhatsAppSettingsPublic,
  verifyAndPairWhatsAppUser,
  whatsAppUserDigits,
} from "./whatsapp-config";

describe("maskPhoneNumber", () => {
  test("masks long phone numbers with plus prefix", () => {
    expect(maskPhoneNumber("+1234567890")).toBe(
      "+\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u202290"
    );
  });

  test("returns null for empty", () => {
    expect(maskPhoneNumber("")).toBeNull();
  });

  test("masks short numbers", () => {
    expect(maskPhoneNumber("1234")).toBe("+••••");
  });
});

describe("normalizeWhatsAppUserJid", () => {
  test("strips device suffixes from phone and LID JIDs", () => {
    expect(normalizeWhatsAppUserJid("6281379292556:12@s.whatsapp.net")).toBe(
      "6281379292556@s.whatsapp.net"
    );
    expect(normalizeWhatsAppUserJid("236283431522503:0@lid")).toBe(
      "236283431522503@lid"
    );
  });
});

describe("normalizePairingCode", () => {
  test("strips spaces and uppercases", () => {
    expect(normalizePairingCode(" a b cd12 ")).toBe("ABCD12");
  });
});

describe("isWhatsAppUserAuthorized", () => {
  test("returns true when JID matches pairedLid", () => {
    expect(
      isWhatsAppUserAuthorized("236283431522503@lid", {
        pairedJid: "6281379292556@s.whatsapp.net",
        pairedLid: "236283431522503@lid",
      })
    ).toBe(true);
  });

  test("returns true when JID matches pairedJid", () => {
    expect(
      isWhatsAppUserAuthorized("1234567890@s.whatsapp.net", {
        pairedJid: "1234567890@s.whatsapp.net",
        pairedLid: null,
      })
    ).toBe(true);
  });

  test("returns true when inbound JID includes a device suffix", () => {
    expect(
      isWhatsAppUserAuthorized("6281379292556:12@s.whatsapp.net", {
        pairedJid: "6281379292556@s.whatsapp.net",
        pairedLid: null,
      })
    ).toBe(true);
  });

  test("returns true when pairedJid includes a device suffix", () => {
    expect(
      isWhatsAppUserAuthorized("6281379292556@s.whatsapp.net", {
        pairedJid: "6281379292556:12@s.whatsapp.net",
        pairedLid: null,
      })
    ).toBe(true);
  });

  test("returns true when inbound LID JID matches pairedLid with device suffix", () => {
    expect(
      isWhatsAppUserAuthorized("154352568283178@lid", {
        pairedJid: "6282240221108@s.whatsapp.net",
        pairedLid: "154352568283178:0@lid",
      })
    ).toBe(true);
  });

  test("returns true when pairedJid is null but pairedLid matches", () => {
    expect(
      isWhatsAppUserAuthorized("154352568283178@lid", {
        pairedJid: null,
        pairedLid: "154352568283178@lid",
      })
    ).toBe(true);
  });

  test("returns false when JID does not match pairedJid", () => {
    expect(
      isWhatsAppUserAuthorized("9999999999@s.whatsapp.net", {
        pairedJid: "1234567890@s.whatsapp.net",
        pairedLid: null,
      })
    ).toBe(false);
  });

  test("returns false when pairedJid is null", () => {
    expect(
      isWhatsAppUserAuthorized("1234567890@s.whatsapp.net", {
        pairedJid: null,
        pairedLid: null,
      })
    ).toBe(false);
  });
});

describe("generatePairingCode", () => {
  test("returns 8 uppercase hex chars", () => {
    expect(generatePairingCode()).toMatch(/^[0-9A-F]{8}$/);
  });
});

describe("saveWhatsAppConfig", () => {
  test("creates config without auto-generating a pairing code", async () => {
    await withTempHomedir("atlas-core-wa-home-", async () => {
      const result = await saveWhatsAppConfig({ profileId: "profile_custom" });

      expect(result.pairingCode).toBeNull();
      expect(result.configured).toBe(true);
      expect(result.phoneNumberMasked).toBeNull();
      expect(result.pairedJid).toBeNull();

      const saved = await loadWhatsAppConfigFile();
      expect(saved?.phoneNumber).toBe("");
      expect(saved?.profileId).toBe("profile_custom");
      expect(saved?.pairingCode).toBeNull();
    });
  });

  test("saves profile without requiring a phone number", async () => {
    await withTempHomedir("atlas-core-wa-home-", async () => {
      const result = await saveWhatsAppConfig({
        profileId: "profile_custom",
      });

      expect(result.profileId).toBe("profile_custom");

      const saved = await loadWhatsAppConfigFile();
      expect(saved?.profileId).toBe("profile_custom");
    });
  });

  test("preserves pairedJid when updating other fields", async () => {
    await withTempHomedir("atlas-core-wa-home-", async (tempHome) => {
      await saveWhatsAppConfig({ phoneNumber: "+1234567890" });
      const first = await loadWhatsAppConfigFile();

      const configWithJid: Record<string, string> = {
        paired_jid: "1234567890@s.whatsapp.net",
        pairing_code: first!.pairingCode!,
        phone_number: first!.phoneNumber,
        profile_id: first!.profileId,
      };
      const dir = path.join(tempHome, ".atlas", "whatsapp");
      const lines = [
        "# Atlas WhatsApp bridge",
        ...Object.entries(configWithJid).map(([k, v]) => `${k}=${v}`),
        "",
      ];
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "config.ini"), lines.join("\n"), "utf8");

      const result = await saveWhatsAppConfig({
        profileId: "profile_updated",
      });

      expect(result.pairedJid).toBe("1234567890@s.whatsapp.net");
      expect(result.profileId).toBe("profile_updated");
    });
  });

  test("allows first save with profile only", async () => {
    await withTempHomedir("atlas-core-wa-home-", async () => {
      const result = await saveWhatsAppConfig({ profileId: "default" });
      expect(result.configured).toBe(true);
    });
  });

  test("preserves a pending chat access code when saving other settings", async () => {
    await withTempHomedir("atlas-core-wa-save-code-", async (tempHome) => {
      const dir = path.join(tempHome, ".atlas", "whatsapp");
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "config.ini"),
        [
          "# Atlas WhatsApp bridge",
          "profile_id=default",
          "access_mode=pairing",
          "phone_number=6281379292556",
          "paired_jid=6281379292556@s.whatsapp.net",
          "pairing_code=ABCD1234",
          "",
        ].join("\n"),
        "utf8"
      );

      const result = await saveWhatsAppConfig({ profileId: "profile_updated" });
      expect(result.pairingCode).toBe("ABCD1234");
      expect(result.pairedJid).toBe("6281379292556@s.whatsapp.net");
    });
  });
});

describe("resetWhatsAppSessionForReconnect", () => {
  test("clears auth dir, pairing fields, and QR while preserving phone and profile", async () => {
    await withTempHomedir("atlas-core-wa-reset-", async (tempHome) => {
      await saveWhatsAppConfig({
        phoneNumber: "+1234567890",
        profileId: "profile_custom",
      });
      const dir = path.join(tempHome, ".atlas", "whatsapp");
      const authDir = path.join(dir, "auth");
      await mkdir(authDir, { recursive: true });
      await writeFile(path.join(authDir, "creds.json"), "{}", "utf8");
      await writeFile(path.join(dir, "worker-qr.txt"), "qr-string", "utf8");

      const first = await loadWhatsAppConfigFile();
      const configWithJid: Record<string, string> = {
        paired_jid: "1234567890@s.whatsapp.net",
        paired_lid: "999@lid",
        phone_number: first!.phoneNumber,
        profile_id: first!.profileId,
      };
      await writeFile(
        path.join(dir, "config.ini"),
        [
          "# Atlas WhatsApp bridge",
          ...Object.entries(configWithJid).map(([k, v]) => `${k}=${v}`),
          "",
        ].join("\n"),
        "utf8"
      );

      const result = await resetWhatsAppSessionForReconnect();

      expect(result.configured).toBe(true);
      expect(result.profileId).toBe("profile_custom");
      expect(result.phoneNumberMasked).toBe(
        "+\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u202290"
      );
      expect(result.pairedJid).toBeNull();
      expect(result.pairingCode).toBeNull();

      const saved = await loadWhatsAppConfigFile();
      expect(saved?.pairedJid).toBeNull();
      expect(saved?.pairedLid).toBeNull();
      expect(saved?.pairingCode).toBeNull();
      expect(saved?.phoneNumber).toBe("+1234567890");

      await expect(
        Bun.file(path.join(authDir, "creds.json")).exists()
      ).resolves.toBe(false);
      await expect(
        Bun.file(path.join(dir, "worker-qr.txt")).exists()
      ).resolves.toBe(false);
    });
  });

  test("throws when WhatsApp is not configured", async () => {
    await withTempHomedir("atlas-core-wa-reset-", async () => {
      expect(resetWhatsAppSessionForReconnect()).rejects.toThrow(
        "Enable WhatsApp in Integrations before reconnecting."
      );
    });
  });

  test("succeeds when auth dir and QR file are already absent", async () => {
    await withTempHomedir("atlas-core-wa-reset-", async () => {
      await saveWhatsAppConfig({ phoneNumber: "+1234567890" });

      const result = await resetWhatsAppSessionForReconnect();
      expect(result.pairedJid).toBeNull();

      const again = await resetWhatsAppSessionForReconnect();
      expect(again.pairedJid).toBeNull();
    });
  });
});

describe("resolveWhatsAppConfigFromSources", () => {
  test("returns null when no config file is available", () => {
    expect(
      resolveWhatsAppConfigFromSources({
        env: {},
        file: null,
      })
    ).toBeNull();
  });

  test("prefers env phone number over file config", () => {
    const resolved = resolveWhatsAppConfigFromSources({
      env: {
        WHATSAPP_PHONE_NUMBER: "+1234567890",
      },
      file: {
        pairedJid: null,
        pairedLid: null,
        pairingCode: null,
        phoneNumber: "+9876543210",
        profileId: "profile_from_file",
      },
    });

    expect(resolved).toEqual({
      accessMode: "pairing",
      allowedNumbers: [],
      blockedNumbers: [],
      pairedJid: null,
      pairedLid: null,
      pairingAssertion: null,
      pairingCode: null,
      pairingUserId: null,
      phoneNumber: "+1234567890",
      profileId: "profile_from_file",
    });
  });

  test("uses file config when env is absent", () => {
    const resolved = resolveWhatsAppConfigFromSources({
      env: {},
      file: {
        pairedJid: "9876543210@s.whatsapp.net",
        pairedLid: null,
        pairingCode: "ABCD1234",
        phoneNumber: "",
        profileId: "profile_from_file",
      },
    });

    expect(resolved?.phoneNumber).toBe("");
    expect(resolved?.pairedJid).toBe("9876543210@s.whatsapp.net");
  });
});

describe("syncWhatsAppOwnerPairing", () => {
  test("auto-pairs owner when WhatsApp JID includes a device suffix", async () => {
    await withTempHomedir("atlas-core-wa-sync-", async () => {
      await saveWhatsAppConfig({ profileId: "default" });

      await syncWhatsAppOwnerPairing({
        ownerJid: "6281379292556:12@s.whatsapp.net",
        ownerLid: "236283431522503@lid",
      });

      const saved = await loadWhatsAppConfigFile();
      expect(saved?.phoneNumber).toBe("6281379292556");
      expect(saved?.pairedJid).toBe("6281379292556:12@s.whatsapp.net");
      expect(saved?.pairedLid).toBe("236283431522503@lid");
      expect(saved?.pairingCode).toBeNull();
    });
  });

  test("overwrites a stale phone number after QR link", async () => {
    await withTempHomedir("atlas-core-wa-sync-", async () => {
      await saveWhatsAppConfig({ phoneNumber: "+6281227900622" });

      await syncWhatsAppOwnerPairing({
        ownerJid: "6281379292556:17@s.whatsapp.net",
        ownerLid: "128415361462410:17@lid",
      });

      const saved = await loadWhatsAppConfigFile();
      expect(saved?.phoneNumber).toBe("6281379292556");
      expect(saved?.pairedJid).toBe("6281379292556:17@s.whatsapp.net");
    });
  });

  test("preserves a pending chat access code when owner pairing sync completes", async () => {
    await withTempHomedir("atlas-core-wa-sync-", async (tempHome) => {
      await saveWhatsAppConfig({ phoneNumber: "+6281379292556" });

      const dir = path.join(tempHome, ".atlas", "whatsapp");
      await writeFile(
        path.join(dir, "config.ini"),
        [
          "# Atlas WhatsApp bridge",
          "phone_number=+6281379292556",
          "profile_id=default",
          "pairing_code=ABCD1234",
          "paired_jid=6281379292556@s.whatsapp.net",
          "",
        ].join("\n"),
        "utf8"
      );

      await syncWhatsAppOwnerPairing({
        ownerJid: "6281379292556:12@s.whatsapp.net",
        ownerLid: "236283431522503@lid",
      });

      const saved = await loadWhatsAppConfigFile();
      expect(saved?.pairedJid).toBe("6281379292556@s.whatsapp.net");
      expect(saved?.pairedLid).toBe("236283431522503@lid");
      expect(saved?.pairingCode).toBe("ABCD1234");
    });
  });

  test("preserves an existing paired LID during owner sync", async () => {
    await withTempHomedir("atlas-core-wa-sync-", async (tempHome) => {
      const dir = path.join(tempHome, ".atlas", "whatsapp");
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "config.ini"),
        [
          "# Atlas WhatsApp bridge",
          "phone_number=6281379292556",
          "profile_id=default",
          "paired_jid=6281379292556@s.whatsapp.net",
          "paired_lid=104784384290844@lid",
          "",
        ].join("\n"),
        "utf8"
      );

      await syncWhatsAppOwnerPairing({
        ownerJid: "6281379292556:18@s.whatsapp.net",
        ownerLid: "128415361462410:18@lid",
      });

      const saved = await loadWhatsAppConfigFile();
      expect(saved?.pairedJid).toBe("6281379292556@s.whatsapp.net");
      expect(saved?.pairedLid).toBe("104784384290844@lid");
    });
  });
});

describe("WhatsApp access mode settings", () => {
  test("defaults accessMode to pairing for legacy configs without access_mode", async () => {
    await withTempHomedir("atlas-core-wa-legacy-", async (tempHome) => {
      const dir = path.join(tempHome, ".atlas", "whatsapp");
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "config.ini"),
        [
          "# Atlas WhatsApp bridge legacy",
          "phone_number=6281379292556",
          "profile_id=default",
          "paired_jid=6281379292556@s.whatsapp.net",
          "",
        ].join("\n"),
        "utf8"
      );

      const saved = await loadWhatsAppConfigFile();
      expect(saved?.accessMode).toBe("pairing");
      expect(saved?.allowedNumbers).toEqual([]);
      expect(saved?.blockedNumbers).toEqual([]);
    });
  });

  test("saves and loads open, allowlist, and denylist modes", async () => {
    await withTempHomedir("atlas-core-wa-modes-", async (tempHome) => {
      await saveWhatsAppConfig({
        accessMode: "open",
        allowedNumbers: ["+62 812-3456-7890", "0811223344"],
        blockedNumbers: ["6289999999"],
        phoneNumber: "+62 812-3456-7890",
      });

      const saved = await loadWhatsAppConfigFile();
      expect(saved?.accessMode).toBe("open");
      expect(saved?.allowedNumbers).toEqual(["6281234567890", "62811223344"]);
      expect(saved?.blockedNumbers).toEqual(["6289999999"]);
    });
  });

  test("clears a chat access code when switching away from pairing mode", async () => {
    await withTempHomedir(
      "atlas-core-wa-open-clears-code-",
      async (tempHome) => {
        const dir = path.join(tempHome, ".atlas", "whatsapp");
        await mkdir(dir, { recursive: true });
        await writeFile(
          path.join(dir, "config.ini"),
          [
            "# Atlas WhatsApp bridge",
            "profile_id=default",
            "access_mode=pairing",
            "phone_number=6281379292556",
            "pairing_code=ABCD1234",
            "",
          ].join("\n"),
          "utf8"
        );

        const result = await saveWhatsAppConfig({ accessMode: "open" });
        expect(result.accessMode).toBe("open");
        expect(result.pairingCode).toBeNull();

        const saved = await loadWhatsAppConfigFile();
        expect(saved?.accessMode).toBe("open");
        expect(saved?.pairingCode).toBeNull();
      }
    );
  });

  test("hides a leftover chat access code in public settings for open mode", async () => {
    await withTempHomedir("atlas-core-wa-open-hide-code-", async (tempHome) => {
      const dir = path.join(tempHome, ".atlas", "whatsapp");
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "config.ini"),
        [
          "# Atlas WhatsApp bridge",
          "profile_id=default",
          "access_mode=open",
          "phone_number=6281379292556",
          "pairing_code=ABCD1234",
          "",
        ].join("\n"),
        "utf8"
      );

      const saved = await loadWhatsAppConfigFile();
      expect(saved?.pairingCode).toBe("ABCD1234");
      expect(toWhatsAppSettingsPublic(saved).pairingCode).toBeNull();
    });
  });

  test("does not generate a chat access code in open mode", async () => {
    await withTempHomedir("atlas-core-wa-open-regen-", async () => {
      await saveWhatsAppConfig({
        accessMode: "open",
        phoneNumber: "+6281379292556",
      });

      await expect(regenerateWhatsAppPairingCode()).rejects.toThrow();
      const saved = await loadWhatsAppConfigFile();
      expect(saved?.pairingCode).toBeNull();
    });
  });
});

describe("verifyAndPairWhatsAppUser", () => {
  test("LID pair with an existing owner phone binds only the inbound LID", async () => {
    await withTempHomedir("atlas-core-wa-pair-lid-", async (tempHome) => {
      const dir = path.join(tempHome, ".atlas", "whatsapp");
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "config.ini"),
        [
          "# Atlas WhatsApp bridge",
          "profile_id=default",
          "access_mode=pairing",
          "phone_number=628111111111",
          "paired_jid=628111111111@s.whatsapp.net",
          "pairing_code=ABCD1234",
          "",
        ].join("\n"),
        "utf8"
      );

      const guest = await verifyAndPairWhatsAppUser(
        "ABCD1234",
        "154352568283178@lid"
      );
      expect(guest.ok).toBe(true);

      const saved = await loadWhatsAppConfigFile();
      expect(saved?.pairedLid).toBe("154352568283178@lid");
      expect(saved?.pairedJid).toBeNull();
      expect(saved?.pairingCode).toBeNull();
      expect(
        isWhatsAppUserAuthorized("628111111111@s.whatsapp.net", saved!)
      ).toBe(false);
      expect(isWhatsAppUserAuthorized("154352568283178@lid", saved!)).toBe(
        true
      );
    });
  });

  test("phone pair with an existing owner LID binds only the inbound phone", async () => {
    await withTempHomedir("atlas-core-wa-pair-phone-", async (tempHome) => {
      const dir = path.join(tempHome, ".atlas", "whatsapp");
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "config.ini"),
        [
          "# Atlas WhatsApp bridge",
          "profile_id=default",
          "access_mode=pairing",
          "phone_number=628111111111",
          "paired_lid=154352568283178@lid",
          "pairing_code=ABCD1234",
          "",
        ].join("\n"),
        "utf8"
      );

      const guest = await verifyAndPairWhatsAppUser(
        "ABCD1234",
        "628999999999@s.whatsapp.net"
      );
      expect(guest.ok).toBe(true);

      const saved = await loadWhatsAppConfigFile();
      expect(saved?.pairedJid).toBe("628999999999@s.whatsapp.net");
      expect(saved?.pairedLid).toBeNull();
      expect(saved?.pairingCode).toBeNull();
      expect(isWhatsAppUserAuthorized("154352568283178@lid", saved!)).toBe(
        false
      );
      expect(
        isWhatsAppUserAuthorized("628999999999@s.whatsapp.net", saved!)
      ).toBe(true);
    });
  });

  test("serializes concurrent pairing so only one JID consumes the code", async () => {
    await withTempHomedir("atlas-core-wa-pair-race-", async (tempHome) => {
      const dir = path.join(tempHome, ".atlas", "whatsapp");
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "config.ini"),
        [
          "# Atlas WhatsApp bridge",
          "profile_id=default",
          "access_mode=pairing",
          "pairing_code=AABBCCDD",
          "",
        ].join("\n"),
        "utf8"
      );

      const [first, second] = await Promise.all([
        verifyAndPairWhatsAppUser("AABBCCDD", "628111111111@s.whatsapp.net"),
        verifyAndPairWhatsAppUser("AABBCCDD", "628222222222@s.whatsapp.net"),
      ]);

      expect([first.ok, second.ok].sort()).toEqual([false, true]);
      const saved = await loadWhatsAppConfigFile();
      expect(saved?.pairingCode).toBeNull();
      const authorized = [
        isWhatsAppUserAuthorized("628111111111@s.whatsapp.net", saved!),
        isWhatsAppUserAuthorized("628222222222@s.whatsapp.net", saved!),
      ].filter(Boolean);
      expect(authorized).toHaveLength(1);
    });
  });
});

describe("resolveWhatsAppOutboundDestination", () => {
  const base = {
    accessMode: "pairing" as const,
    allowedNumbers: [] as string[],
    blockedNumbers: [] as string[],
    pairedJid: "6281111111111@s.whatsapp.net",
    pairedLid: null,
    pairingCode: null,
    phoneNumber: "6281111111111",
    profileId: "default",
  };

  test("uses the workspace paired number as sender and the given phone as destination", () => {
    expect(resolveWhatsAppOutboundDestination(base, "6289500000001")).toEqual({
      jid: "6289500000001@s.whatsapp.net",
    });
  });

  test("normalizes local 08 numbers", () => {
    expect(resolveWhatsAppOutboundDestination(base, "089500000001")).toEqual({
      jid: "6289500000001@s.whatsapp.net",
    });
  });

  test("defaults to the paired owner when to is omitted", () => {
    expect(resolveWhatsAppOutboundDestination(base)).toEqual({
      jid: "6281111111111@s.whatsapp.net",
    });
  });

  test("blocks destinations outside an allowlist", () => {
    const result = resolveWhatsAppOutboundDestination(
      {
        ...base,
        accessMode: "allowlist",
        allowedNumbers: ["6282222222222"],
      },
      "6289500000001"
    );
    expect("error" in result).toBe(true);
  });

  test("allows an allowlisted destination", () => {
    expect(
      resolveWhatsAppOutboundDestination(
        {
          ...base,
          accessMode: "allowlist",
          allowedNumbers: ["6289500000001"],
        },
        "6289500000001"
      )
    ).toEqual({ jid: "6289500000001@s.whatsapp.net" });
  });

  test("does not keep leftover allowed numbers after leaving allowlist mode", () => {
    expect(
      resolveWhatsAppOutboundDestination(
        {
          ...base,
          accessMode: "pairing",
          allowedNumbers: ["6282222222222"],
        },
        "6289500000001"
      )
    ).toEqual({ jid: "6289500000001@s.whatsapp.net" });
  });
});

describe("normalizePhoneNumberDigits & parsePhoneNumberList", () => {
  test("handles various international and local phone number formats", () => {
    expect(normalizePhoneNumberDigits("+62 812-3456-7890")).toBe(
      "6281234567890"
    );
    expect(normalizePhoneNumberDigits("081234567890")).toBe("6281234567890");
    expect(normalizePhoneNumberDigits("+1 (555) 123-4567")).toBe("15551234567");
    expect(normalizePhoneNumberDigits("6281234567890")).toBe("6281234567890");
    expect(normalizePhoneNumberDigits("")).toBe("");
  });
});

describe("WhatsApp LID identity", () => {
  test("does not treat LID identifiers as phone digits", () => {
    expect(whatsAppUserDigits("236283431522503@lid")).toBe("");
    expect(whatsAppUserDigits("236283431522503:0@lid")).toBe("");
    expect(whatsAppUserDigits("6281234567890@s.whatsapp.net")).toBe(
      "6281234567890"
    );
  });

  test("resolves a LID chat to a phone via senderPn", () => {
    expect(
      resolveWhatsAppAuthIdentity({
        jid: "236283431522503@lid",
        senderPn: "6281234567890@s.whatsapp.net",
      })
    ).toEqual({
      jid: "236283431522503@lid",
      phoneDigits: "6281234567890",
      phoneJid: "6281234567890@s.whatsapp.net",
    });
  });

  test("falls back to a stored LID mapping when senderPn is absent", () => {
    expect(
      resolveWhatsAppAuthIdentity({
        jid: "236283431522503:12@lid",
        mappedPhoneJid: "6281234567890@s.whatsapp.net",
      })
    ).toEqual({
      jid: "236283431522503:12@lid",
      phoneDigits: "6281234567890",
      phoneJid: "6281234567890@s.whatsapp.net",
    });
  });
});

describe("isWhatsAppUserAuthorized with access modes", () => {
  test("open mode authorizes any caller", () => {
    expect(
      isWhatsAppUserAuthorized("999999999@s.whatsapp.net", {
        accessMode: "open",
        allowedNumbers: [],
        blockedNumbers: [],
        pairedJid: null,
        pairedLid: null,
      })
    ).toBe(true);
  });

  test("allowlist mode authorizes only listed numbers or paired owner", () => {
    const config = {
      accessMode: "allowlist" as const,
      allowedNumbers: ["6281234567890"],
      blockedNumbers: [],
      pairedJid: "6289999999@s.whatsapp.net",
      pairedLid: null,
    };

    expect(
      isWhatsAppUserAuthorized("6281234567890@s.whatsapp.net", config)
    ).toBe(true);
    expect(isWhatsAppUserAuthorized("6289999999@s.whatsapp.net", config)).toBe(
      true
    );
    expect(isWhatsAppUserAuthorized("62811111111@s.whatsapp.net", config)).toBe(
      false
    );
  });

  test("denylist mode blocks listed numbers and authorizes everyone else", () => {
    const config = {
      accessMode: "denylist" as const,
      allowedNumbers: [],
      blockedNumbers: ["6286666666"],
      pairedJid: null,
      pairedLid: null,
    };

    expect(isWhatsAppUserAuthorized("6286666666@s.whatsapp.net", config)).toBe(
      false
    );
    expect(isWhatsAppUserAuthorized("62811111111@s.whatsapp.net", config)).toBe(
      true
    );
  });

  test("allowlist authorizes a LID chat after resolving senderPn to a listed number", () => {
    const config = {
      accessMode: "allowlist" as const,
      allowedNumbers: ["6281234567890"],
      blockedNumbers: [],
      pairedJid: "6289999999@s.whatsapp.net",
      pairedLid: "111111111111111@lid",
    };

    expect(
      isWhatsAppUserAuthorized(
        {
          jid: "236283431522503@lid",
          senderPn: "6281234567890@s.whatsapp.net",
        },
        config
      )
    ).toBe(true);
  });

  test("allowlist does not match LID identifiers against phone numbers", () => {
    const config = {
      accessMode: "allowlist" as const,
      allowedNumbers: ["236283431522503"],
      blockedNumbers: [],
      pairedJid: null,
      pairedLid: "111111111111111@lid",
    };

    expect(isWhatsAppUserAuthorized("236283431522503@lid", config)).toBe(false);
    expect(
      isWhatsAppUserAuthorized(
        {
          jid: "236283431522503@lid",
          senderPn: "6281234567890@s.whatsapp.net",
        },
        config
      )
    ).toBe(false);
  });

  test("allowlist still authorizes the owner LID without senderPn", () => {
    const config = {
      accessMode: "allowlist" as const,
      allowedNumbers: ["6281234567890"],
      blockedNumbers: [],
      pairedJid: "6289999999@s.whatsapp.net",
      pairedLid: "236283431522503@lid",
    };

    expect(isWhatsAppUserAuthorized("236283431522503@lid", config)).toBe(true);
  });

  test("denylist blocks a LID chat once senderPn maps to a blocked number", () => {
    const config = {
      accessMode: "denylist" as const,
      allowedNumbers: [],
      blockedNumbers: ["6286666666"],
      pairedJid: null,
      pairedLid: null,
    };

    expect(
      isWhatsAppUserAuthorized(
        {
          jid: "236283431522503@lid",
          senderPn: "6286666666@s.whatsapp.net",
        },
        config
      )
    ).toBe(false);
    expect(isWhatsAppUserAuthorized("236283431522503@lid", config)).toBe(false);
  });
});

describe("WhatsApp LID phone map", () => {
  test("persists LID to phone JID and looks up device-suffixed inbound LIDs", async () => {
    await withTempHomedir("atlas-core-wa-lid-map-", async () => {
      const phoneJid = await rememberWhatsAppLidPhone(
        "236283431522503:12@lid",
        "6281234567890@s.whatsapp.net"
      );
      expect(phoneJid).toBe("6281234567890@s.whatsapp.net");

      const map = await loadWhatsAppLidMap();
      expect(lookupWhatsAppLidPhone(map, "236283431522503@lid")).toBe(
        "6281234567890@s.whatsapp.net"
      );
      expect(
        isWhatsAppUserAuthorized(
          {
            jid: "236283431522503@lid",
            mappedPhoneJid: lookupWhatsAppLidPhone(map, "236283431522503@lid"),
          },
          {
            accessMode: "allowlist",
            allowedNumbers: ["6281234567890"],
            blockedNumbers: [],
            pairedJid: null,
            pairedLid: null,
          }
        )
      ).toBe(true);
    });
  });
});
