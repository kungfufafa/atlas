import { describe, expect, test } from "bun:test";
import { AtlasApiError } from "@atlas/core";
import { readJsonWithLimit } from "./shared";

describe("readJsonWithLimit", () => {
  test("enforces an absolute body-read deadline without awaiting a hanging cancel", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
        return new Promise<void>(() => undefined);
      },
      start: (controller) => {
        controller.enqueue(new TextEncoder().encode('{"data":"'));
      },
    });
    const request = new Request("http://localhost/upload", {
      body,
      method: "POST",
    });
    const startedAt = Date.now();

    try {
      await readJsonWithLimit(request, 1024, { timeoutMs: 10 });
      throw new Error("Expected the body read to time out.");
    } catch (error) {
      expect(error).toBeInstanceOf(AtlasApiError);
      expect((error as AtlasApiError).status).toBe(408);
      expect((error as Error).message).toBe("Request body read timed out.");
    }

    expect(cancelled).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  test("rejects streamed bodies over the limit even when cancellation fails", async () => {
    const body = new ReadableStream<Uint8Array>({
      cancel: () => Promise.reject(new Error("cancel failed")),
      start: (controller) => {
        controller.enqueue(new TextEncoder().encode("123456"));
      },
    });
    const request = new Request("http://localhost/upload", {
      body,
      method: "POST",
    });

    try {
      await readJsonWithLimit(request, 5, { timeoutMs: 1000 });
      throw new Error("Expected the body limit to be enforced.");
    } catch (error) {
      expect(error).toBeInstanceOf(AtlasApiError);
      expect((error as AtlasApiError).status).toBe(413);
    }
  });
});
