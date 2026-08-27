import {
  AtlasApiError,
  type DataImportPreviewResponse,
  type PreviewDataImportRequest,
  type RestoreDataImportRequest,
  type SetupRestoreDataImportResponse,
} from "@atlas/core";
import type { DatabaseAdapter } from "@atlas/db";
import { createRoute, z } from "@hono/zod-openapi";
import {
  decodeArchiveRequestData,
  MAX_ATLAS_IMPORT_REQUEST_BYTES,
  previewAtlasDataImport,
  restoreAtlasDataImport,
} from "../../services/data-portability";
import { runSerializedBootstrapMutation } from "../bootstrap-mutation-lock";
import type { ServerOptions } from "../context";
import { errorResponse, json, readJsonWithLimit } from "../shared";
import type { HonoApp } from "../types";

const MAX_CONCURRENT_SETUP_IMPORTS = 1;
let activeSetupImports = 0;

export function registerSetupImportRoutes(
  app: HonoApp,
  options: ServerOptions
): void {
  const { databaseAdapter } = options;
  const errorSchema = z
    .object({ error: z.string() })
    .openapi("ApiErrorResponse");
  const importRequestSchema = z
    .object({
      data: z.string(),
    })
    .openapi("SetupPreviewDataImportRequest");
  const restoreRequestSchema = z
    .object({
      confirm: z.boolean(),
      data: z.string(),
    })
    .openapi("SetupRestoreDataImportRequest");
  const previewResponseSchema = z
    .object({})
    .passthrough()
    .openapi("SetupDataImportPreviewResponse");
  const restoreResponseSchema = z
    .object({})
    .passthrough()
    .openapi("SetupRestoreDataImportResponse");

  app.openAPIRegistry.registerPath(
    createRoute({
      method: "post",
      operationId: "previewSetupDataImport",
      path: "/v1/auth/setup/import/preview",
      request: {
        body: {
          content: { "application/json": { schema: importRequestSchema } },
          required: true,
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: previewResponseSchema } },
          description: "Import preview",
        },
        400: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
        408: {
          content: { "application/json": { schema: errorSchema } },
          description: "Import request timed out",
        },
        409: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
        413: {
          content: { "application/json": { schema: errorSchema } },
          description: "Import request too large",
        },
        429: {
          content: { "application/json": { schema: errorSchema } },
          description: "Import already in progress",
        },
        500: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
      },
      summary: "Preview Atlas data import during first-time setup",
      tags: ["Auth"],
    })
  );

  app.openAPIRegistry.registerPath(
    createRoute({
      method: "post",
      operationId: "restoreSetupDataImport",
      path: "/v1/auth/setup/import/restore",
      request: {
        body: {
          content: { "application/json": { schema: restoreRequestSchema } },
          required: true,
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: restoreResponseSchema } },
          description: "Import restored",
        },
        400: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
        408: {
          content: { "application/json": { schema: errorSchema } },
          description: "Import request timed out",
        },
        409: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
        413: {
          content: { "application/json": { schema: errorSchema } },
          description: "Import request too large",
        },
        429: {
          content: { "application/json": { schema: errorSchema } },
          description: "Import already in progress",
        },
        500: {
          content: { "application/json": { schema: errorSchema } },
          description: "Error",
        },
      },
      summary: "Restore Atlas data import during first-time setup",
      tags: ["Auth"],
    })
  );

  app.post("/v1/auth/setup/import/preview", async (c) => {
    if (!databaseAdapter) {
      return errorResponse("Authentication not configured", 500);
    }

    try {
      await assertSetupImportAllowed(databaseAdapter);
    } catch (error) {
      return setupImportErrorResponse(error);
    }

    const releaseImportSlot = acquireSetupImportSlot();
    try {
      const body = await readJsonWithLimit<PreviewDataImportRequest>(
        c.req.raw,
        MAX_ATLAS_IMPORT_REQUEST_BYTES,
        { timeoutMs: options.dataImportBodyReadTimeoutMs }
      );
      const preview = await previewAtlasDataImport(
        decodeArchiveRequestData(body.data)
      );
      return json<DataImportPreviewResponse>(preview);
    } catch (error) {
      return setupImportErrorResponse(error);
    } finally {
      releaseImportSlot();
    }
  });

  app.post("/v1/auth/setup/import/restore", async (c) => {
    if (!databaseAdapter) {
      return errorResponse("Authentication not configured", 500);
    }

    try {
      await assertSetupImportAllowed(databaseAdapter);
    } catch (error) {
      return setupImportErrorResponse(error);
    }

    const releaseImportSlot = acquireSetupImportSlot();
    try {
      const body = await readJsonWithLimit<RestoreDataImportRequest>(
        c.req.raw,
        MAX_ATLAS_IMPORT_REQUEST_BYTES,
        { timeoutMs: options.dataImportBodyReadTimeoutMs }
      );

      const archive = decodeArchiveRequestData(body.data);
      const result = await runSerializedBootstrapMutation(
        databaseAdapter,
        async () => {
          await assertSetupImportAllowed(databaseAdapter);
          let requiresRestart = !options.onDataRestored;
          const restore = await restoreAtlasDataImport(archive, {
            afterRestore: options.onDataRestored
              ? async () => {
                  try {
                    await options.onDataRestored?.();
                    requiresRestart = false;
                  } catch {
                    requiresRestart = true;
                  }
                }
              : undefined,
            confirm: body.confirm,
          });

          return { ...restore, requiresRestart };
        }
      );

      return json<SetupRestoreDataImportResponse>(result);
    } catch (error) {
      return setupImportErrorResponse(error);
    } finally {
      releaseImportSlot();
    }
  });
}

function acquireSetupImportSlot(): () => void {
  if (activeSetupImports >= MAX_CONCURRENT_SETUP_IMPORTS) {
    throw new AtlasApiError(
      "Another setup import is already in progress.",
      429
    );
  }
  activeSetupImports += 1;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    activeSetupImports -= 1;
  };
}

async function assertSetupImportAllowed(
  databaseAdapter: DatabaseAdapter
): Promise<void> {
  const humanUserCount = await databaseAdapter.countHumanUsers();
  if (humanUserCount > 0) {
    throw new AtlasApiError(
      "Setup import is only available before the first admin account is created.",
      409
    );
  }
}

function setupImportErrorResponse(error: unknown): Response {
  if (error instanceof AtlasApiError) {
    return errorResponse(error.message, error.status);
  }

  return errorResponse("Setup data import failed.", 500);
}
