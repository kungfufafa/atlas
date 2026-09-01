import { describe, expect, test } from "bun:test";
import { parseCorsAllowedOrigins } from "./cors";
import { createMinimalHonoApp } from "./test-app-helpers";

const ALLOWED_ORIGIN = "http://localhost:8081";
const BLOCKED_ORIGIN = "https://blocked.example.com";

function createApp(corsAllowedOrigins?: readonly string[]) {
  return createMinimalHonoApp({ corsAllowedOrigins }).app;
}

describe("CORS", () => {
  test("is disabled when no origins are configured", async () => {
    const response = await createApp().fetch(
      new Request("http://localhost:4310/health", {
        headers: { Origin: ALLOWED_ORIGIN },
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("allows health checks from an exact configured origin", async () => {
    const response = await createApp([ALLOWED_ORIGIN]).fetch(
      new Request("http://localhost:4310/health", {
        headers: { Origin: ALLOWED_ORIGIN },
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(response.headers.get("Vary")).toContain("Origin");
  });

  test("answers Atlas client preflight requests before authentication", async () => {
    const response = await createApp([ALLOWED_ORIGIN]).fetch(
      new Request("http://localhost:4310/v1/auth/login", {
        headers: {
          "Access-Control-Request-Headers":
            "content-type, x-atlas-auth-mode, x-org-id",
          "Access-Control-Request-Method": "POST",
          Origin: ALLOWED_ORIGIN,
        },
        method: "OPTIONS",
      })
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain(
      "POST"
    );
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain(
      "X-Atlas-Auth-Mode"
    );
    expect(response.headers.get("Access-Control-Max-Age")).toBe("600");
  });

  test("does not expose responses to an unconfigured origin", async () => {
    const response = await createApp([ALLOWED_ORIGIN]).fetch(
      new Request("http://localhost:4310/health", {
        headers: { Origin: BLOCKED_ORIGIN },
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("keeps CORS headers on authentication errors", async () => {
    const response = await createApp([ALLOWED_ORIGIN]).fetch(
      new Request("http://localhost:4310/v1/platform/orgs", {
        headers: {
          Origin: ALLOWED_ORIGIN,
          "X-Atlas-Auth-Mode": "token",
        },
      })
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      ALLOWED_ORIGIN
    );
  });
});

describe("parseCorsAllowedOrigins", () => {
  test("normalizes and deduplicates exact HTTP(S) origins", () => {
    expect(
      parseCorsAllowedOrigins(
        "http://localhost:8081/, https://EXAMPLE.com, http://localhost:8081"
      )
    ).toEqual(["http://localhost:8081", "https://example.com"]);
  });

  test("returns no origins for an empty setting", () => {
    expect(parseCorsAllowedOrigins(undefined)).toEqual([]);
    expect(parseCorsAllowedOrigins("   ")).toEqual([]);
  });

  test.each([
    "*",
    "ftp://example.com",
    "https://user@example.com",
    "https://example.com/path",
    "https://example.com?query=1",
    "https://example.com#fragment",
    "https://example.com,",
  ])("rejects invalid or non-origin entries: %s", (value) => {
    expect(() => parseCorsAllowedOrigins(value)).toThrow();
  });
});
