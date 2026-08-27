import { afterEach, describe, expect, mock, test } from "bun:test";
import { ProviderCapabilityError } from "../errors";
import {
  cloudflareAudioTranscriptionExecutor,
  fireworksAudioTranscriptionExecutor,
  geminiAudioTranscriptionExecutor,
  normalizeAudioTranscriptionInput,
  normalizeAudioTranscriptionOutput,
  ollamaAudioTranscriptionExecutor,
  openAIAudioTranscriptionExecutor,
  openRouterAudioTranscriptionExecutor,
  xAIAudioTranscriptionExecutor,
} from "./audio-transcription";

const instance = {
  apiKey: "secret",
  createdAt: "2026-08-27T00:00:00.000Z",
  id: "provider-test",
  label: "Test provider",
  type: "openai" as const,
};
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("audio transcription DTO validation", () => {
  test("normalizes binary input and trims metadata", () => {
    const source = new Uint8Array([1, 2, 3]);
    const normalized = normalizeAudioTranscriptionInput({
      bytes: source,
      filename: " voice.ogg ",
      mediaType: " AUDIO/OGG ",
    });

    expect(normalized).toEqual({
      bytes: new Uint8Array([1, 2, 3]),
      filename: "voice.ogg",
      mediaType: "audio/ogg",
    });
    expect(normalized.bytes).not.toBe(source);
  });

  test("rejects empty, non-binary, and non-audio inputs", () => {
    expect(() =>
      normalizeAudioTranscriptionInput({
        bytes: "base64",
        filename: "voice.ogg",
        mediaType: "audio/ogg",
      })
    ).toThrow("must be binary data");
    expect(() =>
      normalizeAudioTranscriptionInput({
        bytes: new Uint8Array(),
        filename: "voice.ogg",
        mediaType: "audio/ogg",
      })
    ).toThrow("input is empty");
    expect(() =>
      normalizeAudioTranscriptionInput({
        bytes: new Uint8Array([1]),
        filename: "voice.txt",
        mediaType: "text/plain",
      })
    ).toThrow("media type");
  });

  test("normalizes output and rejects empty provider responses", () => {
    expect(normalizeAudioTranscriptionOutput({ text: " hello " })).toEqual({
      text: "hello",
    });
    expect(() => normalizeAudioTranscriptionOutput({ text: "  " })).toThrow(
      "returned empty text"
    );
    expect(() => normalizeAudioTranscriptionOutput("hello")).toThrow(
      "must be an object"
    );
  });
});

describe("audio transcription executors", () => {
  test("posts normalized multipart input through the OpenAI adapter", async () => {
    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(
          "https://transcription.example/v1/audio/transcriptions"
        );
        expect(init?.method).toBe("POST");
        const headers = init?.headers as Record<string, string>;
        expect(headers.Authorization).toBe("Bearer secret");
        expect(init?.body).toBeInstanceOf(FormData);
        const formData = init?.body as FormData;
        expect(formData.get("model")).toBe("whisper-1");
        expect(formData.get("file")).toBeInstanceOf(Blob);
        return Response.json({ text: " unit transcript " });
      }
    ) as unknown as typeof fetch;

    await expect(
      openAIAudioTranscriptionExecutor(
        {
          apiKey: "secret",
          instance: {
            ...instance,
            baseUrl: "https://transcription.example/v1/",
          },
          model: "whisper-1",
        },
        {
          bytes: new Uint8Array([1, 2, 3]),
          filename: "voice.ogg",
          mediaType: "audio/ogg",
        }
      )
    ).resolves.toEqual({ text: "unit transcript" });
  });

  test("posts Fireworks whisper-v3 to the dedicated audio host", async () => {
    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(
          "https://audio-prod.api.fireworks.ai/v1/audio/transcriptions"
        );
        const formData = init?.body as FormData;
        expect(formData.get("model")).toBe("whisper-v3");
        return Response.json({ text: " fireworks transcript " });
      }
    ) as unknown as typeof fetch;

    await expect(
      fireworksAudioTranscriptionExecutor(
        { apiKey: "secret", instance, model: "whisper-v3" },
        {
          bytes: new Uint8Array([1, 2, 3]),
          filename: "voice.mp3",
          mediaType: "audio/mpeg",
        }
      )
    ).resolves.toEqual({ text: "fireworks transcript" });
  });

  test("posts Cloudflare whisper as a binary Workers AI run", async () => {
    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(
          "https://api.cloudflare.com/client/v4/accounts/abc123/ai/run/@cf/openai/whisper"
        );
        expect(init?.body).toBeInstanceOf(Uint8Array);
        expect(new Headers(init?.headers).get("Content-Type")).toBe(
          "audio/mpeg"
        );
        return Response.json({
          result: { text: " cloudflare transcript " },
          success: true,
        });
      }
    ) as unknown as typeof fetch;

    await expect(
      cloudflareAudioTranscriptionExecutor(
        {
          apiKey: "secret",
          instance: {
            ...instance,
            baseUrl:
              "https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1",
            type: "cloudflare",
          },
          model: "@cf/openai/whisper",
        },
        {
          bytes: new Uint8Array([1, 2, 3]),
          filename: "voice.mp3",
          mediaType: "audio/mpeg",
        }
      )
    ).resolves.toEqual({ text: "cloudflare transcript" });
  });

  test("posts Cloudflare whisper-tiny-en as binary, not turbo JSON", async () => {
    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toContain("@cf/openai/whisper-tiny-en");
        expect(init?.body).toBeInstanceOf(Uint8Array);
        expect(new Headers(init?.headers).get("Content-Type")).toBe(
          "audio/mpeg"
        );
        return Response.json({
          result: { text: " tiny transcript " },
          success: true,
        });
      }
    ) as unknown as typeof fetch;

    await expect(
      cloudflareAudioTranscriptionExecutor(
        {
          apiKey: "secret",
          instance: {
            ...instance,
            baseUrl:
              "https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1",
            type: "cloudflare",
          },
          model: "@cf/openai/whisper-tiny-en",
        },
        {
          bytes: new Uint8Array([1, 2, 3]),
          filename: "voice.mp3",
          mediaType: "audio/mpeg",
        }
      )
    ).resolves.toEqual({ text: "tiny transcript" });
  });

  test("posts OpenRouter transcription as JSON input_audio", async () => {
    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(
          "https://openrouter.ai/api/v1/audio/transcriptions"
        );
        expect(new Headers(init?.headers).get("Content-Type")).toBe(
          "application/json"
        );
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          input_audio?: { format?: string };
          model?: string;
        };
        expect(body.model).toBe("openai/whisper-large-v3");
        expect(body.input_audio?.format).toBe("mp3");
        return Response.json({ text: " openrouter transcript " });
      }
    ) as unknown as typeof fetch;

    await expect(
      openRouterAudioTranscriptionExecutor(
        {
          apiKey: "secret",
          instance: { ...instance, type: "openrouter" },
          model: "openai/whisper-large-v3",
        },
        {
          bytes: new Uint8Array([1, 2, 3]),
          filename: "voice.mp3",
          mediaType: "audio/mpeg",
        }
      )
    ).resolves.toEqual({ text: "openrouter transcript" });
  });

  test("posts xAI speech-to-text without a model field", async () => {
    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe("https://api.x.ai/v1/stt");
        const formData = init?.body as FormData;
        expect(formData.get("model")).toBeNull();
        expect(formData.get("file")).toBeInstanceOf(Blob);
        return Response.json({ text: " xai transcript " });
      }
    ) as unknown as typeof fetch;

    await expect(
      xAIAudioTranscriptionExecutor(
        {
          apiKey: "secret",
          instance: { ...instance, type: "xai" },
          model: "grok-stt",
        },
        {
          bytes: new Uint8Array([1, 2, 3]),
          filename: "voice.mp3",
          mediaType: "audio/mpeg",
        }
      )
    ).resolves.toEqual({ text: "xai transcript" });
  });

  test("lets local Ollama transcribe without an API key", async () => {
    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(
          "http://localhost:11434/v1/audio/transcriptions"
        );
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "Bearer ollama"
        );
        return Response.json({ text: " ollama transcript " });
      }
    ) as unknown as typeof fetch;

    await expect(
      ollamaAudioTranscriptionExecutor(
        {
          apiKey: "",
          instance: {
            ...instance,
            hostMode: "local",
            type: "ollama",
          },
          model: "gemma4",
        },
        {
          bytes: new Uint8Array([1, 2, 3]),
          filename: "voice.wav",
          mediaType: "audio/wav",
        }
      )
    ).resolves.toEqual({ text: "ollama transcript" });
  });

  test("surface structured missing-credential errors before network access", async () => {
    const context = { apiKey: "", instance, model: "transcribe-model" };
    const input = {
      bytes: new Uint8Array([1]),
      filename: "voice.ogg",
      mediaType: "audio/ogg",
    };

    for (const executor of [
      openAIAudioTranscriptionExecutor,
      geminiAudioTranscriptionExecutor,
      fireworksAudioTranscriptionExecutor,
      cloudflareAudioTranscriptionExecutor,
      openRouterAudioTranscriptionExecutor,
      xAIAudioTranscriptionExecutor,
    ]) {
      try {
        await executor(context, input);
        throw new Error("expected executor to reject missing credentials");
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderCapabilityError);
        expect((error as ProviderCapabilityError).code).toBe(
          "CAPABILITY_CREDENTIALS_MISSING"
        );
      }
    }
  });
});
