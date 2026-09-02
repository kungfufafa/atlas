import {
  type ArtifactPreview,
  AtlasApiError,
  sanitizeArtifactShareFilename,
} from "@atlas/core";
import type {
  ArtifactShareStatusResponse,
  PublishArtifactShareRequest,
  PublishArtifactShareResponse,
  RevokeArtifactShareResponse,
} from "@atlas/core/contract";
import { ArtifactShareService } from "../../services/artifact-share-service";
import { resolveRequestClientOrigin } from "../../services/composio-callback-url";
import type { ServerOptions } from "../context";
import {
  requireActiveOrgIdFromContext,
  requireNotViewerFromContext,
} from "../org-guards";
import { json, readJson } from "../shared";
import type { HonoApp } from "../types";
import { getWorkspaceWorkerSessionArtifactPaths } from "../workspace-worker-artifacts";

export function registerArtifactShareRoutes(
  app: HonoApp,
  options: ServerOptions
): void {
  const { authService, databaseAdapter } = options;
  if (!(databaseAdapter && authService)) {
    return;
  }

  const service = new ArtifactShareService(databaseAdapter, authService);

  app.post("/v1/profiles/:profileId/artifacts/shares", async (c) => {
    const auth = requireNotViewerFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const profileId = decodeURIComponent(c.req.param("profileId"));
    const body = await readJson<PublishArtifactShareRequest>(c.req.raw);

    if (!body.path?.trim()) {
      return json({ error: "path is required" }, 400);
    }
    const sourcePath = body.path.trim();
    if (auth.workspaceWorker) {
      const sessionId = c.req.query("sessionId")?.trim();
      if (!sessionId) {
        return json({ error: "Not found" }, 404);
      }
      const allowedPaths = await getWorkspaceWorkerSessionArtifactPaths(
        databaseAdapter,
        sessionId
      );
      if (!allowedPaths.has(sourcePath)) {
        return json({ error: "Not found" }, 404);
      }
    }

    const clientOrigin = resolveRequestClientOrigin(
      c.req.raw,
      body.clientOrigin
    );

    return json<PublishArtifactShareResponse>(
      await service.publishArtifactShare({
        orgId,
        profileId,
        request: c.req.raw,
        sourcePath,
        userId: auth.user.id,
        ...(clientOrigin ? { clientOrigin } : {}),
      }),
      201
    );
  });

  app.get("/v1/profiles/:profileId/artifacts/shares/status", async (c) => {
    requireNotViewerFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const profileId = decodeURIComponent(c.req.param("profileId"));
    const sourcePath = c.req.query("path");

    if (!sourcePath?.trim()) {
      return json({ error: "path is required" }, 400);
    }

    const status = await service.getArtifactShareStatus({
      orgId,
      profileId,
      request: c.req.raw,
      sourcePath: sourcePath.trim(),
    });

    if (!status) {
      return json<ArtifactShareStatusResponse | null>(null);
    }

    return json(status);
  });

  app.delete("/v1/profiles/:profileId/artifacts/shares/:shareId", async (c) => {
    requireNotViewerFromContext(c);
    const orgId = requireActiveOrgIdFromContext(c);
    const profileId = decodeURIComponent(c.req.param("profileId"));
    const shareId = decodeURIComponent(c.req.param("shareId"));

    return json<RevokeArtifactShareResponse>(
      await service.revokeArtifactShare({ orgId, profileId, shareId })
    );
  });

  app.get("/v1/public/artifact-shares/:token/preview", async (c) => {
    const token = decodeURIComponent(c.req.param("token"));
    const sheet = c.req.query("sheet");
    const sheetIndexRaw = c.req.query("sheetIndex");
    const sheetIndex =
      sheetIndexRaw === undefined
        ? undefined
        : Number.parseInt(sheetIndexRaw, 10);
    const range = c.req.query("range");

    try {
      const preview = await service.previewPublicArtifactShare(token, {
        range,
        sheet,
        sheetIndex: Number.isFinite(sheetIndex) ? sheetIndex : undefined,
        strategy: "semantic",
      });
      return json<ArtifactPreview>(preview);
    } catch (error) {
      if (error instanceof AtlasApiError && error.status === 404) {
        return json({ error: "Not found" }, 404);
      }

      console.error("Public artifact share preview failed:", error);
      return json({ error: "Failed to load preview" }, 500);
    }
  });

  app.get("/v1/public/artifact-shares/:token", async (c) => {
    const token = decodeURIComponent(c.req.param("token"));
    const metaOnly = c.req.query("meta") === "1";

    try {
      const { bytes, metadata } = await service.readPublicArtifactShare(token);

      if (metaOnly) {
        return json(metadata);
      }

      const downloadName = sanitizeArtifactShareFilename(metadata.filename);
      const forceDownload = c.req.query("download") === "1";
      const disposition =
        forceDownload || !metadata.inlineAllowed ? "attachment" : "inline";
      const contentType = metadata.inlineAllowed
        ? metadata.mimeType
        : metadata.mimeType.startsWith("text/")
          ? "text/plain; charset=utf-8"
          : "application/octet-stream";

      return new Response(bytes as unknown as BodyInit, {
        headers: {
          "Content-Disposition": `${disposition}; filename="${downloadName}"`,
          "Content-Type": contentType,
          "Referrer-Policy": "no-referrer",
          "X-Artifact-Filename": downloadName,
          "X-Inline-Allowed": metadata.inlineAllowed ? "1" : "0",
        },
      });
    } catch (error) {
      if (error instanceof AtlasApiError && error.status === 404) {
        return json({ error: "Not found" }, 404);
      }

      throw error;
    }
  });
}
