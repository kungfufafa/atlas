import type {
  ProfilePackImportResponse,
  ProfilePackPreviewResponse,
} from "@atlas/core";
import { AtlasApiError, reportError } from "@atlas/core";
import { createRoute, z } from "@hono/zod-openapi";
import {
  createProfilePackExport,
  decodeProfilePackRequestData,
  importProfilePack,
  previewProfilePackImport,
} from "../../services/profile-portability";
import type { ServerOptions } from "../context";
import {
  requireActiveOrgIdFromContext,
  requireOrgAdminOrPlatformAdminFromContext,
} from "../org-guards";
import { errorResponse, json } from "../shared";
import type { HonoApp } from "../types";
import {
  PROFILE_PACK_BODY_RETRY_AFTER_SECONDS,
  readProfilePackJsonBody,
  tryAcquireProfilePackBodyRead,
} from "./profile-portability-body";

export function registerProfilePortabilityRoutes(
  app: HonoApp,
  options: ServerOptions
): void {
  const errorSchema = z
    .object({ error: z.string() })
    .openapi("ApiErrorResponse");
  const previewRequestSchema = z
    .object({ data: z.string(), name: z.string().optional() })
    .openapi("PreviewProfilePackImportRequest");
  const importRequestSchema = z
    .object({
      confirm: z.boolean(),
      data: z.string(),
      name: z.string().optional(),
    })
    .openapi("ProfilePackImportRequest");
  const previewResponseSchema = z
    .object({})
    .passthrough()
    .openapi("ProfilePackPreviewResponse");
  const importResponseSchema = z
    .object({})
    .passthrough()
    .openapi("ProfilePackImportResponse");

  app.openAPIRegistry.registerPath(
    createRoute({
      method: "get",
      operationId: "exportProfilePack",
      path: "/v1/profiles/{profileId}/pack/export",
      request: {
        params: z.object({
          profileId: z
            .string()
            .openapi({ param: { in: "path", name: "profileId" } }),
        }),
      },
      responses: {
        200: {
          content: {
            "application/zip": {
              schema: z.string().openapi({ format: "binary", type: "string" }),
            },
          },
          description: "Profile pack ZIP",
        },
        400: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
        403: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
        404: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
        429: {
          content: { "application/json": { schema: errorSchema } },
          description: "Another profile pack operation is already running",
        },
        500: {
          content: { "application/json": { schema: errorSchema } },
          description: "Unexpected server error",
        },
      },
      summary: "Export one profile as a portable ZIP",
      tags: ["Profiles"],
    })
  );

  app.openAPIRegistry.registerPath(
    createRoute({
      method: "post",
      operationId: "previewProfilePackImport",
      path: "/v1/profiles/pack/import/preview",
      request: {
        body: {
          content: {
            "application/json": { schema: previewRequestSchema },
          },
          required: true,
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: previewResponseSchema },
          },
          description: "Profile pack import preview",
        },
        400: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
        403: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
        413: {
          content: { "application/json": { schema: errorSchema } },
          description: "Archive too large",
        },
        429: {
          content: { "application/json": { schema: errorSchema } },
          description: "Too many concurrent profile pack uploads",
        },
        500: {
          content: { "application/json": { schema: errorSchema } },
          description: "Unexpected server error",
        },
      },
      summary: "Preview a profile pack import",
      tags: ["Profiles"],
    })
  );

  app.openAPIRegistry.registerPath(
    createRoute({
      method: "post",
      operationId: "importProfilePack",
      path: "/v1/profiles/pack/import",
      request: {
        body: {
          content: { "application/json": { schema: importRequestSchema } },
          required: true,
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: importResponseSchema } },
          description: "Profile pack imported",
        },
        400: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
        403: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
        409: {
          content: { "application/json": { schema: errorSchema } },
          description: "Conflict",
        },
        413: {
          content: { "application/json": { schema: errorSchema } },
          description: "Archive too large",
        },
        429: {
          content: { "application/json": { schema: errorSchema } },
          description: "Too many concurrent profile pack uploads",
        },
        500: {
          content: { "application/json": { schema: errorSchema } },
          description: "Unexpected server error",
        },
      },
      summary: "Import a profile pack as a new unprivileged profile",
      tags: ["Profiles"],
    })
  );

  app.get("/v1/profiles/:profileId/pack/export", async (c) => {
    const auth = requireOrgAdminOrPlatformAdminFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const profileId = decodeURIComponent(c.req.param("profileId"));

    try {
      const result = await createProfilePackExport(
        requireDatabase(options),
        orgId,
        profileId,
        { includeCustomTools: auth.isPlatformAdmin }
      );
      return new Response(result.data as unknown as BodyInit, {
        headers: {
          "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="${result.filename}"`,
          "Content-Type": "application/zip",
        },
      });
    } catch (error) {
      return formatPackError(error, "export");
    }
  });

  app.post("/v1/profiles/pack/import/preview", async (c) => {
    const auth = requireOrgAdminOrPlatformAdminFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const releaseBodyRead = tryAcquireProfilePackBodyRead();
    if (!releaseBodyRead) {
      return profilePackBodyAdmissionResponse();
    }

    try {
      const parsed = previewRequestSchema.safeParse(
        await readProfilePackJsonBody(c.req.raw)
      );
      if (!parsed.success) {
        throw new AtlasApiError("Invalid profile pack request.", 400);
      }
      const body: z.infer<typeof previewRequestSchema> = parsed.data;
      const preview = await previewProfilePackImport(
        requireDatabase(options),
        orgId,
        decodeProfilePackRequestData(body.data),
        {
          availableModelIds: await getAvailableModelIds(options, orgId),
          restoreCustomTools: auth.isPlatformAdmin,
        }
      );
      return json<ProfilePackPreviewResponse>(
        body.name?.trim()
          ? { ...preview, plannedName: body.name.trim() }
          : preview
      );
    } catch (error) {
      return formatPackError(error, "preview");
    } finally {
      releaseBodyRead();
    }
  });

  app.post("/v1/profiles/pack/import", async (c) => {
    const auth = requireOrgAdminOrPlatformAdminFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const releaseBodyRead = tryAcquireProfilePackBodyRead();
    if (!releaseBodyRead) {
      return profilePackBodyAdmissionResponse();
    }

    try {
      const parsed = importRequestSchema.safeParse(
        await readProfilePackJsonBody(c.req.raw)
      );
      if (!parsed.success) {
        throw new AtlasApiError("Invalid profile pack request.", 400);
      }
      const body: z.infer<typeof importRequestSchema> = parsed.data;
      const imported = await importProfilePack(
        requireDatabase(options),
        orgId,
        decodeProfilePackRequestData(body.data),
        {
          actorUserId: auth.user.id,
          availableModelIds: await getAvailableModelIds(options, orgId),
          confirm: body.confirm,
          name: body.name,
          restoreCustomTools: auth.isPlatformAdmin,
        }
      );
      return json<ProfilePackImportResponse>(imported);
    } catch (error) {
      return formatPackError(error, "import");
    } finally {
      releaseBodyRead();
    }
  });
}

function profilePackBodyAdmissionResponse(): Response {
  return json(
    { error: "Too many profile pack uploads are being read. Try again soon." },
    429,
    new Headers({
      "Retry-After": String(PROFILE_PACK_BODY_RETRY_AFTER_SECONDS),
    })
  );
}

function requireDatabase(options: ServerOptions) {
  if (!options.databaseAdapter) {
    throw new AtlasApiError("Database is not configured.", 500);
  }
  return options.databaseAdapter;
}

async function getAvailableModelIds(
  options: ServerOptions,
  orgId: string
): Promise<ReadonlySet<string>> {
  const { models } = await options.agent.getModels(orgId);
  const ids = new Set<string>();
  for (const model of models) {
    ids.add(model.id);
    const providerId = model.providerId ?? model.provider;
    ids.add(`${providerId}::${model.id}`);
  }
  return ids;
}

function formatPackError(error: unknown, operation: string): Response {
  if (error instanceof AtlasApiError) {
    const response = errorResponse(error.message, error.status);
    if (error.status === 429) {
      response.headers.set(
        "Retry-After",
        String(PROFILE_PACK_BODY_RETRY_AFTER_SECONDS)
      );
    }
    return response;
  }
  void reportError(error, {
    source: `server.profile-portability.${operation}`,
  });
  return errorResponse("Profile pack operation failed.", 500);
}
