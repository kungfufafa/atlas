import type { TestProviderRequest } from "@atlas/core/contract";
import { ollamaRequiresApiKey } from "@atlas/core/ollama-provider-config";
import type { ProviderInstance } from "@atlas/core/user-config";
import { createProviderForInstance } from "../providers/create";
import { resolveInitialModel } from "./provider-instance-helpers";

export async function validateProviderConnection(
  request: TestProviderRequest
): Promise<void> {
  const type = request.type;
  const apiKey = request.apiKey?.trim() ?? "";
  const baseUrl = request.baseUrl?.trim() || undefined;
  const hostMode = request.hostMode;

  if (!apiKey && type !== "openai_compatible" && type !== "ollama") {
    throw new Error("API key is required.");
  }

  if (type === "ollama" && ollamaRequiresApiKey(hostMode) && !apiKey) {
    throw new Error("API key is required for Ollama Cloud mode.");
  }

  const probeInstance: ProviderInstance = {
    apiKey,
    createdAt: new Date(0).toISOString(),
    customModels: request.customModels,
    id: "probe-validation",
    label: "Probe",
    type,
    ...(baseUrl ? { baseUrl } : {}),
    ...(hostMode ? { hostMode } : {}),
  };

  const model = resolveInitialModel(probeInstance, request.model);
  const client = createProviderForInstance(probeInstance, model);

  if (!client) {
    throw new Error(`Could not initialize provider client for ${type}.`);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);

  try {
    await client.generateText({
      format: "text",
      prompt: "ping",
      signal: controller.signal,
      system: "Respond with ok",
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `Connection to ${type} timed out. Please check network connectivity and base URL.`
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`API key or connection validation failed: ${message}`);
  } finally {
    clearTimeout(timeoutId);
  }
}
