import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { AtlasApiError } from "@atlas/core";
import { readJsonWithLimit, readOptionalJson } from "./shared";

const URL = "http://localhost:4310/test";
const realSetImmediate = setImmediate;

function flushAsyncWork() {
  // Drain stream/promise work without advancing the virtual deadline clock.
  return new Promise<void>((resolve) => realSetImmediate(resolve));
}

function createControlledUpload(cancel?: () => void | Promise<void>) {
  let nextChunk = Promise.withResolvers<string | undefined>();
  let nextRead = Promise.withResolvers<void>();
  const body = new ReadableStream<Uint8Array>(
    {
      cancel,
      async pull(controller) {
        const chunkPromise = nextChunk.promise;
        nextRead.resolve();
        const chunk = await chunkPromise;

        if (chunk === undefined) {
          controller.close();
          return;
        }

        controller.enqueue(new TextEncoder().encode(chunk));
      },
    },
    // A pull acknowledges an actual reader.read(), not stream prefetching.
    { highWaterMark: 0 }
  );

  return {
    body,
    send(chunk?: string) {
      const pendingChunk = nextChunk;
      nextChunk = Promise.withResolvers<string | undefined>();
      nextRead = Promise.withResolvers<void>();
      pendingChunk.resolve(chunk);
    },
    waitForRead: (result: Promise<unknown>) =>
      Promise.race([
        nextRead.promise,
        result.then(() => {
          throw new Error("Upload completed before the next body read.");
        }),
      ]),
  };
}

describe.serial("readJsonWithLimit", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: 0 });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("enforces an idle body-read deadline without awaiting a hanging cancel", async () => {
    let cancelled = false;
    const upload = createControlledUpload(() => {
      cancelled = true;
      return new Promise<void>(() => undefined);
    });
    const request = new Request(URL, { body: upload.body, method: "POST" });
    const result = readJsonWithLimit(request, 1024, { timeoutMs: 10 });
    let failure: unknown;
    void result.catch((error: unknown) => {
      failure = error;
    });

    await upload.waitForRead(result);
    upload.send('{"data":"');
    await upload.waitForRead(result);
    jest.advanceTimersByTime(9);
    await flushAsyncWork();
    expect(cancelled).toBe(false);
    jest.advanceTimersByTime(1);
    await flushAsyncWork();

    expect(failure).toBeInstanceOf(AtlasApiError);
    expect(failure).toMatchObject({ status: 408 });
    expect(cancelled).toBe(true);
    expect(Date.now()).toBe(10);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("allows a slow upload while every chunk arrives before the idle deadline", async () => {
    const chunks = ["{", '"ok"', ":", "true", "}"];
    const upload = createControlledUpload();
    const request = new Request(URL, { body: upload.body, method: "POST" });
    const result = readJsonWithLimit(request, 1024, { timeoutMs: 30 });

    for (const chunk of chunks) {
      await upload.waitForRead(result);
      jest.advanceTimersByTime(15);
      upload.send(chunk);
    }

    await upload.waitForRead(result);
    jest.advanceTimersByTime(15);
    upload.send();

    await expect(result).resolves.toEqual({ ok: true });
    expect(Date.now()).toBe(90);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("enforces a hard total deadline even while chunks keep arriving", async () => {
    let cancelled = false;
    const upload = createControlledUpload(() => {
      cancelled = true;
    });
    const request = new Request(URL, { body: upload.body, method: "POST" });
    const result = readJsonWithLimit(request, 1024, {
      maxTotalMs: 45,
      timeoutMs: 30,
    });
    let failure: unknown;
    void result.catch((error: unknown) => {
      failure = error;
    });

    for (let index = 0; index < 4; index += 1) {
      await upload.waitForRead(result);
      jest.advanceTimersByTime(10);
      upload.send(" ");
    }

    await upload.waitForRead(result);
    jest.advanceTimersByTime(4);
    await flushAsyncWork();
    expect(cancelled).toBe(false);
    jest.advanceTimersByTime(1);
    await flushAsyncWork();

    expect(failure).toBeInstanceOf(AtlasApiError);
    expect(failure).toMatchObject({ status: 408 });
    expect(cancelled).toBe(true);
    expect(Date.now()).toBe(45);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("rejects streamed bodies over the limit even when cancellation fails", async () => {
    const body = new ReadableStream<Uint8Array>({
      cancel: () => Promise.reject(new Error("cancel failed")),
      start: (controller) => {
        controller.enqueue(new TextEncoder().encode("123456"));
      },
    });
    const request = new Request(URL, { body, method: "POST" });

    try {
      await readJsonWithLimit(request, 5, { timeoutMs: 1000 });
      throw new Error("Expected the body limit to be enforced.");
    } catch (error) {
      expect(error).toBeInstanceOf(AtlasApiError);
      expect((error as AtlasApiError).status).toBe(413);
    }
  });
});

describe("readOptionalJson", () => {
  test("uses the fallback only for an empty body", async () => {
    const request = new Request(URL, { body: " \n", method: "POST" });

    await expect(
      readOptionalJson(request, { enabled: false })
    ).resolves.toEqual({ enabled: false });
  });

  test("rejects malformed non-empty JSON", async () => {
    const request = new Request(URL, { body: "{", method: "POST" });

    await expect(readOptionalJson(request, {})).rejects.toMatchObject({
      status: 400,
    });
  });
});
