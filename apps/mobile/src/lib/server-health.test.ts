import { afterEach, expect, mock, test } from "bun:test";
import { ATLAS_API_VERSION } from "@atlas/core/contract";
import {
  checkAtlasServer,
  isCompatibleAtlasHealthResponse,
} from "./server-health";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("only recognizes a compatible Atlas health response", () => {
  expect(
    isCompatibleAtlasHealthResponse({
      apiVersion: ATLAS_API_VERSION,
      ok: true,
    })
  ).toBe(true);
  expect(isCompatibleAtlasHealthResponse({ apiVersion: 999, ok: true })).toBe(
    false
  );
  expect(isCompatibleAtlasHealthResponse({ ok: false })).toBe(false);
  expect(isCompatibleAtlasHealthResponse(null)).toBe(false);
});

test("does not probe a public HTTP URL", async () => {
  const fetchMock = mock(() => {
    throw new Error("should not fetch");
  });
  globalThis.fetch = fetchMock as typeof fetch;

  await expect(checkAtlasServer("http://atlas.example.com")).rejects.toThrow();
  expect(fetchMock).not.toHaveBeenCalled();
});

test("does not probe local HTTP until the connection is confirmed", async () => {
  const fetchMock = mock(() => {
    throw new Error("should not fetch");
  });
  globalThis.fetch = fetchMock as typeof fetch;

  await expect(checkAtlasServer("http://127.0.0.1:4310")).rejects.toThrow();
  expect(fetchMock).not.toHaveBeenCalled();
});

test("probes a confirmed local HTTP Atlas health endpoint", async () => {
  const fetchMock = mock(async () => ({
    json: async () => ({ apiVersion: ATLAS_API_VERSION, ok: true }),
    ok: true,
    url: "http://127.0.0.1:4310/health",
  }));
  globalThis.fetch = fetchMock as typeof fetch;

  await checkAtlasServer("http://127.0.0.1:4310", { allowInsecure: true });

  expect(fetchMock).toHaveBeenCalledWith(
    "http://127.0.0.1:4310/health",
    expect.objectContaining({
      credentials: "omit",
      redirect: "error",
    })
  );
});
