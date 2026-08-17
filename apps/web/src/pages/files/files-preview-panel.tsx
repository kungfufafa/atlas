import type { ArtifactPreview } from "@atlas/core";
import type { ArtifactFile } from "@atlas/core/contract";
import { Cancel01Icon } from "hugeicons-react";
import { useEffect, useState } from "react";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { HtmlPreviewFrame } from "@/components/artifacts/HtmlPreviewFrame";
import { SafeMarkdownPreview } from "@/components/artifacts/SafeMarkdownPreview";
import { SvgPreview } from "@/components/artifacts/SvgPreview";
import { DocumentViewer } from "@/components/artifacts/viewers/DocumentViewer";
import { PdfViewer } from "@/components/artifacts/viewers/PdfViewer";
import { PresentationViewer } from "@/components/artifacts/viewers/PresentationViewer";
import { SpreadsheetViewer } from "@/components/artifacts/viewers/SpreadsheetViewer";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  isMermaidArtifactFilename,
  markdownForMermaidSource,
  mermaidPreviewError,
} from "@/lib/artifact-mermaid-preview";
import {
  buildArtifactContentUrl,
  isHtmlArtifactMimeType,
  isImageArtifactMimeType,
  isJsxArtifactFilename,
  isSvgArtifactMimeType,
  isVideoArtifactMimeType,
  resolveArtifactMimeType,
} from "@/lib/chat-artifacts";
import { client, formatError } from "@/lib/client";
import { formatBytes } from "@/lib/knowledge-base-files";
import {
  dirnameArtifactPath,
  htmlWithVirtualArtifactFiles,
} from "@/lib/playable-html-preview";

const TEXT_SIBLING = /\.(css|js|json|svg|txt|csv|map)$/i;

function basenamePath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function sameDirectorySiblings(
  artifact: ArtifactFile,
  artifacts: ArtifactFile[]
): ArtifactFile[] {
  const path = artifact.path || artifact.filename;
  const dir = dirnameArtifactPath(path);

  return artifacts.filter((candidate) => {
    const candidatePath = candidate.path || candidate.filename;
    return candidatePath !== path && dirnameArtifactPath(candidatePath) === dir;
  });
}

function FilesLiveHtml({
  artifact,
  artifacts,
  profileId,
}: {
  artifact: ArtifactFile;
  artifacts: ArtifactFile[];
  profileId: string;
}) {
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const path = artifact.path || artifact.filename;
    const siblings = sameDirectorySiblings(artifact, artifacts).filter((file) =>
      TEXT_SIBLING.test(file.path || file.filename)
    );

    void (async () => {
      try {
        const htmlResult = await client.readProfileArtifactContent(
          profileId,
          path,
          { inline: true }
        );
        const html = new TextDecoder().decode(htmlResult.data);
        const files: Record<string, string> = {};

        await Promise.all(
          siblings.map(async (sibling) => {
            const siblingPath = sibling.path || sibling.filename;
            const result = await client.readProfileArtifactContent(
              profileId,
              siblingPath,
              { inline: true }
            );
            const text = new TextDecoder().decode(result.data);
            const name = basenamePath(siblingPath);
            files[name] = text;
            files[`./${name}`] = text;
          })
        );

        if (!cancelled) {
          setSrcDoc(
            Object.keys(files).length > 0
              ? htmlWithVirtualArtifactFiles(html, files)
              : html
          );
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(formatError(loadError));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [artifact, artifacts, profileId]);

  if (error) {
    return <p className="p-4 text-destructive text-sm">{error}</p>;
  }

  if (!srcDoc) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground text-sm">
        <Spinner className="size-4" />
        Loading preview…
      </div>
    );
  }

  return (
    <HtmlPreviewFrame
      filename={artifact.filename}
      html={srcDoc}
      title={artifact.filename}
    />
  );
}

function FilesJsxPreview({
  filename,
  path,
  profileId,
}: {
  filename: string;
  path: string;
  profileId: string;
}) {
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void client
      .readProfileArtifactContent(profileId, path, { inline: true })
      .then((result) => {
        if (!cancelled) {
          setSource(new TextDecoder().decode(result.data));
        }
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Failed to load JSX."
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [path, profileId]);

  if (error) {
    return <p className="p-4 text-muted-foreground text-sm">{error}</p>;
  }
  if (!source) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground text-sm">
        <Spinner className="size-4" />
        Loading preview…
      </div>
    );
  }
  return (
    <HtmlPreviewFrame filename={filename} html={source} title={filename} />
  );
}

function FilesSvgPreview({ filename, url }: { filename: string; url: string }) {
  const [markup, setMarkup] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);

    void fetch(url, { credentials: "include" })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Failed to load SVG (${response.status})`);
        }
        return response.text();
      })
      .then((text) => {
        if (!cancelled) {
          setMarkup(text);
        }
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Failed to load SVG."
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [url]);

  if (error) {
    return <p className="p-4 text-muted-foreground text-sm">{error}</p>;
  }

  if (!markup) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground text-sm">
        <Spinner className="size-4" />
        Loading preview…
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-4">
      <SvgPreview content={markup} filename={filename} />
    </div>
  );
}

function FilesPreviewBody({
  artifact,
  artifacts,
  profileId,
  preview,
  downloadUrl,
  onSelectSheet,
}: {
  artifact: ArtifactFile;
  artifacts: ArtifactFile[];
  profileId: string;
  preview: ArtifactPreview;
  downloadUrl: string;
  onSelectSheet: (sheetName: string, sheetIndex?: number) => void;
}) {
  const mimeType = resolveArtifactMimeType(
    artifact.mimeType,
    artifact.filename
  );

  if (isJsxArtifactFilename(artifact.filename)) {
    return (
      <FilesJsxPreview
        filename={artifact.filename}
        path={artifact.path || artifact.filename}
        profileId={profileId}
      />
    );
  }

  if (isHtmlArtifactMimeType(mimeType) || preview.type === "html") {
    return (
      <FilesLiveHtml
        artifact={artifact}
        artifacts={artifacts}
        profileId={profileId}
      />
    );
  }

  if (
    (isSvgArtifactMimeType(mimeType) ||
      artifact.filename.toLowerCase().endsWith(".svg")) &&
    preview.type === "image"
  ) {
    return (
      <FilesSvgPreview
        filename={artifact.filename}
        url={
          preview.url ||
          buildArtifactContentUrl(
            profileId,
            artifact.path || artifact.filename,
            true
          )
        }
      />
    );
  }

  if (isMermaidArtifactFilename(artifact.filename)) {
    const source =
      preview.type === "text" ||
      preview.type === "code" ||
      preview.type === "markdown"
        ? preview.content
        : null;
    if (source) {
      const mermaidError = mermaidPreviewError(source);
      return (
        <div className="overflow-auto p-4">
          {mermaidError ? (
            <p className="text-muted-foreground text-sm">{mermaidError}</p>
          ) : (
            <SafeMarkdownPreview content={markdownForMermaidSource(source)} />
          )}
        </div>
      );
    }
  }

  if (isImageArtifactMimeType(mimeType) || preview.type === "image") {
    const url =
      preview.type === "image"
        ? preview.url
        : buildArtifactContentUrl(
            profileId,
            artifact.path || artifact.filename,
            true
          );
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        <img
          alt={artifact.filename}
          className="max-h-full max-w-full object-contain"
          src={url}
        />
      </div>
    );
  }

  if (isVideoArtifactMimeType(mimeType)) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        <video
          aria-label={artifact.filename}
          className="max-h-full w-full object-contain"
          controls
          playsInline
          src={buildArtifactContentUrl(
            profileId,
            artifact.path || artifact.filename,
            true
          )}
        />
      </div>
    );
  }

  switch (preview.type) {
    case "json":
      return (
        <div className="min-h-0 flex-1 overflow-auto">
          <CodeBlock code={preview.formatted} fillHeight lang="json" />
        </div>
      );
    case "markdown":
      return (
        <div className="overflow-auto p-4">
          <SafeMarkdownPreview content={preview.content} />
        </div>
      );
    case "code":
      return (
        <div className="min-h-0 flex-1 overflow-auto">
          <CodeBlock
            code={preview.content}
            fillHeight
            lang={preview.language}
          />
        </div>
      );
    case "text":
      return (
        <div className="min-h-0 flex-1 overflow-auto">
          <CodeBlock code={preview.content} fillHeight lang="text" />
        </div>
      );
    case "pdf":
      return <PdfViewer downloadUrl={downloadUrl} preview={preview} />;
    case "spreadsheet":
      return (
        <SpreadsheetViewer
          downloadUrl={downloadUrl}
          onSelectSheet={onSelectSheet}
          preview={preview}
        />
      );
    case "presentation":
      return <PresentationViewer downloadUrl={downloadUrl} preview={preview} />;
    case "document":
      return <DocumentViewer downloadUrl={downloadUrl} preview={preview} />;
    default:
      return (
        <p className="p-4 text-muted-foreground text-sm">
          Preview is not available for this file type.
        </p>
      );
  }
}

export function FilesPreviewPanel({
  artifact,
  artifacts,
  profileId,
  onClose,
}: {
  artifact: ArtifactFile;
  artifacts: ArtifactFile[];
  profileId: string;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sheet, setSheet] = useState<{
    sheet?: string;
    sheetIndex?: number;
  }>({});

  const path = artifact.path || artifact.filename;
  const downloadUrl = `${client.baseUrl}${buildArtifactContentUrl(profileId, path)}`;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    void client
      .getProfileArtifactPreview(profileId, path, {
        sheet: sheet.sheet,
        sheetIndex: sheet.sheetIndex,
      })
      .then((next) => {
        if (!cancelled) {
          setPreview(next);
        }
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(formatError(loadError));
          setPreview(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [path, profileId, sheet.sheet, sheet.sheetIndex]);

  return (
    <aside
      aria-label={artifact.filename}
      className="flex h-full min-h-0 w-full max-w-full shrink-0 flex-col border-border border-l bg-background sm:w-[28rem] lg:w-[36rem]"
    >
      <div className="flex items-center justify-between gap-3 border-border border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate font-medium text-sm">{artifact.filename}</h2>
          <p className="mt-0.5 truncate text-muted-foreground text-xs">
            {artifact.mimeType}
            {artifact.sizeBytes > 0
              ? ` · ${formatBytes(artifact.sizeBytes)}`
              : ""}
          </p>
        </div>
        <Button
          aria-label="Close preview"
          onClick={onClose}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <Cancel01Icon className="size-4" />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {loading ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground text-sm">
            <Spinner className="size-4" />
            Loading preview…
          </div>
        ) : error ? (
          <p className="p-4 text-destructive text-sm">{error}</p>
        ) : preview ? (
          <FilesPreviewBody
            artifact={artifact}
            artifacts={artifacts}
            downloadUrl={downloadUrl}
            onSelectSheet={(sheetName, sheetIndex) =>
              setSheet({ sheet: sheetName, sheetIndex })
            }
            preview={preview}
            profileId={profileId}
          />
        ) : null}
      </div>
    </aside>
  );
}
