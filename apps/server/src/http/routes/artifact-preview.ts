import type {
  ArtifactPreview,
  PreviewJob,
  PreviewManifest,
  PreviewMetadata,
  PreviewOptions,
} from "@atlas/core";
import { createRoute, z } from "@hono/zod-openapi";
import type { ServerOptions } from "../context";
import { requireActiveOrgIdFromContext } from "../org-guards";
import { json } from "../shared";
import type { HonoApp } from "../types";

export function parseCanonicalArtifactId(artifactId: string): {
  filename: string;
  profileId: string;
  revision?: number;
} {
  if (artifactId.startsWith("art_") || artifactId.startsWith("b64_")) {
    try {
      const raw = Buffer.from(
        artifactId.replace(/^(?:art_|b64_)/, ""),
        "base64url"
      ).toString("utf8");
      const parsed = JSON.parse(raw);
      if (parsed.profileId && (parsed.filename || parsed.path)) {
        return {
          filename: parsed.filename || parsed.path,
          profileId: parsed.profileId,
          revision: parsed.revision,
        };
      }
    } catch {
      // fallback
    }
  }

  if (artifactId.includes(":")) {
    const parts = artifactId.split(":");
    return {
      filename: parts.slice(1).join(":"),
      profileId: parts[0] || "default",
    };
  }

  return {
    filename: artifactId,
    profileId: "default",
  };
}

export function encodeCanonicalArtifactId(input: {
  filename: string;
  profileId: string;
  revision?: number;
}): string {
  const jsonStr = JSON.stringify(input);
  return `art_${Buffer.from(jsonStr, "utf8").toString("base64url")}`;
}

export function handleByteRangeRequest(
  bytes: Buffer,
  contentType: string,
  rangeHeader: string | null | undefined,
  downloadName: string,
  inline = false
): Response {
  const total = bytes.length;
  const disposition = inline ? "inline" : "attachment";

  if (!(rangeHeader && rangeHeader.startsWith("bytes="))) {
    // Bun's runtime Response accepts Node Buffers; the DOM `BodyInit` type used
    // for type-checking does not, so cast (safe at runtime under Bun).
    return new Response(bytes as unknown as BodyInit, {
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Disposition": `${disposition}; filename="${downloadName}"`,
        "Content-Length": String(total),
        "Content-Type": contentType,
      },
      status: 200,
    });
  }

  const parts = rangeHeader.replace(/bytes=/, "").split("-");
  const start = Number.parseInt(parts[0], 10);
  const end = parts[1] ? Number.parseInt(parts[1], 10) : total - 1;

  if (Number.isNaN(start) || start < 0 || start >= total || end < start) {
    return new Response("Requested Range Not Satisfiable", {
      headers: {
        "Content-Range": `bytes */${total}`,
      },
      status: 416,
    });
  }

  const chunkEnd = Math.min(end, total - 1);
  const chunkSize = chunkEnd - start + 1;
  const sliced = bytes.subarray(start, chunkEnd + 1);

  return new Response(sliced as unknown as BodyInit, {
    headers: {
      "Accept-Ranges": "bytes",
      "Content-Disposition": `${disposition}; filename="${downloadName}"`,
      "Content-Length": String(chunkSize),
      "Content-Range": `bytes ${start}-${chunkEnd}/${total}`,
      "Content-Type": contentType,
    },
    status: 206,
  });
}

export function registerArtifactPreviewRoutes(
  app: HonoApp,
  options: ServerOptions
): void {
  const { agent } = options;

  const errorSchema = z
    .object({ error: z.string() })
    .openapi("ApiErrorResponse");

  const previewQuerySchema = z.object({
    path: z
      .string()
      .min(1)
      .openapi({ description: "Artifact path relative to profile workspace" }),
    range: z
      .string()
      .optional()
      .openapi({ description: "Optional bounded range (e.g. A1:Z100)" }),
    revision: z
      .string()
      .optional()
      .openapi({ description: "Optional artifact revision number" }),
    sheet: z
      .string()
      .optional()
      .openapi({ description: "Optional sheet name for spreadsheet preview" }),
    sheetIndex: z
      .string()
      .optional()
      .openapi({ description: "Optional sheet index (0-based)" }),
  });

  const canonicalPreviewQuerySchema = z.object({
    range: z
      .string()
      .optional()
      .openapi({ description: "Optional bounded range (e.g. A1:Z100)" }),
    revision: z
      .string()
      .optional()
      .openapi({ description: "Optional artifact revision number" }),
    sheet: z
      .string()
      .optional()
      .openapi({ description: "Optional sheet name for spreadsheet preview" }),
    sheetIndex: z
      .string()
      .optional()
      .openapi({ description: "Optional sheet index (0-based)" }),
  });

  const inspectQuerySchema = z.object({
    path: z
      .string()
      .min(1)
      .openapi({ description: "Artifact path relative to profile workspace" }),
  });

  const profileIdParam = z.object({
    profileId: z.string().openapi({ param: { in: "path", name: "profileId" } }),
  });

  const artifactIdParam = z.object({
    artifactId: z
      .string()
      .openapi({ param: { in: "path", name: "artifactId" } }),
  });

  const artifactPreviewSchema = z
    .object({})
    .passthrough()
    .openapi("ArtifactPreviewResponse");

  const previewMetadataSchema = z
    .object({})
    .passthrough()
    .openapi("ArtifactPreviewMetadataResponse");

  // ==========================================
  // Canonical Artifact Routes (/v1/artifacts/:id)
  // ==========================================

  app.openAPIRegistry.registerPath(
    createRoute({
      method: "get",
      operationId: "getCanonicalArtifactPreview",
      path: "/v1/artifacts/{artifactId}/preview",
      request: {
        params: artifactIdParam,
        query: canonicalPreviewQuerySchema,
      },
      responses: {
        200: {
          content: { "application/json": { schema: artifactPreviewSchema } },
          description: "Canonical derived artifact preview",
        },
        404: {
          content: { "application/json": { schema: errorSchema } },
          description: "Artifact not found",
        },
      },
      summary: "Get canonical preview by artifactId",
      tags: ["Artifacts"],
    })
  );

  app.get("/v1/artifacts/:artifactId/preview", async (c) => {
    const orgId = requireActiveOrgIdFromContext(c);
    const rawArtifactId = decodeURIComponent(c.req.param("artifactId"));
    const {
      profileId,
      filename,
      revision: idRevision,
    } = parseCanonicalArtifactId(rawArtifactId);

    const sheet = c.req.query("sheet");
    const sheetIndexRaw = c.req.query("sheetIndex");
    const sheetIndex =
      sheetIndexRaw === undefined
        ? undefined
        : Number.parseInt(sheetIndexRaw, 10);
    const range = c.req.query("range");
    const revisionRaw = c.req.query("revision");
    const parsedRev =
      revisionRaw === undefined ? undefined : Number.parseInt(revisionRaw, 10);
    const revision =
      parsedRev !== undefined && Number.isFinite(parsedRev)
        ? parsedRev
        : idRevision;

    const previewOptions: PreviewOptions = {
      range,
      revision: Number.isFinite(revision) ? revision : undefined,
      sheet,
      sheetIndex: Number.isFinite(sheetIndex) ? sheetIndex : undefined,
    };

    try {
      const preview = await agent.getProfileArtifactPreview(
        orgId,
        profileId,
        filename,
        previewOptions
      );
      return json<ArtifactPreview>({
        ...preview,
        artifactId: rawArtifactId,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load preview";
      if (message.includes("not found")) {
        return json({ error: message }, 404);
      }
      return json({ error: message }, 500);
    }
  });

  app.get("/v1/artifacts/:artifactId/manifest", async (c) => {
    const orgId = requireActiveOrgIdFromContext(c);
    const rawArtifactId = decodeURIComponent(c.req.param("artifactId"));
    const {
      profileId,
      filename,
      revision: idRevision,
    } = parseCanonicalArtifactId(rawArtifactId);

    const sheet = c.req.query("sheet");
    const sheetIndexRaw = c.req.query("sheetIndex");
    const sheetIndex =
      sheetIndexRaw === undefined
        ? undefined
        : Number.parseInt(sheetIndexRaw, 10);
    const range = c.req.query("range");
    const revisionRaw = c.req.query("revision");
    const parsedRev =
      revisionRaw === undefined ? undefined : Number.parseInt(revisionRaw, 10);
    const revision =
      parsedRev !== undefined && Number.isFinite(parsedRev)
        ? parsedRev
        : idRevision;

    const previewOptions: PreviewOptions = {
      range,
      revision: Number.isFinite(revision) ? revision : undefined,
      sheet,
      sheetIndex: Number.isFinite(sheetIndex) ? sheetIndex : undefined,
    };

    try {
      const manifest = await agent.getProfileArtifactManifest(
        orgId,
        profileId,
        filename,
        previewOptions
      );
      return json<PreviewManifest>({
        ...manifest,
        artifactId: rawArtifactId,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load manifest";
      if (message.includes("not found")) {
        return json({ error: message }, 404);
      }
      return json({ error: message }, 500);
    }
  });

  app.get("/v1/artifacts/jobs/:jobId", async (c) => {
    requireActiveOrgIdFromContext(c);
    const jobId = decodeURIComponent(c.req.param("jobId"));
    const job = agent.getPreviewJob(jobId);
    if (!job) {
      return json({ error: "Preview job not found" }, 404);
    }
    return json<PreviewJob>(job);
  });

  app.get("/v1/artifacts/:artifactId", async (c) => {
    const orgId = requireActiveOrgIdFromContext(c);
    const rawArtifactId = decodeURIComponent(c.req.param("artifactId"));
    const { profileId, filename } = parseCanonicalArtifactId(rawArtifactId);

    try {
      const metadata = await agent.inspectProfileArtifactPreview(
        orgId,
        profileId,
        filename
      );
      return json<PreviewMetadata>(metadata);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to inspect artifact";
      if (message.includes("not found")) {
        return json({ error: message }, 404);
      }
      return json({ error: message }, 500);
    }
  });

  app.get("/v1/artifacts/:artifactId/content", async (c) => {
    const orgId = requireActiveOrgIdFromContext(c);
    const rawArtifactId = decodeURIComponent(c.req.param("artifactId"));
    const { profileId, filename } = parseCanonicalArtifactId(rawArtifactId);

    try {
      const artifact = await agent.readProfileArtifact(
        orgId,
        profileId,
        filename
      );
      const downloadName = (filename.split("/").pop() ?? "artifact").replace(
        /["\\]/g,
        "_"
      );
      const rangeHeader = c.req.header("range");
      const inline = c.req.query("inline") === "1";

      return handleByteRangeRequest(
        artifact.bytes,
        artifact.contentType,
        rangeHeader,
        downloadName,
        inline
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Artifact not found";
      return json({ error: message }, 404);
    }
  });

  app.get("/v1/artifacts/:artifactId/thumbnail", async (c) => {
    const orgId = requireActiveOrgIdFromContext(c);
    const rawArtifactId = decodeURIComponent(c.req.param("artifactId"));
    const { profileId, filename } = parseCanonicalArtifactId(rawArtifactId);

    try {
      const thumb = await agent.getProfileArtifactThumbnail(
        orgId,
        profileId,
        filename
      );
      if (!thumb) {
        return json({ error: "Thumbnail is not available." }, 404);
      }
      const downloadName = `${(filename.split("/").pop() ?? "artifact").replace(/["\\]/g, "_")}.png`;
      return handleByteRangeRequest(
        thumb.bytes,
        thumb.mimeType,
        c.req.header("range"),
        downloadName,
        true
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Artifact not found";
      return json({ error: message }, 404);
    }
  });

  app.get("/v1/profiles/:profileId/artifacts/thumbnail", async (c) => {
    const orgId = requireActiveOrgIdFromContext(c);
    const profileId = decodeURIComponent(c.req.param("profileId"));
    const artifactPath = c.req.query("path");
    if (!artifactPath) {
      return json({ error: "path is required" }, 400);
    }
    try {
      const thumb = await agent.getProfileArtifactThumbnail(
        orgId,
        profileId,
        artifactPath
      );
      if (!thumb) {
        return json({ error: "Thumbnail is not available." }, 404);
      }
      return handleByteRangeRequest(
        thumb.bytes,
        thumb.mimeType,
        c.req.header("range"),
        "thumbnail.png",
        true
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Artifact not found";
      return json({ error: message }, 404);
    }
  });

  app.get("/v1/artifacts/:artifactId/download", async (c) => {
    const orgId = requireActiveOrgIdFromContext(c);
    const rawArtifactId = decodeURIComponent(c.req.param("artifactId"));
    const { profileId, filename } = parseCanonicalArtifactId(rawArtifactId);

    try {
      const artifact = await agent.readProfileArtifact(
        orgId,
        profileId,
        filename
      );
      const downloadName = (filename.split("/").pop() ?? "artifact").replace(
        /["\\]/g,
        "_"
      );
      return handleByteRangeRequest(
        artifact.bytes,
        artifact.contentType,
        c.req.header("range"),
        downloadName,
        false
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Artifact not found";
      return json({ error: message }, 404);
    }
  });

  // ==========================================
  // Path-based Compatibility Routes (/v1/profiles/:profileId/artifacts/*)
  // ==========================================

  app.openAPIRegistry.registerPath(
    createRoute({
      method: "get",
      operationId: "getProfileArtifactPreview",
      path: "/v1/profiles/{profileId}/artifacts/preview",
      request: {
        params: profileIdParam,
        query: previewQuerySchema,
      },
      responses: {
        200: {
          content: { "application/json": { schema: artifactPreviewSchema } },
          description: "Canonical derived artifact preview model",
        },
        400: {
          content: { "application/json": { schema: errorSchema } },
          description: "Bad request",
        },
        403: {
          content: { "application/json": { schema: errorSchema } },
          description: "Forbidden",
        },
        404: {
          content: { "application/json": { schema: errorSchema } },
          description: "Artifact not found",
        },
      },
      summary: "Get rich canonical preview for an artifact",
      tags: ["Artifacts"],
    })
  );

  app.openAPIRegistry.registerPath(
    createRoute({
      method: "get",
      operationId: "inspectProfileArtifact",
      path: "/v1/profiles/{profileId}/artifacts/inspect",
      request: {
        params: profileIdParam,
        query: inspectQuerySchema,
      },
      responses: {
        200: {
          content: { "application/json": { schema: previewMetadataSchema } },
          description: "Cheap inspection metadata for artifact",
        },
        400: {
          content: { "application/json": { schema: errorSchema } },
          description: "Bad request",
        },
      },
      summary: "Inspect cheap artifact metadata",
      tags: ["Artifacts"],
    })
  );

  app.get("/v1/profiles/:profileId/artifacts/preview", async (c) => {
    const orgId = requireActiveOrgIdFromContext(c);
    const profileId = decodeURIComponent(c.req.param("profileId"));
    const artifactPath = c.req.query("path");

    if (!artifactPath) {
      return json({ error: "path is required" }, 400);
    }

    const sheet = c.req.query("sheet");
    const sheetIndexRaw = c.req.query("sheetIndex");
    const sheetIndex =
      sheetIndexRaw === undefined
        ? undefined
        : Number.parseInt(sheetIndexRaw, 10);
    const range = c.req.query("range");
    const revisionRaw = c.req.query("revision");
    const revision =
      revisionRaw === undefined ? undefined : Number.parseInt(revisionRaw, 10);

    const previewOptions: PreviewOptions = {
      range,
      revision: Number.isFinite(revision) ? revision : undefined,
      sheet,
      sheetIndex: Number.isFinite(sheetIndex) ? sheetIndex : undefined,
    };

    try {
      const preview = await agent.getProfileArtifactPreview(
        orgId,
        profileId,
        artifactPath,
        previewOptions
      );
      return json<ArtifactPreview>(preview);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load preview";
      if (message.includes("not found")) {
        return json({ error: message }, 404);
      }
      return json({ error: message }, 500);
    }
  });

  app.get("/v1/profiles/:profileId/artifacts/inspect", async (c) => {
    const orgId = requireActiveOrgIdFromContext(c);
    const profileId = decodeURIComponent(c.req.param("profileId"));
    const artifactPath = c.req.query("path");

    if (!artifactPath) {
      return json({ error: "path is required" }, 400);
    }

    try {
      const metadata = await agent.inspectProfileArtifactPreview(
        orgId,
        profileId,
        artifactPath
      );
      return json<PreviewMetadata>(metadata);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to inspect artifact";
      if (message.includes("not found")) {
        return json({ error: message }, 404);
      }
      return json({ error: message }, 500);
    }
  });

  app.get("/v1/profiles/:profileId/artifacts/manifest", async (c) => {
    const orgId = requireActiveOrgIdFromContext(c);
    const profileId = decodeURIComponent(c.req.param("profileId"));
    const artifactPath = c.req.query("path");

    if (!artifactPath) {
      return json({ error: "path is required" }, 400);
    }

    const sheet = c.req.query("sheet");
    const sheetIndexRaw = c.req.query("sheetIndex");
    const sheetIndex =
      sheetIndexRaw === undefined
        ? undefined
        : Number.parseInt(sheetIndexRaw, 10);
    const range = c.req.query("range");
    const revisionRaw = c.req.query("revision");
    const revision =
      revisionRaw === undefined ? undefined : Number.parseInt(revisionRaw, 10);

    const previewOptions: PreviewOptions = {
      range,
      revision: Number.isFinite(revision) ? revision : undefined,
      sheet,
      sheetIndex: Number.isFinite(sheetIndex) ? sheetIndex : undefined,
    };

    try {
      const manifest = await agent.getProfileArtifactManifest(
        orgId,
        profileId,
        artifactPath,
        previewOptions
      );
      return json<PreviewManifest>(manifest);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load manifest";
      if (message.includes("not found")) {
        return json({ error: message }, 404);
      }
      return json({ error: message }, 500);
    }
  });

  app.get("/v1/profiles/:profileId/artifacts/download", async (c) => {
    const orgId = requireActiveOrgIdFromContext(c);
    const profileId = decodeURIComponent(c.req.param("profileId"));
    const artifactPath = c.req.query("path");

    if (!artifactPath) {
      return json({ error: "path is required" }, 400);
    }

    try {
      const artifact = await agent.readProfileArtifact(
        orgId,
        profileId,
        artifactPath
      );
      const downloadName = (
        artifactPath.split("/").pop() ?? "artifact"
      ).replace(/["\\]/g, "_");
      return handleByteRangeRequest(
        artifact.bytes,
        artifact.contentType,
        c.req.header("range"),
        downloadName,
        false
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Artifact not found";
      return json({ error: message }, 404);
    }
  });

  app.get("/v1/artifacts/:artifactId/derived-pdf", async (c) => {
    const orgId = requireActiveOrgIdFromContext(c);
    const rawArtifactId = decodeURIComponent(c.req.param("artifactId"));
    const {
      profileId,
      filename,
      revision: idRevision,
    } = parseCanonicalArtifactId(rawArtifactId);

    const revisionRaw = c.req.query("revision");
    const parsedRev =
      revisionRaw === undefined ? undefined : Number.parseInt(revisionRaw, 10);
    const revision =
      parsedRev !== undefined && Number.isFinite(parsedRev)
        ? parsedRev
        : idRevision;

    try {
      const result = await agent.getProfileArtifactDerivedPdf(
        orgId,
        profileId,
        filename,
        { revision: Number.isFinite(revision) ? revision : undefined }
      );
      return handleByteRangeRequest(
        result.bytes,
        "application/pdf",
        c.req.header("range"),
        "preview.pdf",
        true
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Derived preview not found";
      return json({ error: message }, 404);
    }
  });

  app.get("/v1/profiles/:profileId/artifacts/derived-pdf", async (c) => {
    const orgId = requireActiveOrgIdFromContext(c);
    const profileId = decodeURIComponent(c.req.param("profileId"));
    const artifactPath = c.req.query("path");

    if (!artifactPath) {
      return json({ error: "path is required" }, 400);
    }

    const revisionRaw = c.req.query("revision");
    const parsedRev =
      revisionRaw === undefined ? undefined : Number.parseInt(revisionRaw, 10);
    const revision =
      parsedRev !== undefined && Number.isFinite(parsedRev)
        ? parsedRev
        : undefined;

    try {
      const result = await agent.getProfileArtifactDerivedPdf(
        orgId,
        profileId,
        artifactPath,
        { revision }
      );
      return handleByteRangeRequest(
        result.bytes,
        "application/pdf",
        c.req.header("range"),
        "preview.pdf",
        true
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Derived preview not found";
      return json({ error: message }, 404);
    }
  });
}
