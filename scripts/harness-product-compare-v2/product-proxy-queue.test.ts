import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { comparisonModel } from "../harness-compare/proxy";
import { startProductProxy } from "./product-proxy";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, reject, resolve };
}
const tick = (ms = 80) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const reply = (input: number, output: number) =>
  Response.json({
    choices: [
      {
        finish_reason: "stop",
        message: { content: "synthetic", role: "assistant" },
      },
    ],
    usage: { completion_tokens: output, prompt_tokens: input },
  });
async function fixture(
  fetchUpstream: (url: string, init: RequestInit) => Promise<Response>
) {
  const evidence = process.env.QUEUE_EVIDENCE_DIR;
  if (evidence) {
    await mkdir(evidence, { recursive: true });
  }
  const root = await mkdtemp(join(evidence ?? tmpdir(), "product-queue-"));
  const keyFile = join(root, "synthetic-key");
  await writeFile(keyFile, "synthetic-not-a-provider-credential");
  const proxy = await startProductProxy({
    directory: join(root, "wire"),
    fetchUpstream,
    harness: "hermes",
    keyFile,
    runId: "opaque-queue-fixture",
  });
  const post = (label: string, signal?: AbortSignal) =>
    fetch(`${proxy.url}/runs/opaque-queue-fixture/v1/chat/completions`, {
      body: JSON.stringify({
        messages: [{ content: label, role: "user" }],
        model: comparisonModel,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal,
    });
  return { post, proxy, root };
}

test("client disconnect does not release admitted work before upstream and ledger settle", async () => {
  const first = deferred<Response>();
  const admitted = deferred<void>();
  const calls: unknown[] = [];
  const local = await fixture(async (_url, init) => {
    calls.push(JSON.parse(String(init.body)));
    if (calls.length === 1) {
      admitted.resolve();
      return await first.promise;
    }
    return reply(30, 11);
  });
  const controller = new AbortController();
  let followup: Promise<Response> | undefined;
  try {
    const abandoned = local.post("first", controller.signal).then(
      () => false,
      () => true
    );
    await admitted.promise;
    controller.abort();
    expect(await abandoned).toBe(true);
    let followupSettled = false;
    followup = local.post("second");
    void followup.then(
      () => {
        followupSettled = true;
      },
      () => {
        followupSettled = true;
      }
    );
    await tick();
    expect(calls).toHaveLength(1);
    expect(followupSettled).toBe(false);
    expect(local.proxy.run.activeRequest).toBe(true);
    first.resolve(reply(12, 7));
    expect((await followup).status).toBe(200);
    const usage = await local.proxy.finalize();
    expect(calls).toHaveLength(2);
    expect(usage).toMatchObject({
      generatedTokens: 18,
      inFlightRequests: 0,
      mandatoryUsageKnown: true,
      promptTokens: 42,
    });
    expect(usage.requests.map((request) => request.status)).toEqual([200, 200]);
    expect(local.proxy.run.providerStatuses).toEqual([200, 200]);
    const firstLedger = JSON.parse(
      await readFile(join(local.root, "wire/001-response.json"), "utf8")
    );
    expect(firstLedger.response.usage).toEqual({
      completion_tokens: 7,
      prompt_tokens: 12,
    });
    const secondLedger = JSON.parse(
      await readFile(join(local.root, "wire/002-request.json"), "utf8")
    );
    expect(secondLedger.effective.messages[0].content).toBe("second");
  } finally {
    first.resolve(reply(12, 7));
    await followup?.catch(() => undefined);
    await local.proxy.close();
  }
});

test("an aborted queued request never consumes an upstream call and the next request proceeds", async () => {
  const first = deferred<Response>();
  const admitted = deferred<void>();
  const labels: string[] = [];
  const local = await fixture(async (_url, init) => {
    labels.push(JSON.parse(String(init.body)).messages[0].content);
    if (labels.length === 1) {
      admitted.resolve();
      return await first.promise;
    }
    return reply(30, 11);
  });
  let leader: Promise<Response> | undefined;
  let tail: Promise<Response> | undefined;
  try {
    leader = local.post("first");
    await admitted.promise;
    const controller = new AbortController();
    const cancelled = local.post("never-admit", controller.signal).then(
      () => false,
      () => true
    );
    await tick();
    controller.abort();
    expect(await cancelled).toBe(true);
    tail = local.post("third");
    await tick();
    expect(labels).toEqual(["first"]);
    first.resolve(reply(12, 7));
    expect((await leader).status).toBe(200);
    expect((await tail).status).toBe(200);
    expect(labels).toEqual(["first", "third"]);
    const usage = await local.proxy.finalize();
    expect(usage.requests).toHaveLength(2);
    expect(usage.mandatoryUsageKnown).toBe(true);
  } finally {
    first.resolve(reply(12, 7));
    await Promise.allSettled([leader, tail].filter(Boolean));
    await local.proxy.close();
  }
});

test("disconnect followed by finalization cancels upstream, refuses queued work, and preserves unknown usage", async () => {
  const admitted = deferred<void>();
  let calls = 0;
  let cancelled = false;
  const local = await fixture((_url, init) => {
    calls++;
    admitted.resolve();
    return new Promise<Response>((_resolve, reject) => {
      const abort = () => {
        cancelled = true;
        reject(init.signal?.reason);
      };
      if (init.signal?.aborted) {
        abort();
      } else {
        init.signal?.addEventListener("abort", abort, { once: true });
      }
    });
  });
  try {
    const controller = new AbortController();
    const abandoned = local.post("first", controller.signal).then(
      () => false,
      () => true
    );
    await admitted.promise;
    controller.abort();
    expect(await abandoned).toBe(true);
    const queued = local.post("second");
    await tick();
    const usage = await local.proxy.finalize();
    expect((await queued).status).toBe(410);
    expect(cancelled).toBe(true);
    expect(calls).toBe(1);
    expect(local.proxy.run.activeRequest).toBe(false);
    expect(usage).toMatchObject({
      finalized: true,
      generatedTokens: null,
      inFlightRequests: 0,
      mandatoryUsageKnown: false,
    });
    expect(usage.requests).toHaveLength(1);
    expect(usage.requests[0]).toMatchObject({
      generatedTokens: null,
      kind: "transport-error",
    });
    const saved = JSON.parse(
      await readFile(join(local.root, "wire/native-usage-final.json"), "utf8")
    );
    expect(saved).toEqual(usage);
  } finally {
    await local.proxy.close();
  }
});

test("client disconnect cannot release a slot while the upstream response body is incomplete", async () => {
  const admitted = deferred<void>();
  let calls = 0;
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const local = await fixture(async () => {
    calls++;
    if (calls !== 1) {
      return reply(30, 11);
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        body = controller;
      },
    });
    body.enqueue(new TextEncoder().encode('{"choices":[],"usage":'));
    admitted.resolve();
    return new Response(stream, {
      headers: { "content-type": "application/json" },
    });
  });
  let followup: Promise<Response> | undefined;
  let closed = false;
  const completeBody = () => {
    if (closed) {
      return;
    }
    closed = true;
    body.enqueue(
      new TextEncoder().encode('{"prompt_tokens":12,"completion_tokens":7}}')
    );
    body.close();
  };
  try {
    const controller = new AbortController();
    const abandoned = local.post("first", controller.signal).then(
      () => false,
      () => true
    );
    await admitted.promise;
    controller.abort();
    expect(await abandoned).toBe(true);
    let settled = false;
    followup = local.post("second");
    void followup.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await tick();
    expect(calls).toBe(1);
    expect(settled).toBe(false);
    completeBody();
    expect((await followup).status).toBe(200);
    const usage = await local.proxy.finalize();
    expect(usage.mandatoryUsageKnown).toBe(true);
    expect(usage.generatedTokens).toBe(18);
    expect(calls).toBe(2);
  } finally {
    completeBody();
    await followup?.catch(() => undefined);
    await local.proxy.close();
  }
});
