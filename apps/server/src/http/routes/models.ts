import {
  type AgentBrowserStatusResponse,
  AtlasApiError,
  type CapabilityCatalogResponse,
  type CapabilityMappingsResponse,
  type CapabilityOptionsResponse,
  type ComposioSettingsResponse,
  type ConfigureProviderRequest,
  type ConfigureProviderResponse,
  type CreateProviderRequest,
  type CreateProviderResponse,
  type DeleteProviderResponse,
  type DiscordSettingsResponse,
  type DiscoverModelsRequest,
  type EmailSettingsResponse,
  type GenerateImageRequest,
  type GenerateImageResponse,
  type ImageGenerationSettingsResponse,
  isSubscriptionProvider,
  type ListProvidersResponse,
  type ListTimezonesResponse,
  type ModelsResponse,
  resetWhatsAppSessionForReconnect,
  type SendEmailTestRequest,
  type SendEmailTestResponse,
  type TelegramSettingsResponse,
  type TestProviderRequest,
  type TestProviderResponse,
  type ThinkingSettingsResponse,
  type TimezoneSettingsResponse,
  type TranscribeAudioRequest,
  type TranscribeAudioResponse,
  type TranscriptionSettingsResponse,
  type UpdateCapabilityMappingRequest,
  type UpdateCapabilityMappingResponse,
  type UpdateComposioSettingsRequest,
  type UpdateDiscordSettingsRequest,
  type UpdateEmailSettingsRequest,
  type UpdateImageGenerationRequest,
  type UpdateProviderRequest,
  type UpdateProviderResponse,
  type UpdateTelegramSettingsRequest,
  type UpdateThinkingRequest,
  type UpdateTimezoneRequest,
  type UpdateTranscriptionRequest,
  type UpdateVisionRequest,
  type UpdateWhatsAppSettingsRequest,
  type VisionSettingsResponse,
  type WhatsAppSettingsResponse,
} from "@atlas/core";
import { createRoute, z } from "@hono/zod-openapi";
import { toPublicSubscriptionApiError } from "../../providers/subscription";
import { installAgentBrowser } from "../../services/agent-browser-service";
import {
  getExternalModelCatalog,
  isExternalModelCatalogId,
} from "../../services/external-model-catalog-service";
import { getTimezoneCatalog } from "../../services/timezone-catalog-service";
import { streamAgentBrowserInstall } from "../coding-harness-install-stream";
import type { ServerOptions } from "../context";
import {
  requireActiveOrgIdFromContext,
  requireNotViewerFromContext,
  requireOrgAdminOrPlatformAdminFromContext,
  requirePlatformAdminFromContext,
} from "../org-guards";
import { errorResponse, getRequestAuth, json, readJson } from "../shared";
import type { HonoApp } from "../types";

export function registerModelRoutes(
  app: HonoApp,
  options: ServerOptions
): void {
  const { agent, workerManager } = options;
  const errorSchema = z
    .object({ error: z.string() })
    .openapi("ApiErrorResponse");
  const providerIdParam = z.object({
    providerId: z
      .string()
      .openapi({ param: { in: "path", name: "providerId" } }),
  });
  const capabilityIdParam = z.object({
    capabilityId: z
      .string()
      .openapi({ param: { in: "path", name: "capabilityId" } }),
  });
  const modelsResponseSchema = z
    .object({ models: z.array(z.object({}).passthrough()) })
    .passthrough()
    .openapi("ModelsResponse");
  const providersResponseSchema = z
    .object({ providers: z.array(z.object({}).passthrough()) })
    .passthrough()
    .openapi("ListProvidersResponse");
  const capabilityCatalogResponseSchema = z
    .object({})
    .passthrough()
    .openapi("CapabilityCatalogResponse");
  const capabilityMappingsResponseSchema = z
    .object({})
    .passthrough()
    .openapi("CapabilityMappingsResponse");
  const capabilityOptionsResponseSchema = z
    .object({})
    .passthrough()
    .openapi("CapabilityOptionsResponse");
  const updateCapabilityMappingRequestSchema = z
    .object({})
    .passthrough()
    .openapi("UpdateCapabilityMappingRequest");
  const updateCapabilityMappingResponseSchema = z
    .object({})
    .passthrough()
    .openapi("UpdateCapabilityMappingResponse");
  const createProviderResponseSchema = z
    .object({})
    .passthrough()
    .openapi("CreateProviderResponse");
  const updateProviderResponseSchema = z
    .object({})
    .passthrough()
    .openapi("UpdateProviderResponse");
  const deleteProviderResponseSchema = z
    .object({})
    .passthrough()
    .openapi("DeleteProviderResponse");
  const configureProviderResponseSchema = z
    .object({})
    .passthrough()
    .openapi("ConfigureProviderResponse");
  const timezonesResponseSchema = z
    .object({ timezones: z.array(z.object({}).passthrough()) })
    .passthrough()
    .openapi("ListTimezonesResponse");
  const timezoneSettingsSchema = z
    .object({ timezone: z.string() })
    .openapi("TimezoneSettingsResponse");
  const thinkingSettingsSchema = z
    .object({})
    .passthrough()
    .openapi("ThinkingSettingsResponse");
  const visionSettingsSchema = z
    .object({})
    .passthrough()
    .openapi("VisionSettingsResponse");
  const transcriptionSettingsSchema = z
    .object({})
    .passthrough()
    .openapi("TranscriptionSettingsResponse");
  const imageGenerationSettingsSchema = z
    .object({})
    .passthrough()
    .openapi("ImageGenerationSettingsResponse");
  const generateImageRequestSchema = z
    .object({})
    .passthrough()
    .openapi("GenerateImageRequest");
  const generateImageResponseSchema = z
    .object({})
    .passthrough()
    .openapi("GenerateImageResponse");
  const transcribeAudioRequestSchema = z
    .object({})
    .passthrough()
    .openapi("TranscribeAudioRequest");
  const transcribeAudioResponseSchema = z
    .object({})
    .passthrough()
    .openapi("TranscribeAudioResponse");
  const telegramSettingsSchema = z
    .object({})
    .passthrough()
    .openapi("TelegramSettingsResponse");
  const discordSettingsSchema = z
    .object({})
    .passthrough()
    .openapi("DiscordSettingsResponse");
  const composioSettingsSchema = z
    .object({})
    .passthrough()
    .openapi("ComposioSettingsResponse");
  const emailSettingsSchema = z
    .object({})
    .passthrough()
    .openapi("EmailSettingsResponse");
  const agentBrowserStatusSchema = z
    .object({})
    .passthrough()
    .openapi("AgentBrowserStatusResponse");
  const agentBrowserInstallEventSchema = z
    .object({})
    .passthrough()
    .openapi("AgentBrowserInstallEvent");
  const sendEmailTestRequestSchema = z
    .object({ to: z.string().optional() })
    .openapi("SendEmailTestRequest");
  const sendEmailTestResponseSchema = z
    .object({ messageId: z.string(), ok: z.literal(true), to: z.string() })
    .openapi("SendEmailTestResponse");
  const updateEmailRequestSchema = z
    .object({})
    .passthrough()
    .openapi("UpdateEmailSettingsRequest");
  const whatsappSettingsSchema = z
    .object({})
    .passthrough()
    .openapi("WhatsAppSettingsResponse");
  const discoverModelsRequestSchema = z
    .object({
      apiKey: z.string().optional(),
      baseUrl: z.string().optional(),
      providerId: z.string().optional(),
    })
    .openapi("DiscoverModelsRequest");
  const testProviderRequestSchema = z
    .object({})
    .passthrough()
    .openapi("TestProviderRequest");
  const testProviderResponseSchema = z
    .object({ message: z.string(), ok: z.literal(true) })
    .openapi("TestProviderResponse");
  const createProviderRequestSchema = z
    .object({})
    .passthrough()
    .openapi("CreateProviderRequest");
  const updateProviderRequestSchema = z
    .object({})
    .passthrough()
    .openapi("UpdateProviderRequest");
  const configureProviderRequestSchema = z
    .object({})
    .passthrough()
    .openapi("ConfigureProviderRequest");
  const updateTimezoneRequestSchema = z
    .object({ timezone: z.string() })
    .openapi("UpdateTimezoneRequest");
  const updateThinkingRequestSchema = z
    .object({})
    .passthrough()
    .openapi("UpdateThinkingRequest");
  const updateVisionRequestSchema = z
    .object({ model: z.string().nullable() })
    .openapi("UpdateVisionRequest");
  const updateTelegramRequestSchema = z
    .object({})
    .passthrough()
    .openapi("UpdateTelegramSettingsRequest");
  const updateDiscordRequestSchema = z
    .object({})
    .passthrough()
    .openapi("UpdateDiscordSettingsRequest");
  const updateComposioRequestSchema = z
    .object({})
    .passthrough()
    .openapi("UpdateComposioSettingsRequest");
  const updateWhatsappRequestSchema = z
    .object({})
    .passthrough()
    .openapi("UpdateWhatsAppSettingsRequest");
  const modelQuerySchema = z.object({
    source: z.enum(["catalog", "remote"]).optional(),
  });
  const externalModelCatalogParam = z.object({
    catalogId: z.string().openapi({ param: { in: "path", name: "catalogId" } }),
  });
  const externalModelCatalogResponseSchema = z
    .object({})
    .passthrough()
    .openapi("ExternalModelCatalogResponse");

  app.openAPIRegistry.registerPath(
    createRoute({
      method: "get",
      operationId: "getExternalModelCatalog",
      path: "/v1/model-catalogs/{catalogId}",
      request: { params: externalModelCatalogParam },
      responses: {
        200: {
          content: {
            "application/json": { schema: externalModelCatalogResponseSchema },
          },
          description: "Upstream model catalog payload",
        },
        400: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
        502: {
          content: { "application/json": { schema: errorSchema } },
          description: "Upstream error",
        },
      },
      summary: "Fetch a public upstream model catalog",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "get",
      operationId: "listModels",
      path: "/v1/models",
      request: { query: modelQuerySchema },
      responses: {
        200: {
          content: { "application/json": { schema: modelsResponseSchema } },
          description: "Model catalog",
        },
      },
      summary: "List available models",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "post",
      operationId: "discoverModels",
      path: "/v1/models/discover",
      request: {
        body: {
          content: {
            "application/json": { schema: discoverModelsRequestSchema },
          },
          required: true,
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: modelsResponseSchema } },
          description: "Model catalog",
        },
      },
      summary: "Discover models from a provider base URL",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "get",
      operationId: "listProviders",
      path: "/v1/providers",
      responses: {
        200: {
          content: { "application/json": { schema: providersResponseSchema } },
          description: "Provider instances",
        },
      },
      summary: "List configured provider instances",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "get",
      operationId: "getCapabilityCatalog",
      path: "/v1/capabilities/catalog",
      responses: {
        200: {
          content: {
            "application/json": { schema: capabilityCatalogResponseSchema },
          },
          description: "Provider capability catalog",
        },
      },
      summary: "List provider capabilities exposed by installed adapters",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "get",
      operationId: "getCapabilityMappings",
      path: "/v1/capabilities/mappings",
      responses: {
        200: {
          content: {
            "application/json": { schema: capabilityMappingsResponseSchema },
          },
          description: "Workspace capability mappings",
        },
      },
      summary: "Get provider mappings for the active workspace",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "get",
      operationId: "getCapabilityOptions",
      path: "/v1/capabilities/options",
      responses: {
        200: {
          content: {
            "application/json": { schema: capabilityOptionsResponseSchema },
          },
          description: "Eligible capability targets for configured providers",
        },
      },
      summary: "List provider models available for capability routing",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "put",
      operationId: "setCapabilityMapping",
      path: "/v1/capabilities/mappings/{capabilityId}",
      request: {
        body: {
          content: {
            "application/json": {
              schema: updateCapabilityMappingRequestSchema,
            },
          },
          required: true,
        },
        params: capabilityIdParam,
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: updateCapabilityMappingResponseSchema,
            },
          },
          description: "Updated workspace capability mapping",
        },
        400: {
          content: { "application/json": { schema: errorSchema } },
          description: "Validation error",
        },
      },
      summary: "Configure a provider mapping for the active workspace",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "post",
      operationId: "testProvider",
      path: "/v1/providers/test",
      request: {
        body: {
          content: {
            "application/json": { schema: testProviderRequestSchema },
          },
          required: true,
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: testProviderResponseSchema },
          },
          description: "Provider connection verified",
        },
        400: {
          content: { "application/json": { schema: errorSchema } },
          description: "Validation error",
        },
      },
      summary: "Test a provider API key and connection reachability",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "post",
      operationId: "createProvider",
      path: "/v1/providers",
      request: {
        body: {
          content: {
            "application/json": { schema: createProviderRequestSchema },
          },
          required: true,
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: createProviderResponseSchema },
          },
          description: "Provider created",
        },
        500: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
      },
      summary: "Add a provider instance",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "patch",
      operationId: "updateProvider",
      path: "/v1/providers/{providerId}",
      request: {
        body: {
          content: {
            "application/json": { schema: updateProviderRequestSchema },
          },
          required: true,
        },
        params: providerIdParam,
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: updateProviderResponseSchema },
          },
          description: "Provider updated",
        },
        500: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
      },
      summary: "Update a provider instance",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "delete",
      operationId: "deleteProvider",
      path: "/v1/providers/{providerId}",
      request: { params: providerIdParam },
      responses: {
        200: {
          content: {
            "application/json": { schema: deleteProviderResponseSchema },
          },
          description: "Provider removed",
        },
        500: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
      },
      summary: "Remove a provider instance",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "put",
      operationId: "configureProvider",
      path: "/v1/settings/provider",
      request: {
        body: {
          content: {
            "application/json": { schema: configureProviderRequestSchema },
          },
          required: true,
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: configureProviderResponseSchema },
          },
          description: "Provider configured",
        },
        500: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
      },
      summary: "Configure the LLM provider and API key",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "get",
      operationId: "listTimezones",
      path: "/v1/timezones",
      responses: {
        200: {
          content: { "application/json": { schema: timezonesResponseSchema } },
          description: "Timezone catalog",
        },
        500: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
      },
      summary: "List available timezones",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "get",
      operationId: "getTimezone",
      path: "/v1/settings/timezone",
      responses: {
        200: {
          content: { "application/json": { schema: timezoneSettingsSchema } },
          description: "Timezone settings",
        },
        500: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
      },
      summary: "Get the user timezone",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "put",
      operationId: "setTimezone",
      path: "/v1/settings/timezone",
      request: {
        body: {
          content: {
            "application/json": { schema: updateTimezoneRequestSchema },
          },
          required: true,
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: timezoneSettingsSchema } },
          description: "Timezone settings",
        },
        500: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
      },
      summary: "Update the user timezone",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "get",
      operationId: "getThinkingSettings",
      path: "/v1/settings/thinking",
      responses: {
        200: {
          content: { "application/json": { schema: thinkingSettingsSchema } },
          description: "Thinking settings",
        },
      },
      summary: "Get thinking settings",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "put",
      operationId: "setThinkingSettings",
      path: "/v1/settings/thinking",
      request: {
        body: {
          content: {
            "application/json": { schema: updateThinkingRequestSchema },
          },
          required: true,
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: thinkingSettingsSchema } },
          description: "Thinking settings",
        },
      },
      summary: "Update thinking settings",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "get",
      operationId: "getVisionSettings",
      path: "/v1/settings/vision",
      responses: {
        200: {
          content: { "application/json": { schema: visionSettingsSchema } },
          description: "Vision settings",
        },
      },
      summary: "Get vision settings",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "put",
      operationId: "setVisionSettings",
      path: "/v1/settings/vision",
      request: {
        body: {
          content: {
            "application/json": { schema: updateVisionRequestSchema },
          },
          required: true,
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: visionSettingsSchema } },
          description: "Vision settings",
        },
        400: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
      },
      summary: "Update vision settings",
      tags: ["Models"],
    })
  );
  const updateTranscriptionRequestSchema = z
    .object({ model: z.string().nullable() })
    .openapi("UpdateTranscriptionRequest");
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "get",
      operationId: "getTranscriptionSettings",
      path: "/v1/settings/transcription",
      responses: {
        200: {
          content: {
            "application/json": { schema: transcriptionSettingsSchema },
          },
          description: "Transcription settings",
        },
      },
      summary: "Get transcription settings",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "put",
      operationId: "setTranscriptionSettings",
      path: "/v1/settings/transcription",
      request: {
        body: {
          content: {
            "application/json": { schema: updateTranscriptionRequestSchema },
          },
          required: true,
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: transcriptionSettingsSchema },
          },
          description: "Transcription settings",
        },
        400: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
      },
      summary: "Update transcription settings",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "post",
      operationId: "transcribeAudio",
      path: "/v1/audio/transcribe",
      request: {
        body: {
          content: {
            "application/json": { schema: transcribeAudioRequestSchema },
          },
          required: true,
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: transcribeAudioResponseSchema },
          },
          description: "Transcription result",
        },
        400: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
        502: {
          content: { "application/json": { schema: errorSchema } },
          description: "Upstream error",
        },
      },
      summary: "Transcribe audio with configured Whisper model",
      tags: ["Models"],
    })
  );
  const updateImageGenerationRequestSchema = z
    .object({ model: z.string().nullable() })
    .openapi("UpdateImageGenerationRequest");
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "get",
      operationId: "getImageGenerationSettings",
      path: "/v1/settings/image-generation",
      responses: {
        200: {
          content: {
            "application/json": { schema: imageGenerationSettingsSchema },
          },
          description: "Image generation settings",
        },
      },
      summary: "Get image generation settings",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "put",
      operationId: "setImageGenerationSettings",
      path: "/v1/settings/image-generation",
      request: {
        body: {
          content: {
            "application/json": { schema: updateImageGenerationRequestSchema },
          },
          required: true,
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: imageGenerationSettingsSchema },
          },
          description: "Image generation settings",
        },
        400: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
      },
      summary: "Update image generation settings",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "post",
      operationId: "generateImage",
      path: "/v1/images/generate",
      request: {
        body: {
          content: {
            "application/json": { schema: generateImageRequestSchema },
          },
          required: true,
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: generateImageResponseSchema },
          },
          description: "Generated image",
        },
        400: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
        502: {
          content: { "application/json": { schema: errorSchema } },
          description: "Upstream error",
        },
      },
      summary: "Generate an image with the configured provider capability",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "get",
      operationId: "getTelegramSettings",
      path: "/v1/settings/telegram",
      responses: {
        200: {
          content: { "application/json": { schema: telegramSettingsSchema } },
          description: "Telegram settings",
        },
      },
      summary: "Get Telegram settings",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "put",
      operationId: "setTelegramSettings",
      path: "/v1/settings/telegram",
      request: {
        body: {
          content: {
            "application/json": { schema: updateTelegramRequestSchema },
          },
          required: true,
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: telegramSettingsSchema } },
          description: "Telegram settings",
        },
        400: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
      },
      summary: "Update Telegram settings",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "post",
      operationId: "regenerateTelegramHandshake",
      path: "/v1/settings/telegram/handshake",
      responses: {
        200: {
          content: { "application/json": { schema: telegramSettingsSchema } },
          description: "Telegram settings",
        },
        400: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
      },
      summary: "Regenerate Telegram handshake",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "get",
      operationId: "getDiscordSettings",
      path: "/v1/settings/discord",
      responses: {
        200: {
          content: { "application/json": { schema: discordSettingsSchema } },
          description: "Discord settings",
        },
      },
      summary: "Get Discord settings",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "put",
      operationId: "setDiscordSettings",
      path: "/v1/settings/discord",
      request: {
        body: {
          content: {
            "application/json": { schema: updateDiscordRequestSchema },
          },
          required: true,
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: discordSettingsSchema } },
          description: "Discord settings",
        },
        400: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
      },
      summary: "Update Discord settings",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "post",
      operationId: "regenerateDiscordHandshake",
      path: "/v1/settings/discord/handshake",
      responses: {
        200: {
          content: { "application/json": { schema: discordSettingsSchema } },
          description: "Discord settings",
        },
        400: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
      },
      summary: "Regenerate Discord handshake",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "get",
      operationId: "getComposioSettings",
      path: "/v1/settings/composio",
      responses: {
        200: {
          content: { "application/json": { schema: composioSettingsSchema } },
          description: "Composio settings",
        },
      },
      summary: "Get Composio settings",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "put",
      operationId: "setComposioSettings",
      path: "/v1/settings/composio",
      request: {
        body: {
          content: {
            "application/json": { schema: updateComposioRequestSchema },
          },
          required: true,
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: composioSettingsSchema } },
          description: "Composio settings",
        },
        400: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
      },
      summary: "Update Composio settings",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "get",
      operationId: "getEmailSettings",
      path: "/v1/settings/email",
      responses: {
        200: {
          content: { "application/json": { schema: emailSettingsSchema } },
          description: "Email settings",
        },
        403: {
          content: { "application/json": { schema: errorSchema } },
          description: "Forbidden",
        },
      },
      summary: "Get email settings",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "put",
      operationId: "setEmailSettings",
      path: "/v1/settings/email",
      request: {
        body: {
          content: { "application/json": { schema: updateEmailRequestSchema } },
          required: true,
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: emailSettingsSchema } },
          description: "Email settings",
        },
        400: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
        403: {
          content: { "application/json": { schema: errorSchema } },
          description: "Forbidden",
        },
      },
      summary: "Update email settings",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "post",
      operationId: "sendEmailTest",
      path: "/v1/settings/email/test",
      request: {
        body: {
          content: {
            "application/json": { schema: sendEmailTestRequestSchema },
          },
          required: false,
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: sendEmailTestResponseSchema },
          },
          description: "Test email sent",
        },
        400: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
        403: {
          content: { "application/json": { schema: errorSchema } },
          description: "Forbidden",
        },
      },
      summary: "Send test email",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "get",
      operationId: "getAgentBrowserStatus",
      path: "/v1/settings/agent-browser",
      responses: {
        200: {
          content: { "application/json": { schema: agentBrowserStatusSchema } },
          description: "Agent-browser status",
        },
        403: {
          content: { "application/json": { schema: errorSchema } },
          description: "Forbidden",
        },
      },
      summary: "Get agent-browser readiness",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "post",
      operationId: "installAgentBrowser",
      path: "/v1/settings/agent-browser/install",
      responses: {
        200: {
          content: {
            "application/json": { schema: agentBrowserInstallEventSchema },
          },
          description: "Agent-browser install stream",
        },
        400: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
        403: {
          content: { "application/json": { schema: errorSchema } },
          description: "Forbidden",
        },
      },
      summary: "Install agent-browser CLI and Chrome",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "get",
      operationId: "getWhatsAppSettings",
      path: "/v1/settings/whatsapp",
      responses: {
        200: {
          content: { "application/json": { schema: whatsappSettingsSchema } },
          description: "WhatsApp settings",
        },
      },
      summary: "Get WhatsApp settings",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "put",
      operationId: "setWhatsAppSettings",
      path: "/v1/settings/whatsapp",
      request: {
        body: {
          content: {
            "application/json": { schema: updateWhatsappRequestSchema },
          },
          required: true,
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: whatsappSettingsSchema } },
          description: "WhatsApp settings",
        },
        400: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
      },
      summary: "Update WhatsApp settings",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "post",
      operationId: "regenerateWhatsAppPairingCode",
      path: "/v1/settings/whatsapp/pairing-code",
      responses: {
        200: {
          content: { "application/json": { schema: whatsappSettingsSchema } },
          description: "WhatsApp settings",
        },
        400: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
      },
      summary: "Regenerate WhatsApp pairing code",
      tags: ["Models"],
    })
  );
  app.openAPIRegistry.registerPath(
    createRoute({
      method: "post",
      operationId: "reconnectWhatsApp",
      path: "/v1/settings/whatsapp/reconnect",
      responses: {
        200: {
          content: { "application/json": { schema: whatsappSettingsSchema } },
          description: "WhatsApp settings",
        },
        400: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
      },
      summary: "Reconnect WhatsApp session",
      tags: ["Models"],
    })
  );

  app.get("/v1/model-catalogs/:catalogId", async (c) => {
    getRequestAuth(c);
    const catalogId = decodeURIComponent(c.req.param("catalogId"));

    if (!isExternalModelCatalogId(catalogId)) {
      return errorResponse("Unknown model catalog.", 400);
    }

    try {
      return json(await getExternalModelCatalog(catalogId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(message, 502);
    }
  });

  app.get("/v1/models", async (c) => {
    const orgId = requireActiveOrgIdFromContext(c);
    const source = c.req.query("source");
    const modelsSource =
      source === "remote" ? ("remote" as const) : ("catalog" as const);
    return json<ModelsResponse>(
      await agent.getModels(orgId, { source: modelsSource })
    );
  });

  app.post("/v1/models/discover", async (c) => {
    requireOrgAdminOrPlatformAdminFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const body = await readJson<DiscoverModelsRequest>(c.req.raw);

    try {
      const result = await agent.discoverModels(orgId, body, {
        signal: c.req.raw.signal,
      });
      return json<ModelsResponse>(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(message, 400);
    }
  });

  app.get("/v1/providers", async (c) => {
    requireOrgAdminOrPlatformAdminFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    return json<ListProvidersResponse>(await agent.listProviders(orgId));
  });

  app.get("/v1/capabilities/catalog", (c) => {
    requireOrgAdminOrPlatformAdminFromContext(c);
    return json<CapabilityCatalogResponse>(agent.getCapabilityCatalog());
  });

  app.get("/v1/capabilities/mappings", async (c) => {
    requireOrgAdminOrPlatformAdminFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    return json<CapabilityMappingsResponse>(
      await agent.getOrgCapabilityMappings(orgId)
    );
  });

  app.get("/v1/capabilities/options", async (c) => {
    requireOrgAdminOrPlatformAdminFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    return json<CapabilityOptionsResponse>(
      await agent.getOrgCapabilityOptions(orgId)
    );
  });

  app.put("/v1/capabilities/mappings/:capabilityId", async (c) => {
    requireOrgAdminOrPlatformAdminFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const capabilityId = decodeURIComponent(c.req.param("capabilityId"));
    const body = await readJson<UpdateCapabilityMappingRequest>(c.req.raw);

    try {
      return json<UpdateCapabilityMappingResponse>(
        await agent.setOrgCapabilityMapping(orgId, capabilityId, body)
      );
    } catch (error) {
      if (error instanceof AtlasApiError) {
        return errorResponse(error.message, error.status);
      }
      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(message, 400);
    }
  });

  app.post("/v1/providers/test", async (c) => {
    const auth = requireOrgAdminOrPlatformAdminFromContext(c);
    const body = await readJson<TestProviderRequest>(c.req.raw);

    try {
      const result = await agent.testProvider(body);
      return json<TestProviderResponse>(result);
    } catch (error) {
      if (isSubscriptionProvider(body.type) && !auth.isPlatformAdmin) {
        throw toPublicSubscriptionApiError(body.type, error);
      }
      if (error instanceof AtlasApiError) {
        return errorResponse(error.message, error.status);
      }
      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(message, 400);
    }
  });

  app.post("/v1/providers", async (c) => {
    const auth = requireOrgAdminOrPlatformAdminFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const body = await readJson<CreateProviderRequest>(c.req.raw);
    try {
      return json<CreateProviderResponse>(
        await agent.createProvider(orgId, body)
      );
    } catch (error) {
      if (isSubscriptionProvider(body.type) && !auth.isPlatformAdmin) {
        throw toPublicSubscriptionApiError(body.type, error);
      }
      throw error;
    }
  });

  app.patch("/v1/providers/:providerId", async (c) => {
    requireOrgAdminOrPlatformAdminFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const body = await readJson<UpdateProviderRequest>(c.req.raw);
    return json<UpdateProviderResponse>(
      await agent.updateProvider(
        orgId,
        decodeURIComponent(c.req.param("providerId")),
        body
      )
    );
  });

  app.delete("/v1/providers/:providerId", async (c) => {
    requireOrgAdminOrPlatformAdminFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    return json<DeleteProviderResponse>(
      await agent.deleteProvider(
        orgId,
        decodeURIComponent(c.req.param("providerId"))
      )
    );
  });

  app.put("/v1/settings/provider", async (c) => {
    const auth = requireOrgAdminOrPlatformAdminFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const body = await readJson<ConfigureProviderRequest>(c.req.raw);
    try {
      const result = await agent.configureProvider(orgId, body);
      return json<ConfigureProviderResponse>(result);
    } catch (error) {
      if (isSubscriptionProvider(body.provider) && !auth.isPlatformAdmin) {
        throw toPublicSubscriptionApiError(body.provider, error);
      }
      throw error;
    }
  });

  app.get("/v1/timezones", async (c) => {
    getRequestAuth(c);
    return json<ListTimezonesResponse>(await getTimezoneCatalog());
  });

  app.get("/v1/settings/timezone", async (c) => {
    requireOrgAdminOrPlatformAdminFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    return json<TimezoneSettingsResponse>({
      timezone: await agent.getOrgTimezone(orgId),
    });
  });

  app.put("/v1/settings/timezone", async (c) => {
    requireOrgAdminOrPlatformAdminFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const body = await readJson<UpdateTimezoneRequest>(c.req.raw);
    const timezone = await agent.setOrgTimezone(orgId, body.timezone);
    return json<TimezoneSettingsResponse>({ timezone });
  });

  app.get("/v1/settings/thinking", async (c) => {
    requireOrgAdminOrPlatformAdminFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    return json<ThinkingSettingsResponse>(
      await agent.getOrgThinkingSettings(orgId)
    );
  });

  app.put("/v1/settings/thinking", async (c) => {
    requireOrgAdminOrPlatformAdminFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const body = await readJson<UpdateThinkingRequest>(c.req.raw);
    return json<ThinkingSettingsResponse>(
      await agent.setOrgThinkingSettings(orgId, body)
    );
  });

  app.get("/v1/settings/vision", async (c) => {
    requireOrgAdminOrPlatformAdminFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    return json<VisionSettingsResponse>(
      await agent.getOrgVisionSettings(orgId)
    );
  });

  app.put("/v1/settings/vision", async (c) => {
    requireOrgAdminOrPlatformAdminFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const body = await readJson<UpdateVisionRequest>(c.req.raw);

    try {
      return json<VisionSettingsResponse>(
        await agent.setOrgVisionSettings(orgId, body)
      );
    } catch (error) {
      if (error instanceof AtlasApiError) {
        return errorResponse(error.message, error.status);
      }

      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(message, 400);
    }
  });

  app.get("/v1/settings/transcription", async (c) => {
    requireOrgAdminOrPlatformAdminFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    return json<TranscriptionSettingsResponse>(
      await agent.getOrgTranscriptionSettings(orgId)
    );
  });

  app.put("/v1/settings/transcription", async (c) => {
    requireOrgAdminOrPlatformAdminFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const body = await readJson<UpdateTranscriptionRequest>(c.req.raw);

    try {
      return json<TranscriptionSettingsResponse>(
        await agent.setOrgTranscriptionSettings(orgId, body)
      );
    } catch (error) {
      if (error instanceof AtlasApiError) {
        return errorResponse(error.message, error.status);
      }

      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(message, 400);
    }
  });

  app.post("/v1/audio/transcribe", async (c) => {
    requireNotViewerFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const body = await readJson<TranscribeAudioRequest>(c.req.raw);

    try {
      return json<TranscribeAudioResponse>(
        await agent.transcribeAudioForOrg(orgId, body)
      );
    } catch (error) {
      if (error instanceof AtlasApiError) {
        return errorResponse(error.message, error.status);
      }

      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(message, 400);
    }
  });

  app.get("/v1/settings/image-generation", async (c) => {
    requireOrgAdminOrPlatformAdminFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    return json<ImageGenerationSettingsResponse>(
      await agent.getOrgImageGenerationSettings(orgId)
    );
  });

  app.put("/v1/settings/image-generation", async (c) => {
    requireOrgAdminOrPlatformAdminFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const body = await readJson<UpdateImageGenerationRequest>(c.req.raw);

    try {
      return json<ImageGenerationSettingsResponse>(
        await agent.setOrgImageGenerationSettings(orgId, body)
      );
    } catch (error) {
      if (error instanceof AtlasApiError) {
        return errorResponse(error.message, error.status);
      }

      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(message, 400);
    }
  });

  app.post("/v1/images/generate", async (c) => {
    requireNotViewerFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const body = await readJson<GenerateImageRequest>(c.req.raw);

    try {
      return json<GenerateImageResponse>(
        await agent.generateImageForOrg(orgId, body)
      );
    } catch (error) {
      if (error instanceof AtlasApiError) {
        return errorResponse(error.message, error.status);
      }

      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(message, 400);
    }
  });

  app.get("/v1/settings/email", async (c) => {
    requireOrgAdminOrPlatformAdminFromContext(c);
    return json<EmailSettingsResponse>(await agent.getEmailSettings());
  });

  app.put("/v1/settings/email", async (c) => {
    requireOrgAdminOrPlatformAdminFromContext(c);
    const body = await readJson<UpdateEmailSettingsRequest>(c.req.raw);

    try {
      return json<EmailSettingsResponse>(await agent.setEmailSettings(body));
    } catch (error) {
      if (error instanceof AtlasApiError) {
        return errorResponse(error.message, error.status);
      }
      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(message, 400);
    }
  });

  app.post("/v1/settings/email/test", async (c) => {
    const auth = requireOrgAdminOrPlatformAdminFromContext(c);
    const body = await readJson<SendEmailTestRequest>(c.req.raw).catch(
      () => ({}) as SendEmailTestRequest
    );

    try {
      return json<SendEmailTestResponse>(
        await agent.sendEmailTest(body.to?.trim() || auth.user.email)
      );
    } catch (error) {
      if (error instanceof AtlasApiError) {
        return errorResponse(error.message, error.status);
      }
      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(message, 400);
    }
  });

  app.get("/v1/settings/agent-browser", async (c) => {
    requireOrgAdminOrPlatformAdminFromContext(c);
    return json<AgentBrowserStatusResponse>(
      await agent.getAgentBrowserStatus()
    );
  });

  app.post("/v1/settings/agent-browser/install", async (c) => {
    requirePlatformAdminFromContext(c);

    return streamAgentBrowserInstall(
      async (send) => {
        const status = await installAgentBrowser((progress) => {
          send({
            message: progress.message,
            type: "progress",
          });
        });

        send({
          status,
          type: "done",
        });
      },
      {
        timeoutMessage:
          "Install timed out while waiting for the agent-browser installer.",
      }
    );
  });

  app.get("/v1/settings/telegram", async (c) => {
    requireOrgAdminOrPlatformAdminFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    return json<TelegramSettingsResponse>(
      await agent.getTelegramSettings(orgId)
    );
  });

  app.put("/v1/settings/telegram", async (c) => {
    requireOrgAdminOrPlatformAdminFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const body = await readJson<UpdateTelegramSettingsRequest>(c.req.raw);

    try {
      const settings = await agent.setTelegramSettings(orgId, body);
      void workerManager
        .startWorkspaceWorker("telegram", orgId)
        .catch((workerError) => {
          console.warn("Could not start Telegram worker:", workerError);
        });
      return json<TelegramSettingsResponse>(settings);
    } catch (error) {
      if (error instanceof AtlasApiError) {
        return errorResponse(error.message, error.status);
      }
      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(message, 400);
    }
  });

  app.post("/v1/settings/telegram/handshake", async (c) => {
    requireOrgAdminOrPlatformAdminFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const auth = getRequestAuth(c);
    try {
      return json<TelegramSettingsResponse>(
        await agent.regenerateTelegramHandshake(orgId, auth.user.id)
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(message, 400);
    }
  });

  app.get("/v1/settings/discord", async (c) => {
    requireOrgAdminOrPlatformAdminFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    return json<DiscordSettingsResponse>(await agent.getDiscordSettings(orgId));
  });

  app.put("/v1/settings/discord", async (c) => {
    requireOrgAdminOrPlatformAdminFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const body = await readJson<UpdateDiscordSettingsRequest>(c.req.raw);

    try {
      const settings = await agent.setDiscordSettings(orgId, body);
      void workerManager
        .startWorkspaceWorker("discord", orgId)
        .catch((workerError) => {
          console.warn("Could not start Discord worker:", workerError);
        });
      return json<DiscordSettingsResponse>(settings);
    } catch (error) {
      if (error instanceof AtlasApiError) {
        return errorResponse(error.message, error.status);
      }
      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(message, 400);
    }
  });

  app.post("/v1/settings/discord/handshake", async (c) => {
    requireOrgAdminOrPlatformAdminFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const auth = getRequestAuth(c);
    try {
      return json<DiscordSettingsResponse>(
        await agent.regenerateDiscordHandshake(orgId, auth.user.id)
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(message, 400);
    }
  });

  app.get("/v1/settings/composio", async (c) => {
    requirePlatformAdminFromContext(c);
    return json<ComposioSettingsResponse>(await agent.getComposioSettings());
  });

  app.put("/v1/settings/composio", async (c) => {
    requirePlatformAdminFromContext(c);
    const body = await readJson<UpdateComposioSettingsRequest>(c.req.raw);

    try {
      return json<ComposioSettingsResponse>(
        await agent.setComposioSettings(body)
      );
    } catch (error) {
      if (error instanceof AtlasApiError) {
        return errorResponse(error.message, error.status);
      }
      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(message, 400);
    }
  });
  app.get("/v1/settings/whatsapp", async (c) => {
    requireOrgAdminOrPlatformAdminFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    return json<WhatsAppSettingsResponse>(
      await agent.getWhatsAppSettings(orgId)
    );
  });

  app.put("/v1/settings/whatsapp", async (c) => {
    requireOrgAdminOrPlatformAdminFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const body = await readJson<UpdateWhatsAppSettingsRequest>(c.req.raw);

    try {
      const settings = await agent.setWhatsAppSettings(orgId, body);
      void workerManager
        .startWorkspaceWorker("whatsapp", orgId)
        .catch((workerError) => {
          console.warn("Could not start WhatsApp worker:", workerError);
        });
      return json<WhatsAppSettingsResponse>(settings);
    } catch (error) {
      if (error instanceof AtlasApiError) {
        return errorResponse(error.message, error.status);
      }

      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(message, 400);
    }
  });

  app.post("/v1/settings/whatsapp/pairing-code", async (c) => {
    requireOrgAdminOrPlatformAdminFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const auth = getRequestAuth(c);
    try {
      return json<WhatsAppSettingsResponse>(
        await agent.regenerateWhatsAppPairingCode(orgId, auth.user.id)
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(message, 400);
    }
  });

  app.post("/v1/settings/whatsapp/reconnect", async (c) => {
    requireOrgAdminOrPlatformAdminFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    try {
      await workerManager
        .stopWorkspaceWorker("whatsapp", orgId)
        .catch(() => {});
      const settings = await resetWhatsAppSessionForReconnect(orgId);

      try {
        await workerManager.startWorkspaceWorker("whatsapp", orgId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResponse(
          `Session reset, but the WhatsApp worker could not start: ${message}. Start it manually from Settings.`,
          400
        );
      }

      return json<WhatsAppSettingsResponse>(settings);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(message, 400);
    }
  });
}
