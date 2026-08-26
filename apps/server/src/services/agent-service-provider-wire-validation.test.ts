import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { setupTestConfigDir } from "../test-config-dir";
import { AgentService } from "./agent-service";

setupTestConfigDir("atlas-provider-wire-validation-");

const ORG_ID = "org_wire_validation";
const MODEL_ID = "responses-only-model";
const originalNodeEnv = process.env.NODE_ENV;
const originalSkipValidation = process.env.ATLAS_SKIP_PROVIDER_VALIDATION;
const originalCompatibleApiKey = process.env.OPENAI_COMPATIBLE_API_KEY;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  process.env.NODE_ENV = "production";
  delete process.env.ATLAS_SKIP_PROVIDER_VALIDATION;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env.NODE_ENV = originalNodeEnv;
  if (originalSkipValidation === undefined) {
    delete process.env.ATLAS_SKIP_PROVIDER_VALIDATION;
  } else {
    process.env.ATLAS_SKIP_PROVIDER_VALIDATION = originalSkipValidation;
  }
  if (originalCompatibleApiKey === undefined) {
    delete process.env.OPENAI_COMPATIBLE_API_KEY;
  } else {
    process.env.OPENAI_COMPATIBLE_API_KEY = originalCompatibleApiKey;
  }
});

function stubResponsesOnlyEndpoint(paths: string[]): string {
  globalThis.fetch = mock(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname !== "/v1/responses") {
        return new Response("Responses endpoint required", { status: 404 });
      }

      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      expect(body.model).toBe(MODEL_ID);
      return Response.json({
        output: [
          {
            content: [{ text: "ok", type: "output_text" }],
            id: "msg_probe",
            role: "assistant",
            status: "completed",
            type: "message",
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }
  ) as unknown as typeof fetch;

  return "https://responses-only.example/v1";
}

describe("AgentService compatible provider validation wire", () => {
  test("keeps model discovery available for local LM Studio", async () => {
    const requested: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      requested.push(url);
      return Response.json({ data: [{ id: "local-model" }] });
    }) as unknown as typeof fetch;
    const service = new AgentService(
      null,
      null,
      createInMemoryDatabaseAdapter()
    );

    const result = await service.discoverModels(ORG_ID, {
      baseUrl: "http://localhost:1234/v1",
      provider: "openai_compatible",
    });

    expect(result.models.map((model) => model.id)).toEqual(["local-model"]);
    expect(requested).toEqual(["http://localhost:1234/v1/models"]);
  });

  test("requires re-entry before an env-backed key can reach a changed endpoint", async () => {
    process.env.OPENAI_COMPATIBLE_API_KEY = "environment-secret";
    const db = createInMemoryDatabaseAdapter();
    const now = new Date().toISOString();
    await db.upsertOrgAiConfig({
      config: {
        defaultProviderId: "provider-env",
        providers: [
          {
            apiKey: "",
            baseUrl: "https://trusted.example/v1",
            createdAt: now,
            customModels: [{ default: true, id: MODEL_ID }],
            id: "provider-env",
            label: "Environment backed",
            type: "openai_compatible",
          },
        ],
      },
      orgId: ORG_ID,
      updatedAt: now,
    });
    let fetchCount = 0;
    const authorizations: string[] = [];
    globalThis.fetch = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        fetchCount += 1;
        authorizations.push(
          new Headers(init?.headers).get("authorization") ?? ""
        );
        return Response.json({ data: [{ id: MODEL_ID }] });
      }
    ) as unknown as typeof fetch;
    const service = new AgentService(null, null, db);

    await expect(
      service.discoverModels(ORG_ID, {
        baseUrl: "https://8.8.8.8/v1",
        providerId: "provider-env",
      })
    ).rejects.toThrow("Re-enter the API key");
    await expect(
      service.updateProvider(ORG_ID, "provider-env", {
        baseUrl: "https://8.8.8.8/v1",
      })
    ).rejects.toThrow("Re-enter the API key");
    expect(fetchCount).toBe(0);

    const result = await service.discoverModels(ORG_ID, {
      apiKey: "replacement-key",
      baseUrl: "https://8.8.8.8/v1",
      providerId: "provider-env",
    });
    expect(result.models.map((model) => model.id)).toEqual([MODEL_ID]);
    expect(authorizations).toEqual(["Bearer replacement-key"]);
  });

  test("uses Responses when saving a new compatible provider", async () => {
    const paths: string[] = [];
    const baseUrl = stubResponsesOnlyEndpoint(paths);
    const service = new AgentService(
      null,
      null,
      createInMemoryDatabaseAdapter()
    );

    const result = await service.createProvider(ORG_ID, {
      apiKey: "save-key",
      baseUrl,
      customModels: [{ default: true, id: MODEL_ID }],
      label: "Responses only",
      model: MODEL_ID,
      type: "openai_compatible",
      wireApi: "responses",
    });

    expect(result.provider.wireApi).toBe("responses");
    expect(paths).toEqual(["/v1/responses"]);
  });

  test("uses the stored Responses wire when replacing a key", async () => {
    const paths: string[] = [];
    const baseUrl = stubResponsesOnlyEndpoint(paths);
    const db = createInMemoryDatabaseAdapter();
    const now = new Date().toISOString();
    await db.upsertOrgAiConfig({
      config: {
        defaultProviderId: "provider-responses",
        providers: [
          {
            apiKey: "old-key",
            baseUrl,
            createdAt: now,
            customModels: [{ default: true, id: MODEL_ID }],
            id: "provider-responses",
            label: "Responses only",
            type: "openai_compatible",
            wireApi: "responses",
          },
        ],
      },
      orgId: ORG_ID,
      updatedAt: now,
    });
    const service = new AgentService(null, null, db);

    const result = await service.updateProvider(ORG_ID, "provider-responses", {
      apiKey: "new-key",
    });

    expect(result.provider.wireApi).toBe("responses");
    expect(paths).toEqual(["/v1/responses"]);
  });

  test("revalidates a Chat provider when switching to Responses without replacing its key", async () => {
    const paths: string[] = [];
    const baseUrl = stubResponsesOnlyEndpoint(paths);
    const db = createInMemoryDatabaseAdapter();
    const now = new Date().toISOString();
    await db.upsertOrgAiConfig({
      config: {
        defaultProviderId: "provider-chat",
        providers: [
          {
            apiKey: "stored-key",
            baseUrl,
            createdAt: now,
            customModels: [{ default: true, id: MODEL_ID }],
            id: "provider-chat",
            label: "Switch wire",
            type: "openai_compatible",
            wireApi: "chat",
          },
        ],
      },
      orgId: ORG_ID,
      updatedAt: now,
    });
    const service = new AgentService(null, null, db);

    const result = await service.updateProvider(ORG_ID, "provider-chat", {
      wireApi: "responses",
    });

    expect(result.provider.wireApi).toBe("responses");
    expect(paths).toEqual(["/v1/responses"]);
  });

  test("serializes concurrent provider updates without restoring stale credentials", async () => {
    const db = createInMemoryDatabaseAdapter();
    const now = new Date().toISOString();
    await db.upsertOrgAiConfig({
      config: {
        defaultProviderId: "provider-concurrent",
        providers: [
          {
            apiKey: "old-key",
            baseUrl: "https://concurrent.example/v1",
            createdAt: now,
            customModels: [{ default: true, id: MODEL_ID }],
            id: "provider-concurrent",
            label: "Concurrent",
            type: "openai_compatible",
            wireApi: "responses",
          },
        ],
      },
      orgId: ORG_ID,
      updatedAt: now,
    });

    let releaseFirstValidation: (() => void) | undefined;
    const firstValidationGate = new Promise<void>((resolve) => {
      releaseFirstValidation = resolve;
    });
    let markFirstValidationStarted: (() => void) | undefined;
    const firstValidationStarted = new Promise<void>((resolve) => {
      markFirstValidationStarted = resolve;
    });
    const authorizations: string[] = [];
    let requestCount = 0;
    globalThis.fetch = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestCount += 1;
        authorizations.push(
          new Headers(init?.headers).get("authorization") ?? ""
        );
        if (requestCount === 1) {
          markFirstValidationStarted?.();
          await firstValidationGate;
        }
        return Response.json({
          output: [
            {
              content: [{ text: "ok", type: "output_text" }],
              role: "assistant",
              type: "message",
            },
          ],
          status: "completed",
        });
      }
    ) as unknown as typeof fetch;

    const service = new AgentService(null, null, db);
    const replaceCredential = service.updateProvider(
      ORG_ID,
      "provider-concurrent",
      { apiKey: "new-key" }
    );
    await firstValidationStarted;
    const updateModels = service.updateProvider(ORG_ID, "provider-concurrent", {
      customModels: [
        { default: true, id: MODEL_ID },
        { id: "second-approved-model" },
      ],
    });
    const updateTimezone = service.setOrgTimezone(ORG_ID, "Asia/Jakarta");
    releaseFirstValidation?.();

    await Promise.all([replaceCredential, updateModels, updateTimezone]);

    const config = await service.getUserConfigForOrg(ORG_ID);
    const provider = config?.providers.find(
      (instance) => instance.id === "provider-concurrent"
    );
    expect(provider?.apiKey).toBe("new-key");
    expect(provider?.customModels?.map((model) => model.id)).toEqual([
      MODEL_ID,
      "second-approved-model",
    ]);
    expect(config?.timezone).toBe("Asia/Jakarta");
    expect(authorizations).toEqual(["Bearer new-key", "Bearer new-key"]);
  });
});
