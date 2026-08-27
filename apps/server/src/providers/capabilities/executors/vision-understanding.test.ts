import { describe, expect, mock, test } from "bun:test";
import type {
  GenerateChatInput,
  ProviderClient,
  ProviderInstance,
} from "@atlas/core";
import type { ProviderCapabilityExecutionContext } from "../registry";
import {
  createVisionUnderstandingExecutor,
  describeImagesWithProvider,
  normalizeVisionUnderstandingInput,
} from "./vision-understanding";

const tinyPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const instance: ProviderInstance = {
  apiKey: "secret",
  createdAt: "2026-08-27T00:00:00.000Z",
  id: "provider-vision",
  label: "Vision provider",
  type: "openai",
};

const context: ProviderCapabilityExecutionContext = {
  apiKey: "secret",
  instance,
  model: "vision-model",
};

function providerWithResponses(responses: string[]): {
  calls: GenerateChatInput[];
  provider: ProviderClient;
} {
  const calls: GenerateChatInput[] = [];
  const provider: ProviderClient = {
    async generateChat(input) {
      calls.push(input);
      const content = responses[calls.length - 1] ?? "";
      return {
        assistantMessage: { content, role: "assistant" },
        content,
        toolCalls: [],
      };
    },
    async generateText() {
      return { content: "unused" };
    },
    name: "openai",
    async streamChat(input, handlers) {
      const result = await this.generateChat(input);
      handlers.onChunk(result.content);
      return result;
    },
  };
  return { calls, provider };
}

describe("vision understanding executor", () => {
  test("describes each image through the adapter-owned chat client", async () => {
    const { calls, provider } = providerWithResponses([
      " First description. ",
      "Second description.",
    ]);
    const createChatClient = mock(() => provider);
    const execute = createVisionUnderstandingExecutor(createChatClient);

    const output = await execute(context, {
      images: [
        { data: tinyPngBase64, mediaType: "image/png", type: "image" },
        { data: "another-image", mediaType: "image/webp", type: "image" },
      ],
      instruction: "Describe only visible content.",
    });

    expect(output).toEqual({
      descriptions: ["First description.", "Second description."],
    });
    expect(createChatClient).toHaveBeenCalledWith(context);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.messages).toEqual([
      {
        content: [
          { data: tinyPngBase64, mediaType: "image/png", type: "image" },
        ],
        role: "user",
      },
    ]);
    expect(calls[0]?.system).toBe("Describe only visible content.");
  });

  test("rejects malformed and empty inputs before constructing a client", async () => {
    const createChatClient = mock(() => providerWithResponses([]).provider);
    const execute = createVisionUnderstandingExecutor(createChatClient);

    await expect(execute(context, { images: [] })).rejects.toThrow(
      "Image parsing requires at least one image input."
    );
    await expect(
      execute(context, {
        images: [{ data: "", mediaType: "image/png", type: "image" }],
      })
    ).rejects.toThrow("Image parsing input images[0].data is required.");
    expect(createChatClient).not.toHaveBeenCalled();
  });

  test("fails explicitly when a provider returns an empty description", async () => {
    const { provider } = providerWithResponses(["   "]);

    await expect(
      describeImagesWithProvider(provider, {
        images: [
          { data: tinyPngBase64, mediaType: "image/png", type: "image" },
        ],
      })
    ).rejects.toThrow("Image parsing returned an empty description.");
  });

  test("aggregates provider usage across parsed images", async () => {
    const { provider } = providerWithResponses(["One", "Two"]);
    const originalGenerateChat = provider.generateChat.bind(provider);
    provider.generateChat = async (input) => {
      const result = await originalGenerateChat(input);
      return {
        ...result,
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      };
    };

    const output = await describeImagesWithProvider(provider, {
      images: [
        { data: tinyPngBase64, mediaType: "image/png", type: "image" },
        { data: tinyPngBase64, mediaType: "image/png", type: "image" },
      ],
    });

    expect(output.usage).toEqual({
      inputTokens: 6,
      outputTokens: 4,
      totalTokens: 10,
    });
  });
});

describe("normalizeVisionUnderstandingInput", () => {
  test("trims normalized strings without accepting a non-image part", () => {
    expect(
      normalizeVisionUnderstandingInput({
        images: [
          {
            data: ` ${tinyPngBase64} `,
            mediaType: " image/png ",
            type: "image",
          },
        ],
        instruction: " Explain the image. ",
      })
    ).toEqual({
      images: [{ data: tinyPngBase64, mediaType: "image/png", type: "image" }],
      instruction: "Explain the image.",
    });

    expect(() =>
      normalizeVisionUnderstandingInput({
        images: [{ text: "not an image", type: "text" }],
      })
    ).toThrow('Image parsing input images[0] must have type "image".');
  });
});
