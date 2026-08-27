import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ProviderInstance, ProviderName, UserConfig } from "@atlas/core";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { ProviderAdapterRegistry } from "../providers/capabilities/registry";
import { setupTestConfigDir } from "../test-config-dir";
import { AgentService } from "./agent-service";

setupTestConfigDir("atlas-adapter-model-discovery-");

const SYNTHETIC_PROVIDER = "synthetic-discovery" as ProviderName;
const originalFetch = globalThis.fetch;
const originalOllamaApiKey = process.env.OLLAMA_API_KEY;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalOllamaApiKey === undefined) {
    delete process.env.OLLAMA_API_KEY;
  } else {
    process.env.OLLAMA_API_KEY = originalOllamaApiKey;
  }
});

function syntheticInstance(): ProviderInstance {
  return {
    apiKey: "stored-secret",
    baseUrl: "https://trusted.example/v1",
    createdAt: "2026-08-27T00:00:00.000Z",
    id: "synthetic-instance",
    label: "Synthetic discovery",
    type: SYNTHETIC_PROVIDER,
  };
}

function syntheticConfig(instance: ProviderInstance): UserConfig {
  return {
    defaultProviderId: instance.id,
    providers: [instance],
  };
}

describe("AgentService adapter-owned model discovery", () => {
  test("discovers models for a new adapter without provider branches in AgentService", async () => {
    const calls: Array<{ apiKey: string; baseUrl?: string }> = [];
    const registry = new ProviderAdapterRegistry();
    registry.register({
      discoverModels: async (context) => {
        calls.push({
          apiKey: context.apiKey,
          ...(context.baseUrl ? { baseUrl: context.baseUrl } : {}),
        });
        const models = [
          {
            id: "synthetic-model",
            name: "Synthetic model",
            provider: SYNTHETIC_PROVIDER,
          },
        ];
        return {
          baseUrl: context.baseUrl,
          catalog: models,
          customModels: [{ id: "synthetic-model" }],
          displayName: context.instance.label,
          models,
        };
      },
      manifest: {
        adapterApiVersion: 1,
        capabilities: {},
        manifestRevision: "test",
        provider: {
          displayName: "Synthetic discovery",
          id: SYNTHETIC_PROVIDER,
        },
        schemaVersion: 1,
      },
    });
    const service = new AgentService(
      null,
      null,
      createInMemoryDatabaseAdapter(),
      undefined,
      registry
    );
    const instance = syntheticInstance();

    const result = await service.discoverModelsForProvider(
      instance.id,
      undefined,
      syntheticConfig(instance)
    );

    expect(calls).toEqual([
      {
        apiKey: "stored-secret",
        baseUrl: "https://trusted.example/v1",
      },
    ]);
    expect(result).toMatchObject({
      baseUrl: "https://trusted.example/v1",
      currentProviderId: "synthetic-instance",
      displayName: "Synthetic discovery",
      provider: SYNTHETIC_PROVIDER,
    });
    expect(result.models.map((model) => model.id)).toEqual(["synthetic-model"]);
  });

  test("applies the endpoint credential guard before dispatching any adapter", async () => {
    let calls = 0;
    const registry = new ProviderAdapterRegistry();
    registry.register({
      discoverModels: async () => {
        calls += 1;
        return {
          catalog: [],
          displayName: null,
          models: [],
        };
      },
      manifest: {
        adapterApiVersion: 1,
        capabilities: {},
        manifestRevision: "test",
        provider: {
          displayName: "Synthetic discovery",
          id: SYNTHETIC_PROVIDER,
        },
        schemaVersion: 1,
      },
    });
    const service = new AgentService(
      null,
      null,
      createInMemoryDatabaseAdapter(),
      undefined,
      registry
    );
    const instance = syntheticInstance();

    await expect(
      service.discoverModelsForProvider(
        instance.id,
        { baseUrl: "https://changed.example/v1" },
        syntheticConfig(instance)
      )
    ).rejects.toThrow("Re-enter the API key");
    expect(calls).toBe(0);
  });

  test("preserves Ollama local discovery without requiring credentials", async () => {
    delete process.env.OLLAMA_API_KEY;
    const requests: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      requests.push(input instanceof Request ? input.url : String(input));
      return Response.json({ data: [{ id: "local-llama" }] });
    }) as unknown as typeof fetch;
    const instance: ProviderInstance = {
      apiKey: "",
      baseUrl: "http://localhost:11434/v1",
      createdAt: "2026-08-27T00:00:00.000Z",
      hostMode: "local",
      id: "ollama-local",
      label: "Ollama",
      type: "ollama",
    };
    const service = new AgentService(
      null,
      null,
      createInMemoryDatabaseAdapter()
    );

    const result = await service.discoverModelsForProvider(
      instance.id,
      undefined,
      syntheticConfig(instance)
    );

    expect(requests).toEqual(["http://localhost:11434/v1/models"]);
    expect(result.models.map((model) => model.id)).toEqual(["local-llama"]);
  });

  test("preserves Ollama Cloud API-key enforcement and forwarding", async () => {
    delete process.env.OLLAMA_API_KEY;
    const authorizations: string[] = [];
    globalThis.fetch = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        authorizations.push(
          new Headers(init?.headers).get("authorization") ?? ""
        );
        return Response.json({ data: [{ id: "cloud-llama" }] });
      }
    ) as unknown as typeof fetch;
    const instance: ProviderInstance = {
      apiKey: "",
      baseUrl: "https://8.8.8.8/v1",
      createdAt: "2026-08-27T00:00:00.000Z",
      hostMode: "cloud",
      id: "ollama-cloud",
      label: "Ollama Cloud",
      type: "ollama",
    };
    const service = new AgentService(
      null,
      null,
      createInMemoryDatabaseAdapter()
    );

    await expect(
      service.discoverModelsForProvider(
        instance.id,
        undefined,
        syntheticConfig(instance)
      )
    ).rejects.toThrow("Add an API key before discovering Ollama Cloud models");

    const result = await service.discoverModelsForProvider(
      instance.id,
      { apiKey: "cloud-secret" },
      syntheticConfig(instance)
    );

    expect(authorizations).toEqual(["Bearer cloud-secret"]);
    expect(result.models.map((model) => model.id)).toEqual(["cloud-llama"]);
  });
});
