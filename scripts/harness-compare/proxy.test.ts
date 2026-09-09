import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  comparisonLimits,
  comparisonModel,
  startComparisonProxy,
  upstreamEndpoint,
} from "./proxy";
import type { HarnessTask } from "./types";

const FAKE_KEY = "comparison-fixture-credential-not-real-12345";
const TASK: HarnessTask = {
  category: "file_transformation",
  expected: { artifacts: [], finalFacts: {} },
  family: "proxy-fixture",
  id: "proxy-fixture",
  initialFiles: { "input.txt": "source\n" },
  prompt: "Fixture task",
  seed: 0,
  split: "development",
  turns: ["Fixture task"],
};

function completion(
  usage: unknown = { completion_tokens: 1, prompt_tokens: 2 }
): Response {
  return Response.json({
    choices: [
      {
        finish_reason: "stop",
        message: { content: "done", role: "assistant" },
      },
    ],
    model: comparisonModel,
    usage,
  });
}

async function createFixture(
  upstream: (
    body: Record<string, unknown>,
    index: number
  ) => Response | Promise<Response> = () => completion()
) {
  const root = await mkdtemp(join(tmpdir(), "comparison-proxy-test-"));
  const keyFile = join(root, "fixture-key.txt");
  await writeFile(keyFile, FAKE_KEY, { mode: 0o600 });
  const sent: Array<{
    body: Record<string, unknown>;
    init: RequestInit;
    url: string;
  }> = [];
  const proxy = await startComparisonProxy(keyFile, {
    async fetchUpstream(url, init) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      sent.push({ body, init, url });
      return await upstream(body, sent.length - 1);
    },
  });
  const run = await proxy.register(
    "fixture-run",
    "atlas",
    TASK,
    join(root, "run")
  );
  const post = (overrides: Record<string, unknown> = {}) =>
    fetch(`${proxy.url}/runs/${run.id}/v1/chat/completions`, {
      body: JSON.stringify({
        messages: [{ content: "fixture request", role: "user" }],
        model: comparisonModel,
        ...overrides,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  return { post, proxy, root, run, sent };
}

test("proxy normalizes declared controls, preserves messages/tools, and redacts the complete wire ledger", async () => {
  const fixture = await createFixture(() =>
    Response.json({
      choices: [
        { message: { content: `result ${FAKE_KEY}`, role: "assistant" } },
      ],
      usage: {
        completion_tokens: 30,
        completion_tokens_details: { reasoning_tokens: 20 },
        prompt_tokens: 40,
        prompt_tokens_details: { cached_tokens: 10 },
      },
    })
  );
  try {
    const messages = [{ content: `synthetic ${FAKE_KEY}`, role: "user" }];
    const tools = [
      {
        function: { name: "fixture", parameters: { type: "object" } },
        type: "function",
      },
    ];
    const response = await fixture.post({
      max_completion_tokens: 2,
      max_tokens: 1,
      messages,
      reasoning_effort: "max",
      stream_options: { include_usage: true },
      temperature: 1.9,
      thinking: { type: "enabled" },
      tools,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(FAKE_KEY);
    expect(fixture.sent[0]?.url).toBe(`${upstreamEndpoint}/chat/completions`);
    expect(fixture.sent[0]?.body).toMatchObject({
      max_tokens: 4096,
      messages,
      model: comparisonModel,
      stream: false,
      temperature: 0.2,
      tools,
    });
    for (const field of [
      "max_completion_tokens",
      "reasoning_effort",
      "stream_options",
      "thinking",
    ]) {
      expect(fixture.sent[0]?.body).not.toHaveProperty(field);
    }
    expect(
      new Headers(fixture.sent[0]?.init.headers).get("authorization")
    ).toBe(`Bearer ${FAKE_KEY}`);
    expect(fixture.run).toMatchObject({
      budgetExceeded: false,
      cachedTokens: 10,
      generatedTokens: 30,
      missingUsage: false,
      promptTokens: 40,
      providerRequests: 1,
      providerStatuses: [200],
    });
    const requestText = await readFile(
      join(fixture.run.directory, "001-request.json"),
      "utf8"
    );
    const responseText = await readFile(
      join(fixture.run.directory, "001-response.json"),
      "utf8"
    );
    expect(requestText + responseText).not.toContain(FAKE_KEY);
    const requestLedger = JSON.parse(requestText);
    expect(requestLedger.request.max_tokens).toBe(1);
    expect(requestLedger.effective.max_tokens).toBe(4096);
    expect(JSON.parse(responseText)).toMatchObject({
      response: { usage: { completion_tokens: 30 } },
      status: 200,
    });
  } finally {
    await fixture.proxy.close();
  }
});

test("proxy admits exactly 24 provider requests and retains the rejected 25th attempt", async () => {
  const fixture = await createFixture();
  try {
    for (let index = 0; index < 24; index += 1) {
      expect((await fixture.post()).status).toBe(200);
    }
    const blocked = await fixture.post();
    expect(blocked.status).toBe(400);
    expect(await blocked.json()).toMatchObject({
      error: { code: "trial_budget_exhausted" },
    });
    expect(fixture.sent).toHaveLength(24);
    expect(fixture.run).toMatchObject({
      budgetExceeded: true,
      providerRequests: 24,
    });
    expect(
      (await readdir(fixture.run.directory)).filter((name) =>
        name.endsWith("-request.json")
      )
    ).toHaveLength(24);
    expect(
      (
        await readFile(
          join(fixture.run.directory, "budget-rejections.jsonl"),
          "utf8"
        )
      )
        .trim()
        .split("\n")
    ).toHaveLength(1);
  } finally {
    await fixture.proxy.close();
  }
});

test("proxy counts reasoning inside completion totals once and reduces the final response allowance", async () => {
  const generated = [4096, 4096, 3808];
  const fixture = await createFixture((_body, index) =>
    completion({
      completion_tokens: generated[index],
      completion_tokens_details: { reasoning_tokens: 3000 },
      prompt_tokens: 100,
    })
  );
  try {
    for (const completionTokens of generated) {
      const response = await fixture.post();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        usage: { completion_tokens: completionTokens },
      });
    }
    expect(fixture.sent.map(({ body }) => body.max_tokens)).toEqual([
      4096, 4096, 3808,
    ]);
    expect(fixture.run.generatedTokens).toBe(12_000);
    expect(fixture.run.budgetExceeded).toBe(false);
    expect((await fixture.post()).status).toBe(400);
    expect(fixture.sent).toHaveLength(3);
    expect(fixture.run.budgetExceeded).toBe(true);
  } finally {
    await fixture.proxy.close();
  }
});

for (const usage of [
  undefined,
  [],
  { completion_tokens: -1, prompt_tokens: 2 },
]) {
  test(`successful response with unusable usage is retained but cannot certify (${JSON.stringify(usage)})`, async () => {
    const fixture = await createFixture(() =>
      Response.json({ choices: [], usage })
    );
    try {
      const response = await fixture.post();
      expect(response.status).toBe(200);
      expect(fixture.run).toMatchObject({
        budgetExceeded: true,
        missingUsage: true,
      });
      expect(
        JSON.parse(
          await readFile(
            join(fixture.run.directory, "001-response.json"),
            "utf8"
          )
        )
      ).toMatchObject({ status: 200 });
      expect((await fixture.post()).status).toBe(400);
      expect(fixture.sent).toHaveLength(1);
    } finally {
      await fixture.proxy.close();
    }
  });
}

for (const returnedTokens of [4097, 12_001]) {
  test(`upstream token overrun is preserved and disqualifies certification (${returnedTokens})`, async () => {
    const fixture = await createFixture(() =>
      completion({ completion_tokens: returnedTokens, prompt_tokens: 2 })
    );
    try {
      const response = await fixture.post();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        usage: { completion_tokens: returnedTokens },
      });
      expect(fixture.run.budgetExceeded).toBe(true);
      expect((await fixture.post()).status).toBe(400);
      expect(fixture.sent).toHaveLength(1);
      expect(
        JSON.parse(
          await readFile(
            join(fixture.run.directory, "001-response.json"),
            "utf8"
          )
        )
      ).toMatchObject({ status: 200 });
    } finally {
      await fixture.proxy.close();
    }
  });
}

test("proxy preserves upstream 401 JSON and non-JSON 503 with retry headers", async () => {
  const fixture = await createFixture((_body, index) =>
    index === 0
      ? Response.json(
          { error: { code: "invalid_api_key", message: `denied ${FAKE_KEY}` } },
          { headers: { "retry-after": "9" }, status: 401 }
        )
      : new Response("upstream temporarily unavailable", {
          headers: { "content-type": "text/plain" },
          status: 503,
        })
  );
  try {
    const denied = await fixture.post();
    expect(denied.status).toBe(401);
    expect(denied.headers.get("retry-after")).toBe("9");
    expect(await denied.json()).toEqual({
      error: { code: "invalid_api_key", message: "denied [REDACTED]" },
    });
    const unavailable = await fixture.post();
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).toBe("upstream temporarily unavailable");
    expect(fixture.run).toMatchObject({
      budgetExceeded: false,
      missingUsage: false,
      providerRequests: 2,
      providerStatuses: [401, 503],
    });
    expect(
      JSON.parse(
        await readFile(join(fixture.run.directory, "001-response.json"), "utf8")
      )
    ).toMatchObject({ status: 401 });
    expect(
      JSON.parse(
        await readFile(join(fixture.run.directory, "002-response.json"), "utf8")
      )
    ).toMatchObject({
      response: "upstream temporarily unavailable",
      status: 503,
    });
  } finally {
    await fixture.proxy.close();
  }
});

test("transport failures are distinct redacted ledger entries and release the active request", async () => {
  const fixture = await createFixture(() => {
    throw new Error(`transport failed ${FAKE_KEY}`);
  });
  try {
    const response = await fixture.post();
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(FAKE_KEY);
    expect(fixture.run.activeRequest).toBe(false);
    expect(fixture.run.providerStatuses).toEqual([502]);
    const ledger = await readFile(
      join(fixture.run.directory, "001-transport-error.json"),
      "utf8"
    );
    expect(ledger).not.toContain(FAKE_KEY);
    expect(
      (await readdir(fixture.run.directory)).includes("001-response.json")
    ).toBe(false);
  } finally {
    await fixture.proxy.close();
  }
});

test("mismatched models, streaming, concurrent inference and elapsed trials never reach upstream", async () => {
  const started = Promise.withResolvers<void>();
  const released = Promise.withResolvers<Response>();
  const fixture = await createFixture(() => {
    started.resolve();
    return released.promise;
  });
  try {
    expect((await fixture.post({ model: "different-model" })).status).toBe(400);
    expect((await fixture.post({ stream: true })).status).toBe(400);
    expect(fixture.sent).toHaveLength(0);
    const first = fixture.post();
    await started.promise;
    const concurrent = await fixture.post();
    expect(await concurrent.json()).toMatchObject({
      error: { code: "concurrent_inference" },
    });
    expect(fixture.sent).toHaveLength(1);
    released.resolve(completion());
    expect((await first).status).toBe(200);
    fixture.run.startedAt = Date.now() - comparisonLimits.timeoutMs - 1;
    expect((await fixture.post()).status).toBe(400);
    expect(fixture.sent).toHaveLength(1);
    expect(fixture.run.budgetExceeded).toBe(true);
  } finally {
    released.resolve(completion());
    await fixture.proxy.close();
  }
});

test("both harness registrations receive the same shared tool schemas and execution semantics", async () => {
  const fixture = await createFixture();
  try {
    const hermes = await fixture.proxy.register(
      "hermes-run",
      "hermes",
      TASK,
      join(fixture.root, "hermes")
    );
    const outputs: unknown[] = [];
    for (const run of [fixture.run, hermes]) {
      const response = await fetch(
        `${fixture.proxy.url}/runs/${run.id}/tools/read_file`,
        {
          body: JSON.stringify({ path: "input.txt" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }
      );
      outputs.push(await response.json());
      expect(run.toolEvents).toHaveLength(1);
      expect(
        (await readFile(join(run.directory, "tool-events.jsonl"), "utf8"))
          .trim()
          .split("\n")
      ).toHaveLength(1);
    }
    expect(outputs).toEqual([
      { content: "source\n", path: "input.txt" },
      { content: "source\n", path: "input.txt" },
    ]);
    expect(
      await (await fetch(`${fixture.proxy.url}/tool-schemas`)).json()
    ).toEqual(
      await (
        await fetch(`${fixture.proxy.url}/runs/hermes-run/tool-schemas`)
      ).json()
    );
    await expect(
      fixture.proxy.register(
        "hermes-run",
        "hermes",
        TASK,
        join(fixture.root, "duplicate")
      )
    ).rejects.toThrow();
  } finally {
    await fixture.proxy.close();
  }
});
