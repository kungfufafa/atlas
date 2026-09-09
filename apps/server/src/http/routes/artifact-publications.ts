import {
  AtlasApiError,
  getUserConfigDir,
  sanitizeArtifactShareFilename,
} from "@atlas/core";
import type { ArtifactPublication } from "@atlas/core/artifact-publication";
import type { ArtifactPublicationPageOptions } from "@atlas/db";
import { z } from "@hono/zod-openapi";
import { createSessionPublicationAccess } from "../../services/artifact-publication-access";
import { ArtifactPublicationStore } from "../../services/artifact-publication-store";
import type { ServerOptions } from "../context";
import { requireActiveOrgIdFromContext } from "../org-guards";
import { sessionActorFromAuth } from "../session-actor";
import { getRequestAuth, json } from "../shared";
import type { HonoApp } from "../types";
import { handleByteRangeRequest } from "./artifact-preview";

const cursorSchema = z
  .object({
    createdAt: z
      .string()
      .max(100)
      .refine((value) => Number.isFinite(Date.parse(value))),
    id: z
      .string()
      .min(1)
      .max(100)
      .refine((value) => value.trim().length > 0),
  })
  .strict();
const ENCODED_CURSOR = /^[A-Za-z0-9_-]+$/;
const PAGE_LIMIT = /^\d+$/;
const SAFE_INLINE_TYPES = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "video/mp4",
  "video/webm",
  "text/plain",
]);

function pageOptions(
  limitValue?: string,
  cursor?: string
): ArtifactPublicationPageOptions {
  const limit = limitValue === undefined ? 50 : Number(limitValue);
  if (
    (limitValue !== undefined && !PAGE_LIMIT.test(limitValue)) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    throw new AtlasApiError("Invalid page limit", 400);
  }
  if (cursor === undefined) {
    return { limit };
  }
  try {
    if (cursor.length > 1024 || !ENCODED_CURSOR.test(cursor)) {
      throw new Error("Invalid encoding");
    }
    const decoded = Buffer.from(cursor, "base64url");
    if (decoded.toString("base64url") !== cursor) {
      throw new Error("Noncanonical encoding");
    }
    return {
      after: cursorSchema.parse(JSON.parse(decoded.toString("utf8"))),
      limit,
    };
  } catch {
    throw new AtlasApiError("Invalid publication cursor", 400);
  }
}

function nextCursor(publication: ArtifactPublication): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: publication.createdAt,
      id: publication.id,
    })
  ).toString("base64url");
}

/** Additive durable-publication API. Legacy workspace browsing is a separate surface. */
export function registerArtifactPublicationRoutes(
  app: HonoApp,
  options: ServerOptions
): void {
  const db = options.databaseAdapter;
  if (!db) {
    return;
  }
  let store: Promise<ArtifactPublicationStore> | undefined;
  const access = createSessionPublicationAccess({
    agent: options.agent,
    db,
    getStore() {
      // A failed initialization can be retried; it never causes a tool replay.
      store ??= ArtifactPublicationStore.create(getUserConfigDir()).catch(
        (error) => {
          store = undefined;
          throw error;
        }
      );
      return store;
    },
  });
  const base = "/v1/sessions/:sessionId/artifact-publications";
  app.get(base, async (c) => {
    const page = pageOptions(c.req.query("limit"), c.req.query("cursor"));
    const { service, scope } = await access(
      requireActiveOrgIdFromContext(c),
      c.req.param("sessionId"),
      sessionActorFromAuth(getRequestAuth(c))
    );
    const records = await service.list(scope, {
      ...page,
      limit: page.limit + 1,
    });
    const hasMore = records.length > page.limit;
    const publications = records.slice(0, page.limit);
    c.header("Cache-Control", "private, no-store");
    return c.json({
      publications,
      nextCursor: hasMore ? nextCursor(publications.at(-1)!) : null,
    });
  });
  app.get(`${base}/:publicationId/content`, async (c) => {
    const { service, scope } = await access(
      requireActiveOrgIdFromContext(c),
      c.req.param("sessionId"),
      sessionActorFromAuth(getRequestAuth(c))
    );
    const result = await service.read(scope, c.req.param("publicationId"));
    if (!result) {
      throw new AtlasApiError("Not found", 404);
    }
    const { bytes, publication } = result;
    const response = handleByteRangeRequest(
      bytes,
      publication.mimeType,
      c.req.header("Range"),
      sanitizeArtifactShareFilename(publication.filename),
      c.req.query("inline") === "1" &&
        SAFE_INLINE_TYPES.has(publication.mimeType)
    );
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set(
      "Content-Security-Policy",
      "sandbox; default-src 'none'"
    );
    return response;
  });
  app.delete(`${base}/:publicationId`, async (c) => {
    const { service, scope } = await access(
      requireActiveOrgIdFromContext(c),
      c.req.param("sessionId"),
      sessionActorFromAuth(getRequestAuth(c)),
      "revoke"
    );
    const revoked = await service.revoke(scope, c.req.param("publicationId"));
    if (!revoked) {
      throw new AtlasApiError("Not found", 404);
    }
    return json({ revoked: true });
  });
}
