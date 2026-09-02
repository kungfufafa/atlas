import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { getWhatsAppConfigDir } from "./whatsapp-config";
import {
  formatWhatsAppOutboundAuthorization,
  getWhatsAppOutboundAuthTokenPath,
  loadOrCreateWhatsAppOutboundAuthToken,
  verifyWhatsAppOutboundAuthorization,
} from "./whatsapp-outbound-auth";

function permissionMode(mode: number): number {
  return mode % 0o1000;
}

describe("WhatsApp outbound auth token", () => {
  let tempHome = "";
  let homedirSpy: ReturnType<typeof spyOn<typeof os, "homedir">> | null = null;

  afterEach(async () => {
    homedirSpy?.mockRestore();
    homedirSpy = null;
    if (tempHome) {
      await rm(tempHome, { force: true, recursive: true });
      tempHome = "";
    }
  });

  async function useTempHome(): Promise<void> {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "atlas-wa-auth-"));
    homedirSpy = spyOn(os, "homedir").mockReturnValue(tempHome);
  }

  test("persists a stable, private token scoped to each workspace", async () => {
    await useTempHome();

    const first = await loadOrCreateWhatsAppOutboundAuthToken("org_alpha");
    const again = await loadOrCreateWhatsAppOutboundAuthToken("org_alpha");
    const second = await loadOrCreateWhatsAppOutboundAuthToken("org_beta");

    expect(first).toBe(again);
    expect(second).not.toBe(first);
    expect(first.startsWith("atlas_wa_")).toBe(true);

    const tokenStats = await lstat(
      getWhatsAppOutboundAuthTokenPath("org_alpha")
    );
    const directoryStats = await lstat(getWhatsAppConfigDir("org_alpha"));
    expect(permissionMode(tokenStats.mode)).toBe(0o600);
    expect(permissionMode(directoryStats.mode)).toBe(0o700);
  });

  test("repairs overly broad permissions when loading an existing token", async () => {
    await useTempHome();
    const token = await loadOrCreateWhatsAppOutboundAuthToken("org_alpha");
    const tokenPath = getWhatsAppOutboundAuthTokenPath("org_alpha");
    const directory = getWhatsAppConfigDir("org_alpha");
    await chmod(tokenPath, 0o644);
    await chmod(directory, 0o755);

    expect(await loadOrCreateWhatsAppOutboundAuthToken("org_alpha")).toBe(
      token
    );
    expect(permissionMode((await lstat(tokenPath)).mode)).toBe(0o600);
    expect(permissionMode((await lstat(directory)).mode)).toBe(0o700);
  });

  test("concurrent creators converge on one complete token", async () => {
    await useTempHome();

    const tokens = await Promise.all(
      Array.from({ length: 20 }, () =>
        loadOrCreateWhatsAppOutboundAuthToken("org_concurrent")
      )
    );

    expect(new Set(tokens).size).toBe(1);
    expect(tokens[0]?.startsWith("atlas_wa_")).toBe(true);
  });

  test("fails closed for corrupt tokens and final-path symlinks", async () => {
    await useTempHome();
    await loadOrCreateWhatsAppOutboundAuthToken("org_corrupt");
    const corruptPath = getWhatsAppOutboundAuthTokenPath("org_corrupt");
    await writeFile(corruptPath, "not-a-valid-token\n", "utf8");
    await expect(
      loadOrCreateWhatsAppOutboundAuthToken("org_corrupt")
    ).rejects.toThrow("token is invalid");

    await loadOrCreateWhatsAppOutboundAuthToken("org_symlink");
    const symlinkPath = getWhatsAppOutboundAuthTokenPath("org_symlink");
    await rm(symlinkPath);
    await symlink(corruptPath, symlinkPath);
    await expect(
      loadOrCreateWhatsAppOutboundAuthToken("org_symlink")
    ).rejects.toThrow();
  });

  test("formats and verifies authorization without accepting near matches", async () => {
    await useTempHome();
    const token = await loadOrCreateWhatsAppOutboundAuthToken("org_alpha");
    const authorization = formatWhatsAppOutboundAuthorization(token);

    expect(verifyWhatsAppOutboundAuthorization(authorization, token)).toBe(
      true
    );
    expect(verifyWhatsAppOutboundAuthorization(null, token)).toBe(false);
    expect(
      verifyWhatsAppOutboundAuthorization(`${authorization}x`, token)
    ).toBe(false);
  });
});
