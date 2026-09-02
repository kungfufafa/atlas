import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkspaceWorkerAuthToken,
  LocalAuthTokenManagedExternallyError,
  loadLocalAuthToken,
  loadPlatformWorkerAuthToken,
  rotateLocalAuthToken,
  verifyLocalAuthToken,
  verifyWorkspaceWorkerAuthToken,
  WORKSPACE_WORKER_AUTH_TOKEN_ENV,
} from "./local-auth";
import {
  getUserConfigDir,
  getUserConfigPath,
  saveUserConfig,
} from "./user-config";

describe("loadLocalAuthToken", () => {
  let configDir = "";

  afterEach(async () => {
    if (configDir) {
      await rm(configDir, { force: true, recursive: true });
      configDir = "";
    }

    delete process.env.ATLAS_CONFIG_DIR;
    delete process.env.ATLAS_LOCAL_AUTH_TOKEN;
    delete process.env.ATLAS_WORKSPACE_AUTH_TOKEN;
    delete process.env.atlas_LOCAL_AUTH_TOKEN;
  });

  test("generates a token when none is configured", async () => {
    configDir = await mkdtemp(join(tmpdir(), "atlas-local-auth-"));
    process.env.ATLAS_CONFIG_DIR = configDir;

    const token = await loadLocalAuthToken();
    expect(token).toStartWith("tc_local_");

    const rawConfig = await readFile(getUserConfigPath(), "utf8");
    expect(rawConfig).toContain("local_auth_token_hash=");
    expect(rawConfig).not.toContain(token!);

    const storedToken = await readFile(
      join(getUserConfigDir(), "local-auth-token"),
      "utf8"
    );
    expect(storedToken.trim()).toBe(token);
  });

  test("reuses the token from the private local token file", async () => {
    configDir = await mkdtemp(join(tmpdir(), "atlas-local-auth-"));
    process.env.ATLAS_CONFIG_DIR = configDir;
    const tokenValue = "tc_local_configured_token";

    await saveUserConfig({
      defaultProviderId: null,
      localAuthTokenHash: createHash("sha256").update(tokenValue).digest("hex"),
      providers: [],
    });
    await writeFile(
      join(getUserConfigDir(), "local-auth-token"),
      `${tokenValue}\n`,
      "utf8"
    );

    const token = await loadLocalAuthToken("whatsapp@atlas.internal");
    expect(token).toBe(tokenValue);

    const rawConfig = await readFile(getUserConfigPath(), "utf8");
    expect(rawConfig).toContain("local_auth_token_hash=");
    expect(rawConfig).not.toContain(
      "local_auth_token=tc_local_configured_token"
    );
  });

  test("verifies the configured local auth token", async () => {
    configDir = await mkdtemp(join(tmpdir(), "atlas-local-auth-"));
    process.env.ATLAS_CONFIG_DIR = configDir;

    const token = await loadLocalAuthToken();

    await expect(verifyLocalAuthToken(token!)).resolves.toEqual({
      email: "local-client@atlas.internal",
    });
    await expect(verifyLocalAuthToken("wrong-token")).resolves.toBeNull();
  });

  test("prefers env token for production-style setup", async () => {
    process.env.ATLAS_LOCAL_AUTH_TOKEN = "tc_local_from_env";
    await expect(loadLocalAuthToken()).resolves.toBe("tc_local_from_env");
    await expect(verifyLocalAuthToken("tc_local_from_env")).resolves.toEqual({
      email: "local-client@atlas.internal",
    });
  });

  test("ATLAS_LOCAL_AUTH_TOKEN wins over the lowercase alias", async () => {
    process.env.ATLAS_LOCAL_AUTH_TOKEN = "tc_local_uppercase_env";
    process.env.atlas_LOCAL_AUTH_TOKEN = "tc_local_lowercase_env";
    await expect(loadLocalAuthToken()).resolves.toBe("tc_local_uppercase_env");
    await expect(rotateLocalAuthToken()).rejects.toBeInstanceOf(
      LocalAuthTokenManagedExternallyError
    );
  });

  test("still honors the lowercase atlas_LOCAL_AUTH_TOKEN alias", async () => {
    process.env.atlas_LOCAL_AUTH_TOKEN = "tc_local_from_env";
    await expect(loadLocalAuthToken()).resolves.toBe("tc_local_from_env");
  });

  test("rotateLocalAuthToken replaces the stored token and invalidates the old one", async () => {
    configDir = await mkdtemp(join(tmpdir(), "atlas-local-auth-"));
    process.env.ATLAS_CONFIG_DIR = configDir;

    const original = await loadLocalAuthToken();
    const rotated = await rotateLocalAuthToken();

    expect(rotated).toStartWith("tc_local_");
    expect(rotated).not.toBe(original);
    await expect(verifyLocalAuthToken(original!)).resolves.toBeNull();
    await expect(verifyLocalAuthToken(rotated)).resolves.toEqual({
      email: "local-client@atlas.internal",
    });
    await expect(loadLocalAuthToken()).resolves.toBe(rotated);
  });

  test("rotateLocalAuthToken refuses when the token comes from env", async () => {
    process.env.ATLAS_LOCAL_AUTH_TOKEN = "tc_local_from_env";
    await expect(rotateLocalAuthToken()).rejects.toBeInstanceOf(
      LocalAuthTokenManagedExternallyError
    );
  });

  test("signs and verifies workspace and channel scoped worker tokens", async () => {
    configDir = await mkdtemp(join(tmpdir(), "atlas-worker-auth-"));
    process.env.ATLAS_CONFIG_DIR = configDir;

    const token = await createWorkspaceWorkerAuthToken({
      channel: "whatsapp",
      orgId: "org_alpha",
    });
    expect(token).toStartWith("tc_worker_v1_");
    await expect(verifyWorkspaceWorkerAuthToken(token)).resolves.toEqual({
      channel: "whatsapp",
      orgId: "org_alpha",
    });
    await expect(verifyLocalAuthToken(token)).resolves.toBeNull();

    const separator = token.lastIndexOf(".");
    const signature = token.slice(separator + 1);
    const replacement = signature.startsWith("A") ? "B" : "A";
    const tampered = `${token.slice(0, separator + 1)}${replacement}${signature.slice(1)}`;
    await expect(verifyWorkspaceWorkerAuthToken(tampered)).resolves.toBeNull();
  });

  test("workspace worker token loading fails closed without injected scope", async () => {
    configDir = await mkdtemp(join(tmpdir(), "atlas-worker-auth-"));
    process.env.ATLAS_CONFIG_DIR = configDir;
    await expect(
      loadPlatformWorkerAuthToken("telegram", "org_alpha", {})
    ).rejects.toThrow(WORKSPACE_WORKER_AUTH_TOKEN_ENV);

    const scoped = await createWorkspaceWorkerAuthToken({
      channel: "telegram",
      orgId: "org_alpha",
    });
    await expect(
      loadPlatformWorkerAuthToken("telegram", "org_alpha", {
        [WORKSPACE_WORKER_AUTH_TOKEN_ENV]: scoped,
      })
    ).resolves.toBe(scoped);

    const legacy = await loadPlatformWorkerAuthToken("telegram", undefined, {});
    expect(legacy).toStartWith("tc_local_");
  });
});
