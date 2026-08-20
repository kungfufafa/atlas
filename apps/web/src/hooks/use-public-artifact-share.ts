import type { ArtifactPreview } from "@atlas/core";
import { useQuery } from "@tanstack/react-query";
import { htmlForArtifactPreview } from "@/lib/artifact-html-preview";
import {
  buildPublicArtifactSharePreviewUrl,
  isHtmlArtifactMimeType,
  isImageArtifactMimeType,
  isLegacyDocFile,
  isRichPreviewArtifact,
  isVideoArtifactMimeType,
  looksLikeUtf8Text,
  resolveArtifactMimeType,
} from "@/lib/chat-artifacts";
import { client } from "@/lib/client";

export interface PublicShareMetadata {
  filename: string;
  inlineAllowed: boolean;
  mimeType: string;
  sizeBytes: number;
}

export interface PublicArtifactShareData {
  content: string | null;
  metadata: PublicShareMetadata;
  preview: ArtifactPreview | null;
}

export interface PublicArtifactSharePreviewOptions {
  range?: string;
  sheet?: string;
  sheetIndex?: number;
}

export async function loadPublicArtifactShare(
  token: string,
  options: PublicArtifactSharePreviewOptions = {}
): Promise<PublicArtifactShareData> {
  const metaResponse = await fetch(
    `${client.baseUrl}/v1/public/artifact-shares/${encodeURIComponent(token)}?meta=1`
  );

  if (!metaResponse.ok) {
    throw new Error("This share link is unavailable.");
  }

  const metadata = (await metaResponse.json()) as PublicShareMetadata;
  const resolvedMime = resolveArtifactMimeType(
    metadata.mimeType,
    metadata.filename
  );
  const previewAsHtml = isHtmlArtifactMimeType(resolvedMime);
  // Binary media uses the public share URL as <img>/<video> src — no need to buffer bytes here.
  const previewAsBinaryMedia =
    isImageArtifactMimeType(resolvedMime) ||
    isVideoArtifactMimeType(resolvedMime);

  if (isRichPreviewArtifact(metadata.filename, resolvedMime)) {
    const previewResponse = await fetch(
      buildPublicArtifactSharePreviewUrl(token, client.baseUrl, options)
    );

    if (!previewResponse.ok) {
      return { content: null, metadata, preview: null };
    }

    try {
      const preview = (await previewResponse.json()) as ArtifactPreview;
      return { content: null, metadata, preview };
    } catch {
      return { content: null, metadata, preview: null };
    }
  }

  if (previewAsBinaryMedia) {
    return { content: null, metadata, preview: null };
  }

  if (isLegacyDocFile(metadata.filename, resolvedMime)) {
    return { content: null, metadata, preview: null };
  }

  if (!(metadata.inlineAllowed || previewAsHtml)) {
    return { content: null, metadata, preview: null };
  }

  const contentResponse = await fetch(
    `${client.baseUrl}/v1/public/artifact-shares/${encodeURIComponent(token)}`
  );

  if (!contentResponse.ok) {
    throw new Error("This share link is unavailable.");
  }

  const bytes = new Uint8Array(await contentResponse.arrayBuffer());
  const contentType = resolveArtifactMimeType(
    contentResponse.headers.get("Content-Type") ?? metadata.mimeType,
    metadata.filename
  );

  if (isHtmlArtifactMimeType(contentType)) {
    return {
      content: htmlForArtifactPreview(new TextDecoder().decode(bytes)),
      metadata,
      preview: null,
    };
  }

  if (looksLikeUtf8Text(bytes)) {
    return {
      content: new TextDecoder().decode(bytes),
      metadata,
      preview: null,
    };
  }

  return { content: null, metadata, preview: null };
}

export function usePublicArtifactShare(
  token: string,
  options: PublicArtifactSharePreviewOptions = {}
) {
  return useQuery({
    enabled: token.length > 0,
    placeholderData: (previousData, previousQuery) => {
      if (previousQuery?.queryKey[1] === token) {
        return previousData;
      }
    },
    queryFn: () => loadPublicArtifactShare(token, options),
    queryKey: [
      "public-artifact-share",
      token,
      options.sheet ?? null,
      options.sheetIndex ?? null,
      options.range ?? null,
    ],
  });
}
