import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isLoopbackComposioCallbackBaseUrl,
  persistWebPublicUrl,
  resolveComposioCallbackBaseUrl,
  resolveComposioOAuthCallbackBaseUrl,
  resolveRequestClientOrigin,
  validateComposioOAuthRedirectUrl,
} from "./composio-callback-url";

describe("composio-callback-url", () => {
  test("validateComposioOAuthRedirectUrl accepts HTTPS and loopback development", () => {
    expect(
      validateComposioOAuthRedirectUrl("https://oauth.example.com/start")
    ).toBe("https://oauth.example.com/start");
    expect(
      validateComposioOAuthRedirectUrl("http://127.0.0.1:4310/start")
    ).toBe("http://127.0.0.1:4310/start");
  });

  for (const unsafeUrl of [
    "javascript:alert(1)",
    "http://oauth.example.com/start",
    "https://user:password@oauth.example.com/start",
  ]) {
    test(`validateComposioOAuthRedirectUrl rejects ${unsafeUrl}`, () => {
      expect(() => validateComposioOAuthRedirectUrl(unsafeUrl)).toThrow(
        /OAuth URL/
      );
    });
  }

  test("resolveRequestClientOrigin prefers explicit origin", () => {
    const request = new Request(
      "http://api.example.com/v1/composio/toolkits/gmail/connect",
      {
        headers: { Origin: "http://ignored.example.com" },
      }
    );

    expect(
      resolveRequestClientOrigin(request, "https://app.example.com/")
    ).toBe("https://app.example.com");
  });

  test("resolveComposioOAuthCallbackBaseUrl ignores off-origin callbackOrigin", () => {
    const previousPublic = process.env.ATLAS_WEB_PUBLIC_URL;
    const previousAlias = process.env.ATLAS_PUBLIC_URL;
    const previousConfigDir = process.env.ATLAS_CONFIG_DIR;
    const configDir = join(tmpdir(), `atlas-composio-cb-${Date.now()}`);
    mkdirSync(configDir, { recursive: true });
    process.env.ATLAS_CONFIG_DIR = configDir;
    delete process.env.ATLAS_WEB_PUBLIC_URL;
    delete process.env.ATLAS_PUBLIC_URL;
    try {
      const request = new Request(
        "http://localhost:4310/v1/composio/toolkits/gmail/connect"
      );

      const resolved = resolveComposioOAuthCallbackBaseUrl({
        clientOrigin: "https://evil.example",
        request,
      });
      expect(resolved).not.toBe("https://evil.example");
      expect(resolved.startsWith("http://localhost")).toBe(true);
    } finally {
      rmSync(configDir, { force: true, recursive: true });
      if (previousConfigDir === undefined) {
        delete process.env.ATLAS_CONFIG_DIR;
      } else {
        process.env.ATLAS_CONFIG_DIR = previousConfigDir;
      }
      if (previousPublic === undefined) {
        delete process.env.ATLAS_WEB_PUBLIC_URL;
      } else {
        process.env.ATLAS_WEB_PUBLIC_URL = previousPublic;
      }
      if (previousAlias === undefined) {
        delete process.env.ATLAS_PUBLIC_URL;
      } else {
        process.env.ATLAS_PUBLIC_URL = previousAlias;
      }
    }
  });

  test("resolveRequestClientOrigin ignores non-http origins", () => {
    expect(
      resolveRequestClientOrigin(undefined, "javascript:alert(1)")
    ).toBeUndefined();
  });

  test("resolveRequestClientOrigin reads Origin header", () => {
    const request = new Request(
      "http://api.example.com/v1/sessions/s1/messages",
      {
        headers: { Origin: "http://localhost:3000" },
      }
    );

    expect(resolveRequestClientOrigin(request)).toBe("http://localhost:3000");
  });

  test("isLoopbackComposioCallbackBaseUrl detects localhost hosts", () => {
    expect(isLoopbackComposioCallbackBaseUrl("http://127.0.0.1:3000")).toBe(
      true
    );
    expect(isLoopbackComposioCallbackBaseUrl("http://localhost:3000")).toBe(
      true
    );
    expect(isLoopbackComposioCallbackBaseUrl("https://atlas.example.com")).toBe(
      false
    );
  });

  test("resolveComposioCallbackBaseUrl falls back to env when no request", () => {
    const previous = process.env.ATLAS_WEB_PUBLIC_URL;
    process.env.ATLAS_WEB_PUBLIC_URL = "https://deployed.example.com/";

    try {
      expect(resolveComposioCallbackBaseUrl()).toBe(
        "https://deployed.example.com"
      );
    } finally {
      if (previous === undefined) {
        delete process.env.ATLAS_WEB_PUBLIC_URL;
      } else {
        process.env.ATLAS_WEB_PUBLIC_URL = previous;
      }
    }
  });

  test("configured public URL cannot be overridden by caller headers", () => {
    const previous = process.env.ATLAS_WEB_PUBLIC_URL;
    process.env.ATLAS_WEB_PUBLIC_URL = "https://deployed.example.com";
    const request = new Request(
      "http://127.0.0.1:4310/v1/composio/toolkits/gmail/connect",
      {
        headers: {
          Origin: "https://evil.example.com",
          "X-Forwarded-Host": "evil.example.com",
          "X-Forwarded-Proto": "https",
        },
        method: "POST",
      }
    );

    try {
      expect(
        resolveComposioCallbackBaseUrl({
          clientOrigin: "https://evil.example.com",
          request,
        })
      ).toBe("https://deployed.example.com");
      expect(
        resolveComposioOAuthCallbackBaseUrl({
          clientOrigin: "http://127.0.0.1:4310",
          request,
        })
      ).toBe("https://deployed.example.com");
    } finally {
      if (previous === undefined) {
        delete process.env.ATLAS_WEB_PUBLIC_URL;
      } else {
        process.env.ATLAS_WEB_PUBLIC_URL = previous;
      }
    }
  });

  test("persistWebPublicUrl preserves path segments", async () => {
    const configDir = join(tmpdir(), `atlas-callback-url-test-${Date.now()}`);
    mkdirSync(configDir, { recursive: true });
    const previousConfigDir = process.env.ATLAS_CONFIG_DIR;
    process.env.ATLAS_CONFIG_DIR = configDir;

    try {
      expect(await persistWebPublicUrl("https://gateway.example.com/v1/")).toBe(
        "https://gateway.example.com/v1"
      );
      expect(resolveComposioCallbackBaseUrl()).toBe(
        "https://gateway.example.com/v1"
      );
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.ATLAS_CONFIG_DIR;
      } else {
        process.env.ATLAS_CONFIG_DIR = previousConfigDir;
      }
      rmSync(configDir, { force: true, recursive: true });
    }
  });
});
