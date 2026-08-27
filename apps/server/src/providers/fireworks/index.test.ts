import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  createFireworksProvider,
  resolveFireworksAudioTranscriptionTarget,
  resolveFireworksImageGenerationTarget,
} from "./index";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }

      controller.close();
    },
  });
}

const FIREWORKS_TEST_MODEL = "accounts/fireworks/models/gpt-oss-120b";

describe("Fireworks media endpoints", () => {
  test("routes whisper models to the dedicated audio hosts", () => {
    expect(resolveFireworksAudioTranscriptionTarget("whisper-v3")).toEqual({
      model: "whisper-v3",
      url: "https://audio-prod.api.fireworks.ai/v1/audio/transcriptions",
    });
    expect(
      resolveFireworksAudioTranscriptionTarget(
        "accounts/fireworks/models/whisper-v3-turbo"
      )
    ).toEqual({
      model: "whisper-v3-turbo",
      url: "https://audio-turbo.api.fireworks.ai/v1/audio/transcriptions",
    });
  });

  test("selects sync workflows, async kontext, or size-based image_generation", () => {
    expect(
      resolveFireworksImageGenerationTarget("flux-1-schnell-fp8").url
    ).toBe(
      "https://api.fireworks.ai/inference/v1/workflows/accounts/fireworks/models/flux-1-schnell-fp8/text_to_image"
    );
    expect(
      resolveFireworksImageGenerationTarget(
        "accounts/fireworks/models/flux-kontext-pro"
      ).kind
    ).toBe("workflows_async");
    expect(
      resolveFireworksImageGenerationTarget(
        "accounts/fireworks/models/playground-v2-5-1024px-aesthetic"
      ).kind
    ).toBe("image_generation");
  });
});

describe("Fireworks provider", () => {
  test("sends reasoning_effort only when the model supports thinking", async () => {
    const fetchMock = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(
          "https://api.fireworks.ai/inference/v1/chat/completions"
        );
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          reasoning_effort?: string;
          reasoning?: unknown;
        };
        expect(body.reasoning_effort).toBe("high");
        expect(body.reasoning).toBeUndefined();
        return Response.json({
          choices: [{ message: { content: "Answer", reasoning: "Plan" } }],
        });
      }
    );

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = createFireworksProvider({
      apiKey: "test-key",
      customModels: [{ id: FIREWORKS_TEST_MODEL, supportsThinking: true }],
      model: FIREWORKS_TEST_MODEL,
    });

    const result = await provider.generateChat({
      messages: [{ content: "Think then answer", role: "user" }],
      providerOptions: { thinking: { effort: "high", enabled: true } },
      system: "You are helpful.",
    });

    expect(result.assistantMessage.thinking).toBe("Plan");
  });

  test("omits reasoning_effort when the model does not support thinking", async () => {
    const fetchMock = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          reasoning_effort?: unknown;
        };
        expect(body.reasoning_effort).toBeUndefined();
        return Response.json({
          choices: [{ message: { content: "Answer" } }],
        });
      }
    );

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = createFireworksProvider({
      apiKey: "test-key",
      customModels: [{ id: "gpt-oss-120b", supportsThinking: false }],
      model: "gpt-oss-120b",
    });

    await provider.generateChat({
      messages: [{ content: "Answer", role: "user" }],
      providerOptions: { thinking: { effort: "high", enabled: true } },
      system: "You are helpful.",
    });
  });

  test("streams thinking deltas when upstream sends reasoning content", async () => {
    const fetchMock = mock(
      async () =>
        new Response(
          streamFromChunks([
            'data: {"choices":[{"delta":{"reasoning":"Plan"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"Answer"}}]}\n\n',
            "data: [DONE]\n\n",
          ]),
          {
            headers: { "content-type": "text/event-stream" },
            status: 200,
          }
        )
    );

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = createFireworksProvider({
      apiKey: "test-key",
      customModels: [{ id: FIREWORKS_TEST_MODEL, supportsThinking: true }],
      model: FIREWORKS_TEST_MODEL,
    });

    const thinkingChunks: string[] = [];

    const result = await provider.streamChat(
      {
        messages: [{ content: "Think then answer", role: "user" }],
        providerOptions: { thinking: { effort: "medium", enabled: true } },
        system: "You are helpful.",
      },
      {
        onChunk: () => {},
        onThinking: (delta) => thinkingChunks.push(delta),
      }
    );

    expect(thinkingChunks.join("")).toBe("Plan");
    expect(result.assistantMessage.thinking).toBe("Plan");
    expect(result.content).toBe("Answer");
  });
});
