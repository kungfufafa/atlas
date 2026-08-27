import { afterEach, describe, expect, mock, test } from "bun:test";
import { ProviderCapabilityError } from "../errors";
import {
  geminiAudioTranscriptionExecutor,
  normalizeAudioTranscriptionInput,
  normalizeAudioTranscriptionOutput,
  openAIAudioTranscriptionExecutor,
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
