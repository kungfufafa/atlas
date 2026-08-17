import { afterEach, describe, expect, test } from "bun:test";
import { serve } from "bun";
import { validateProviderConnection } from "./provider-validation-service";

let mockServer: ReturnType<typeof serve> | null = null;

afterEach(() => {
  mockServer?.stop(true);
  mockServer = null;
});

describe("validateProviderConnection", () => {
  test("throws error when API key is missing for key-required providers", async () => {
    await expect(
      validateProviderConnection({
        apiKey: "   ",
        type: "gemini",
      })
    ).rejects.toThrow("API key is required.");
  });

  test("throws error when API key is missing for Ollama Cloud mode", async () => {
    await expect(
      validateProviderConnection({
        apiKey: "",
        hostMode: "cloud",
        type: "ollama",
      })
    ).rejects.toThrow("API key is required for Ollama Cloud mode.");
  });

  test("discovers openai-compatible models then probes chat", async () => {
    mockServer = serve({
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/v1/models") {
          return Response.json({
            data: [
              {
                id: "qwen/qwen3.8-max-free",
                object: "model",
                owned_by: "custom",
                supported_endpoint_types: ["openai"],
                tags: "Text",
              },
            ],
            object: "list",
            success: true,
          });
        }

        if (url.pathname === "/v1/chat/completions") {
          const body = (await request.json()) as {
            model?: string;
          };
          expect(body.model).toBe("qwen/qwen3.8-max-free");
          return Response.json({
            choices: [
              {
                message: { content: "ok", role: "assistant" },
              },
            ],
            id: "chatcmpl-probe",
            object: "chat.completion",
          });
        }

        return new Response("not found", { status: 404 });
      },
      port: 0,
    });

    await validateProviderConnection({
      apiKey: "sk-test",
      baseUrl: `http://127.0.0.1:${mockServer.port}/v1`,
      type: "openai_compatible",
    });
  });

  test("retries a later discovered model when the first has no quota", async () => {
    const probed: string[] = [];
    mockServer = serve({
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/v1/models") {
          return Response.json({
            data: [
              { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free" },
              { id: "qwen/qwen3.8-max-free" },
            ],
            object: "list",
          });
        }

        if (url.pathname === "/v1/chat/completions") {
          const body = (await request.json()) as { model?: string };
          probed.push(body.model ?? "");
          if (body.model?.includes("nemotron")) {
            return Response.json(
              {
                error: {
                  message: "User's credit limit is insufficient",
                  type: "api_error",
                },
              },
              { status: 403 }
            );
          }

          return Response.json({
            choices: [{ message: { content: "ok", role: "assistant" } }],
            id: "chatcmpl-probe",
            object: "chat.completion",
          });
        }

        return new Response("not found", { status: 404 });
      },
      port: 0,
    });

    await validateProviderConnection({
      apiKey: "sk-test",
      baseUrl: `http://127.0.0.1:${mockServer.port}/v1`,
      type: "openai_compatible",
    });

    expect(probed).toContain("qwen/qwen3.8-max-free");
  });

  test("validates provider API key failure gracefully", async () => {
    await expect(
      validateProviderConnection({
        apiKey: "invalid-key-12345",
        type: "openai",
      })
    ).rejects.toThrow(/API key or connection validation failed/);
  });
});
