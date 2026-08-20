import { afterEach, describe, expect, test } from "bun:test";
import { loadPublicArtifactShare } from "./use-public-artifact-share";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

describe("loadPublicArtifactShare", () => {
  test("keeps a valid share when rich preview fails", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("?meta=1")) {
        return jsonResponse({
          filename: "sales.xlsx",
          inlineAllowed: false,
          mimeType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          sizeBytes: 128,
        });
      }
      if (url.includes("/preview")) {
        return jsonResponse({ error: "Office conversion timed out" }, 500);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    const result = await loadPublicArtifactShare("share-token");
    expect(result.metadata.filename).toBe("sales.xlsx");
    expect(result.preview).toBeNull();
    expect(result.content).toBeNull();
  });

  test("still treats missing share metadata as unavailable", async () => {
    globalThis.fetch = (async () =>
      new Response("Not found", { status: 404 })) as typeof fetch;

    await expect(loadPublicArtifactShare("missing")).rejects.toThrow(
      "This share link is unavailable."
    );
  });
});
