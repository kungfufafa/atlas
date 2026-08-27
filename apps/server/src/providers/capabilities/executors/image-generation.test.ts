import { afterEach, describe, expect, mock, test } from "bun:test";
import { ProviderCapabilityError } from "../errors";
import {
  atlasSizeToAspectRatio,
  cloudflareImageGenerationExecutor,
  fireworksImageGenerationExecutor,
  minimaxImageGenerationExecutor,
  openRouterImageGenerationExecutor,
  xAIImageGenerationExecutor,
} from "./image-generation";

const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const instance = {
  apiKey: "secret",
  createdAt: "2026-08-27T00:00:00.000Z",
  id: "provider-test",
  label: "Test provider",
  type: "openai" as const,
};

describe("image generation size mapping", () => {
  test("maps Atlas sizes to provider aspect ratios", () => {
    expect(atlasSizeToAspectRatio("1024x1024")).toBe("1:1");
    expect(atlasSizeToAspectRatio("1024x1536")).toBe("2:3");
    expect(atlasSizeToAspectRatio("1536x1024")).toBe("3:2");
    expect(atlasSizeToAspectRatio("auto", "auto")).toBe("auto");
  });
});

describe("image generation executors", () => {
  test("posts OpenRouter images to /images with aspect_ratio", async () => {
    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe("https://openrouter.ai/api/v1/images");
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          aspect_ratio?: string;
          model?: string;
        };
        expect(body.model).toBe("black-forest-labs/flux-1-schnell");
        expect(body.aspect_ratio).toBe("1:1");
        return Response.json({
          data: [{ b64_json: Buffer.from(pngBytes).toString("base64") }],
          usage: { completion_tokens: 10, prompt_tokens: 4 },
        });
      }
    ) as unknown as typeof fetch;

    const output = await openRouterImageGenerationExecutor(
      {
        apiKey: "secret",
        instance: { ...instance, type: "openrouter" },
        model: "black-forest-labs/flux-1-schnell",
      },
      { prompt: "a red circle", size: "1024x1024" }
    );
    expect(output.mediaType).toBe("image/png");
    expect(output.data).toEqual(pngBytes);
    expect(output.usage).toEqual({ inputTokens: 4, outputTokens: 10 });
  });

  test("reads MiniMax base64 payloads and rejects base_resp failures", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        base_resp: { status_code: 0, status_msg: "success" },
        data: { image_base64: [Buffer.from(pngBytes).toString("base64")] },
      })
    ) as unknown as typeof fetch;

    const output = await minimaxImageGenerationExecutor(
      {
        apiKey: "secret",
        instance: {
          ...instance,
          baseUrl: "https://api.minimax.io/v1",
          type: "minimax",
        },
        model: "image-01",
      },
      { prompt: "a red circle" }
    );
    expect(output.data).toEqual(pngBytes);

    globalThis.fetch = mock(async () =>
      Response.json({
        base_resp: { status_code: 1004, status_msg: "auth failed" },
        data: {},
      })
    ) as unknown as typeof fetch;

    await expect(
      minimaxImageGenerationExecutor(
        {
          apiKey: "secret",
          instance: {
            ...instance,
            baseUrl: "https://api.minimax.io/v1",
            type: "minimax",
          },
          model: "image-01",
        },
        { prompt: "a red circle" }
      )
    ).rejects.toThrow("1004");
  });

  test("reads Fireworks binary workflow images", async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("/text_to_image");
      return new Response(pngBytes, {
        headers: { "Content-Type": "image/png" },
        status: 200,
      });
    }) as unknown as typeof fetch;

    const output = await fireworksImageGenerationExecutor(
      {
        apiKey: "secret",
        instance: { ...instance, type: "fireworks" },
        model: "accounts/fireworks/models/flux-1-schnell-fp8",
      },
      { prompt: "a red circle" }
    );
    expect(output.mediaType).toBe("image/png");
    expect(output.data).toEqual(pngBytes);
  });

  test("reads Cloudflare JSON image envelopes", async () => {
    globalThis.fetch = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          height?: number;
          prompt?: string;
          width?: number;
        };
        expect(body.prompt).toBe("a red circle");
        expect(body.width).toBeUndefined();
        expect(body.height).toBeUndefined();
        return Response.json({
          result: { image: Buffer.from(pngBytes).toString("base64") },
          success: true,
        });
      }
    ) as unknown as typeof fetch;

    const output = await cloudflareImageGenerationExecutor(
      {
        apiKey: "secret",
        instance: {
          ...instance,
          baseUrl: "https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1",
          type: "cloudflare",
        },
        model: "@cf/black-forest-labs/flux-1-schnell",
      },
      { prompt: "a red circle" }
    );
    expect(output.data).toEqual(pngBytes);
  });

  test("sends MiniMax CN image generation to the CN host by default", async () => {
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(
        "https://api.minimaxi.com/v1/image_generation"
      );
      return Response.json({
        base_resp: { status_code: 0, status_msg: "success" },
        data: { image_base64: [Buffer.from(pngBytes).toString("base64")] },
      });
    }) as unknown as typeof fetch;

    const output = await minimaxImageGenerationExecutor(
      {
        apiKey: "secret",
        instance: {
          ...instance,
          type: "minimax_cn",
        },
        model: "image-01",
      },
      { prompt: "a red circle" }
    );
    expect(output.data).toEqual(pngBytes);
  });

  test("posts xAI images with aspect_ratio instead of OpenAI output_format", async () => {
    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe("https://api.x.ai/v1/images/generations");
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >;
        expect(body.output_format).toBeUndefined();
        expect(body.aspect_ratio).toBe("1:1");
        expect(body.response_format).toBe("b64_json");
        return Response.json({
          data: [{ b64_json: Buffer.from(pngBytes).toString("base64") }],
        });
      }
    ) as unknown as typeof fetch;

    const output = await xAIImageGenerationExecutor(
      {
        apiKey: "secret",
        instance: { ...instance, type: "xai" },
        model: "grok-imagine-image-2.0",
      },
      { prompt: "a red circle" }
    );
    expect(output.data).toEqual(pngBytes);
  });

  test("rejects missing credentials before calling the network", async () => {
    try {
      await fireworksImageGenerationExecutor(
        { apiKey: "", instance, model: "flux-1-schnell-fp8" },
        { prompt: "a red circle" }
      );
      throw new Error("expected missing credentials");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderCapabilityError);
      expect((error as ProviderCapabilityError).code).toBe(
        "CAPABILITY_CREDENTIALS_MISSING"
      );
    }
  });
});
