import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const endpoint = "https://opencode.ai/zen/go/v1";
const outputDir =
  process.env.HARNESS_PROBE_DIR ?? "/private/tmp/atlas-harness-private/probe";
const keyFile =
  process.env.HARNESS_KEY_FILE ??
  "/private/tmp/atlas-harness-private/opencode-key";
const key = (await readFile(keyFile, "utf8")).trim();
await mkdir(outputDir, { mode: 0o700, recursive: true });

async function request(path: string, body?: unknown): Promise<unknown> {
  const started = Date.now();
  const response = await fetch(`${endpoint}/${path}`, {
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "user-agent": "Atlas-Hermes-Comparison/1.0 (transport-pilot)",
      "x-opencode-session": "atlas-hermes-transport-pilot-20260906",
    },
    method: body ? "POST" : "GET",
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(90_000),
  });
  const text = (await response.text()).replaceAll(key, "[REDACTED]");
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { body: text.slice(0, 1000) };
  }
  const record = {
    elapsedMs: Date.now() - started,
    endpoint: `${endpoint}/${path}`,
    request: body ?? null,
    response: payload,
    status: response.status,
    timestamp: new Date().toISOString(),
  };
  await writeFile(
    join(outputDir, `${path.replaceAll("/", "-")}.json`),
    JSON.stringify(record, null, 2)
  );
  process.stdout.write(`${JSON.stringify(record)}\n`);
  if (!response.ok) {
    process.exit(2);
  }
  return payload;
}

const listing = (await request("models")) as { data?: Array<{ id: string }> };
const model = listing.data?.find(
  (entry) => entry.id === "deepseek-v4-flash"
)?.id;
if (!model) {
  throw new Error(
    "The advertised models do not include deepseek-v4-flash; no substitute selected."
  );
}
await request("chat/completions", {
  max_tokens: 4096,
  messages: [
    {
      content:
        "This is a transport capability check. Use the echo tool with text READY.",
      role: "user",
    },
  ],
  model,
  stream: false,
  temperature: 0.2,
  tools: [
    {
      function: {
        description: "Return the provided text.",
        name: "echo",
        parameters: {
          additionalProperties: false,
          properties: { text: { type: "string" } },
          required: ["text"],
          type: "object",
        },
      },
      type: "function",
    },
  ],
});
