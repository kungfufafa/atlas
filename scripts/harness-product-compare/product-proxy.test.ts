import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { comparisonModel } from "../harness-compare/proxy";
import { startProductProxy } from "./product-proxy";

test("native listener shares session budgets while denying tools and other runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-product-proxy-"));
  const keyFile = join(root, "fake-key");
  await writeFile(keyFile, "synthetic-not-a-provider-credential");
  const upstreamCalls: Array<{ url: string; body: unknown }> = [];
  const proxy = await startProductProxy({
    directory: join(root, "wire"),
    async fetchUpstream(url, init) {
      upstreamCalls.push({ body: JSON.parse(String(init.body)), url });
      await new Promise((resolve) => setTimeout(resolve, 10));
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { content: "done", role: "assistant" },
          },
        ],
        usage: { completion_tokens: 9, prompt_tokens: 20 },
      });
    },
    harness: "atlas",
    keyFile,
    runId: "two-sessions",
  });
  try {
    for (const endpoint of [
      "/tool-schemas",
      "/runs/two-sessions/tool-schemas",
      "/runs/two-sessions/tools/read_file",
      "/runs/other/v1/models",
      "/runs/other/v1/chat/completions",
      "/runs/two-sessions/v1/models?extra=1",
    ]) {
      const response = await fetch(`${proxy.url}${endpoint}`);
      expect(response.status).toBe(404);
    }
    const models = await fetch(`${proxy.url}/runs/two-sessions/v1/models`);
    const catalog = (await models.json()) as { data: Array<{ id: string }> };
    expect(catalog.data[0]?.id).toBe(comparisonModel);
    const responses = await Promise.all(
      ["training", "recall"].map((phase) =>
        fetch(`${proxy.url}/runs/two-sessions/v1/chat/completions`, {
          body: JSON.stringify({
            messages: [{ content: phase, role: "user" }],
            model: comparisonModel,
            stream: false,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        })
      )
    );
    for (const response of responses) {
      expect(response.status).toBe(200);
    }
    expect(upstreamCalls).toHaveLength(2);
    expect(proxy.run.providerRequests).toBe(2);
    expect(proxy.run.generatedTokens).toBe(18);
    expect(proxy.run.promptTokens).toBe(40);
    expect(proxy.run.toolEvents).toHaveLength(0);
    const measured = await proxy.finalize();
    expect(measured.mandatoryUsageKnown).toBe(true);
    expect(measured.generatedTokens).toBe(18);
    expect(measured.promptTokens).toBe(40);
    expect(measured.cachedTokens).toBeNull();
    const wire = await readFile(join(root, "wire/002-request.json"), "utf8");
    expect(wire).toContain("recall");
    expect(wire).not.toContain("synthetic-not-a-provider-credential");
  } finally {
    await proxy.close();
    await rm(root, { force: true, recursive: true });
  }
});

async function accountingFixture(
  fetchUpstream: (url: string, init: RequestInit) => Promise<Response>
) {
  const root = await mkdtemp(join(tmpdir(), "atlas-product-accounting-"));
  const keyFile = join(root, "fake-key");
  await writeFile(keyFile, "synthetic-not-a-provider-credential");
  const proxy = await startProductProxy({
    directory: join(root, "wire"),
    fetchUpstream,
    harness: "hermes",
    keyFile,
    runId: "accounting",
  });
  return {
    async close() {
      await proxy.close();
      await rm(root, { force: true, recursive: true });
    },
    post() {
      return fetch(`${proxy.url}/runs/accounting/v1/chat/completions`, {
        body: JSON.stringify({
          messages: [{ content: "Synthetic accounting probe", role: "user" }],
          model: comparisonModel,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
    },
    proxy,
    root,
  };
}

test("explicit zero cached tokens remain known without inventing absent cache usage", async () => {
  const fixture = await accountingFixture(async () =>
    Response.json({
      usage: {
        completion_tokens: 7,
        prompt_tokens: 12,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    })
  );
  try {
    expect((await fixture.post()).status).toBe(200);
    const measured = await fixture.proxy.finalize();
    expect(measured.mandatoryUsageKnown).toBe(true);
    expect(measured.generatedTokens).toBe(7);
    expect(measured.cachedTokens).toBe(0);
    expect(measured.finalized).toBe(true);
  } finally {
    await fixture.close();
  }
});

test("failed HTTP usage remains evidence and prevents certification after a successful native retry", async () => {
  let calls = 0;
  const fixture = await accountingFixture(async () => {
    calls += 1;
    return calls === 1
      ? Response.json(
          {
            error: { code: "synthetic_overload" },
            usage: { completion_tokens: 13, prompt_tokens: 19 },
          },
          { headers: { "retry-after": "1" }, status: 503 }
        )
      : Response.json({
          usage: { completion_tokens: 7, prompt_tokens: 12 },
        });
  });
  try {
    const failed = await fixture.post();
    expect(failed.status).toBe(503);
    expect(failed.headers.get("retry-after")).toBe("1");
    const failedBody = (await failed.json()) as {
      usage: { completion_tokens: number };
    };
    expect(failedBody.usage.completion_tokens).toBe(13);
    expect((await fixture.post()).status).toBe(200);
    const measured = await fixture.proxy.finalize();
    expect(calls).toBe(2);
    expect(measured.mandatoryUsageKnown).toBe(false);
    expect(measured.generatedTokens).toBeNull();
    expect(measured.promptTokens).toBeNull();
    expect(measured.observedGeneratedTokens).toBe(20);
    expect(measured.observedPromptTokens).toBe(31);
    expect(measured.requests[0]?.kind).toBe("http-error");
    expect(measured.requests[0]?.status).toBe(503);
    const raw = JSON.parse(
      await readFile(join(fixture.root, "wire/001-response.json"), "utf8")
    );
    expect(raw.status).toBe(503);
    expect(raw.response.usage.completion_tokens).toBe(13);
  } finally {
    await fixture.close();
  }
});

test("transport failure cannot silently become zero usage after retry success", async () => {
  let calls = 0;
  const fixture = await accountingFixture(async () => {
    calls += 1;
    if (calls === 1) {
      throw new TypeError("Synthetic connection reset");
    }
    return Response.json({
      usage: { completion_tokens: 7, prompt_tokens: 12 },
    });
  });
  try {
    expect((await fixture.post()).status).toBe(502);
    expect((await fixture.post()).status).toBe(200);
    const measured = await fixture.proxy.finalize();
    expect(measured.mandatoryUsageKnown).toBe(false);
    expect(measured.generatedTokens).toBeNull();
    expect(measured.observedGeneratedTokens).toBe(7);
    expect(measured.requests[0]).toMatchObject({
      generatedTokens: null,
      kind: "transport-error",
      promptTokens: null,
      status: null,
    });
    expect(fixture.proxy.run.providerRequests).toBe(2);
  } finally {
    await fixture.close();
  }
});

test("successful response without required usage is explicitly uncertifiable", async () => {
  const fixture = await accountingFixture(async () =>
    Response.json({ usage: { prompt_tokens: 12 } })
  );
  try {
    expect((await fixture.post()).status).toBe(200);
    const measured = await fixture.proxy.finalize();
    expect(measured.mandatoryUsageKnown).toBe(false);
    expect(measured.generatedTokens).toBeNull();
    expect(measured.observedPromptTokens).toBe(12);
    expect(fixture.proxy.run.missingUsage).toBe(true);
  } finally {
    await fixture.close();
  }
});

test("finalization cancels abandoned generation and closes its ledger before returning", async () => {
  let admitted!: () => void;
  const started = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  let cancelled = false;
  const fixture = await accountingFixture((_url, init) => {
    admitted();
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
    const response = fixture.post();
    await started;
    expect(fixture.proxy.usageEvidence.inFlightRequests).toBe(1);
    const measured = await fixture.proxy.finalize();
    expect(cancelled).toBe(true);
    expect((await response).status).toBe(502);
    expect(measured.finalized).toBe(true);
    expect(measured.inFlightRequests).toBe(0);
    expect(measured.mandatoryUsageKnown).toBe(false);
    const saved = JSON.parse(
      await readFile(join(fixture.root, "wire/native-usage-final.json"), "utf8")
    );
    expect(saved).toEqual(measured);
    expect(await fixture.proxy.finalize()).toEqual(measured);
  } finally {
    await fixture.close();
  }
});
