/**
 * Cloudflare Workers AI cassette tests.
 *
 * Re-record with:
 * LLM_VCR_MODE=record CLOUDFLARE_API_KEY=... CLOUDFLARE_ACCOUNT_ID=... \
 *   bun test apps/server/src/providers/cloudflare/llm.test.ts
 */
import { expect, test } from "bun:test";
import {
  cassetteFilePath,
  loadCassette,
  normalizeCassetteExchanges,
  withMswCassette,
} from "../../testing/llm-msw-cassette";
import { createCloudflareProvider } from "./index";

const CHAT_CASSETTE = "cloudflare-llama-3-3-70b-chat";
const TOOL_CASSETTE = "cloudflare-llama-3-3-70b-tool-call";
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

function chatUrlFor(accountId: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;
}

async function cassetteCredentials(cassetteName: string): Promise<{
  accountId: string;
  apiKey: string;
}> {
  if (process.env.LLM_VCR_MODE?.trim().toLowerCase() === "record") {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
    const apiKey = process.env.CLOUDFLARE_API_KEY?.trim();
    if (!(accountId && apiKey)) {
      throw new Error(
        "Recording Cloudflare cassettes requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_KEY."
      );
    }
    return { accountId, apiKey };
  }

  const cassette = await loadCassette(cassetteFilePath(cassetteName));
  const recordedUrl = cassette
    ? normalizeCassetteExchanges(cassette)[0]?.request.url
    : undefined;
  if (!recordedUrl) {
    throw new Error(`Cloudflare cassette ${cassetteName} is missing.`);
  }

  const accountId = new URL(recordedUrl).pathname.split("/")[4];
  if (!accountId) {
    throw new Error(`Cloudflare cassette ${cassetteName} has an invalid URL.`);
  }

  return { accountId, apiKey: "cassette-replay-key" };
}

test("Cloudflare chat completion replays offline", async () => {
  const credentials = await cassetteCredentials(CHAT_CASSETTE);
  const result = await withMswCassette(
    CHAT_CASSETTE,
    () =>
      createCloudflareProvider({ ...credentials, model: MODEL }).generateChat({
        messages: [
          { content: "Say hello in one short sentence.", role: "user" },
        ],
        system: "You are a terse assistant.",
      }),
    { url: chatUrlFor(credentials.accountId) }
  );

  expect(result.content).toBe("Hello.");
  expect(result.usage).toEqual({
    inputTokens: 48,
    outputTokens: 3,
    totalTokens: 51,
  });
});

test("Cloudflare tool call replays offline", async () => {
  const credentials = await cassetteCredentials(TOOL_CASSETTE);
  const result = await withMswCassette(
    TOOL_CASSETTE,
    () =>
      createCloudflareProvider({ ...credentials, model: MODEL }).generateChat({
        messages: [
          {
            content: "What is the weather in Jakarta? Use the weather tool.",
            role: "user",
          },
        ],
        system: "You are a terse assistant.",
        tools: [
          {
            description: "Get the current weather for a city.",
            name: "get_weather",
            parameters: {
              properties: { city: { type: "string" } },
              type: "object",
            },
          },
        ],
      }),
    { url: chatUrlFor(credentials.accountId) }
  );

  expect(result.toolCalls).toEqual([
    {
      arguments: { city: "Jakarta" },
      id: "call_1787153147514",
      name: "get_weather",
    },
  ]);
});
