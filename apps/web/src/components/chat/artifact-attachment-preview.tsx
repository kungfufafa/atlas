import type { ArtifactPreview } from "@atlas/core";
import {
  File01Icon,
  Image01Icon,
  Video01Icon,
  ViewIcon,
} from "hugeicons-react";
import { useEffect, useRef, useState } from "react";
import {
  type ArtifactPreviewMode,
  ArtifactPreviewModeToggle,
} from "@/components/artifacts/ArtifactPreviewModeToggle";
import { ArtifactAttachmentPanelActions } from "@/components/chat/artifact-attachment-panel-actions";
import { ArtifactAttachmentPanelBody } from "@/components/chat/artifact-attachment-panel-body";
import {
  artifactPanelBodyClassName,
  artifactPanelDefaultWidth,
  artifactPanelSubtitle,
} from "@/components/chat/artifact-attachment-panel-body.shared";
import {
  ArtifactShareIconButton,
  ArtifactSharePublishDialogFromState,
} from "@/components/chat/artifact-share-controls";
import { useArtifactPreviewContent } from "@/components/chat/use-artifact-preview-content";
import { useArtifactShareControls } from "@/components/chat/use-artifact-share-controls";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useChatAttachmentPanel } from "@/context/use-chat-attachment-panel";
import {
  artifactCanvasSourceLanguage,
  artifactCanvasTypeLabel,
  artifactSupportsPreviewCodeToggle,
} from "@/lib/artifact-canvas";
import {
  artifactCodeLanguage,
  buildArtifactContentUrl,
  type ChatArtifactRef,
  isDocxFile,
  isHtmlArtifactMimeType,
  isImageArtifactMimeType,
  isJsxArtifactFilename,
  isLegacyDocFile,
  isMarkdownArtifactMimeType,
  isMermaidArtifactFilename,
  isSvgArtifactMimeType,
  isTextArtifactMimeType,
  isUnknownArtifactMimeType,
  isVideoArtifactMimeType,
  resolveArtifactMimeType,
} from "@/lib/chat-artifacts";
import { client } from "@/lib/client";
import { cn } from "@/lib/utils";

interface ArtifactAttachmentPreviewProps {
  artifact: ChatArtifactRef;
  autoOpen?: boolean;
  className?: string;
  id: string;
  profileId: string;
  /** `chip` is the chat attachment chip; `icon` is an icon-only view button. */
  variant?: "chip" | "icon";
}

function ArtifactAttachmentPreviewPanelBody({
  kind,
  textFormat,
  language,
  loading,
  error,
  content,
  imagePreviewUrl,
  videoPreviewUrl,
  canPreview,
  artifact,
}: {
  kind: "image" | "video" | "html" | "svg" | "text";
  textFormat: "markdown" | "plain" | "mermaid";
  language: string | null;
  loading: boolean;
  error: string | null;
  content: string | null;
  imagePreviewUrl: string | null;
  videoPreviewUrl: string | null;
  canPreview: boolean;
  artifact: ChatArtifactRef;
}) {
  if (kind === "image") {
    return (
      <ArtifactAttachmentPanelBody
        artifact={artifact}
        canPreview={canPreview}
        error={error}
        imagePreviewUrl={imagePreviewUrl}
        kind="image"
        loading={loading}
      />
    );
  }

  if (kind === "video") {
    return (
      <ArtifactAttachmentPanelBody
        artifact={artifact}
        canPreview={canPreview}
        error={error}
        kind="video"
        loading={loading}
        videoPreviewUrl={videoPreviewUrl}
      />
    );
  }

  if (kind === "html") {
    return (
      <ArtifactAttachmentPanelBody
        artifact={artifact}
        canPreview={canPreview}
        content={content}
        error={error}
        kind="html"
        loading={loading}
      />
    );
  }

  if (kind === "svg") {
    return (
      <ArtifactAttachmentPanelBody
        artifact={artifact}
        canPreview={canPreview}
        content={content}
        error={error}
        kind="svg"
        loading={loading}
      />
    );
  }

  return (
    <ArtifactAttachmentPanelBody
      artifact={artifact}
      canPreview={canPreview}
      content={content}
      error={error}
      format={textFormat}
      kind="text"
      language={language}
      loading={loading}
    />
  );
}

export function ArtifactAttachmentPreview(
  props: ArtifactAttachmentPreviewProps
) {
  const triggerProps = useArtifactAttachmentPreviewController(props);
  return <ArtifactAttachmentPreviewTrigger {...triggerProps} />;
}

function useArtifactAttachmentPreviewController({
  profileId,
  id,
  artifact,
  autoOpen = false,
  className,
  variant = "chip",
}: ArtifactAttachmentPreviewProps) {
  const { show, update, activeId, isDismissed } = useChatAttachmentPanel();
  const autoOpenedRef = useRef(false);
  const share = useArtifactShareControls({
    artifactPath: artifact.path,
    profileId,
  });
  const open = activeId === id;
  const [fullscreen, setFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [previewMode, setPreviewMode] =
    useState<ArtifactPreviewMode>("preview");
  const downloadUrl = `${client.baseUrl}${buildArtifactContentUrl(profileId, artifact.path)}`;
  const mimeType = resolveArtifactMimeType(
    artifact.mimeType,
    artifact.filename
  );
  const isHtml =
    isHtmlArtifactMimeType(mimeType) ||
    isJsxArtifactFilename(artifact.filename);
  const isSvg = isSvgArtifactMimeType(mimeType);
  const isMermaid = isMermaidArtifactFilename(artifact.filename);
  const isImage = isImageArtifactMimeType(mimeType);
  const isVideo = isVideoArtifactMimeType(mimeType);
  const isWordDocument =
    isDocxFile(artifact.filename, mimeType) ||
    isLegacyDocFile(artifact.filename, mimeType);
  const isPptx =
    artifact.filename.toLowerCase().endsWith(".pptx") ||
    artifact.filename.toLowerCase().endsWith(".ppt");
  const isXlsx =
    artifact.filename.toLowerCase().endsWith(".xlsx") ||
    artifact.filename.toLowerCase().endsWith(".xls") ||
    artifact.filename.toLowerCase().endsWith(".csv");
  const isPdf =
    artifact.filename.toLowerCase().endsWith(".pdf") ||
    mimeType === "application/pdf";
  const isRichDoc = isPptx || isXlsx || isPdf || isWordDocument;
  const showModeToggle = artifactSupportsPreviewCodeToggle(
    artifact.filename,
    mimeType
  );
  const sourceLanguage = artifactCanvasSourceLanguage(
    artifact.filename,
    mimeType
  );
  const showingSource = showModeToggle && previewMode === "code";

  const [richPreview, setRichPreview] = useState<ArtifactPreview | null>(null);
  const [richLoading, setRichLoading] = useState(false);
  const [richError, setRichError] = useState<string | null>(null);
  const [sheetOptions, setSheetOptions] = useState<{
    sheet?: string;
    sheetIndex?: number;
  }>({});

  useEffect(() => {
    if (!(open && isRichDoc)) {
      return;
    }

    let cancelled = false;
    setRichLoading(true);
    setRichError(null);

    client
      .getProfileArtifactPreview(
        profileId,
        artifact.path || artifact.filename,
        {
          sheet: sheetOptions.sheet,
          sheetIndex: sheetOptions.sheetIndex,
        }
      )
      .then((preview) => {
        if (cancelled) {
          return;
        }
        setRichPreview(preview);
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }
        setRichError(
          err instanceof Error ? err.message : "Failed to load preview."
        );
      })
      .finally(() => {
        if (!cancelled) {
          setRichLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    open,
    isRichDoc,
    profileId,
    artifact.path,
    artifact.filename,
    sheetOptions,
  ]);

  const isMarkdown = isMarkdownArtifactMimeType(mimeType);
  const language = artifactCodeLanguage(artifact.filename);
  const canPreview =
    isRichDoc ||
    isHtml ||
    isSvg ||
    isMermaid ||
    isImage ||
    isVideo ||
    isTextArtifactMimeType(mimeType) ||
    isUnknownArtifactMimeType(mimeType);
  const {
    loading,
    error,
    content,
    imagePreviewUrl,
    videoPreviewUrl,
    setContent,
  } = useArtifactPreviewContent({
    artifact,
    canPreview: canPreview && !isRichDoc,
    isHtml,
    isImage,
    isVideo,
    isWordDocument: false,
    open,
    profileId,
  });

  useEffect(() => {
    if (!copied) {
      return;
    }

    const timeout = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  function buildPanelBody(loadingOverride?: boolean) {
    const canvasKind = isRichDoc
      ? "rich"
      : showingSource
        ? "source"
        : isImage
          ? "image"
          : isVideo
            ? "video"
            : isHtml
              ? "html"
              : isSvg
                ? "svg"
                : "text";
    return (
      <ArtifactAttachmentPreviewCanvas
        artifact={artifact}
        canPreview={canPreview}
        canvasKind={canvasKind}
        content={content}
        downloadUrl={downloadUrl}
        error={error}
        imagePreviewUrl={imagePreviewUrl}
        language={language}
        loading={loading}
        loadingOverride={loadingOverride}
        onSelectSheet={(sheetName, sheetIndex) => {
          setSheetOptions({ sheet: sheetName, sheetIndex });
        }}
        richError={richError}
        richLoading={richLoading}
        richPreview={richPreview}
        sourceLanguage={sourceLanguage}
        textFormat={isMermaid ? "mermaid" : isMarkdown ? "markdown" : "plain"}
        videoPreviewUrl={videoPreviewUrl}
      />
    );
  }

  function buildPanelConfig() {
    return {
      bodyClassName: artifactPanelBodyClassName({
        isHtml,
        isImage,
        isMarkdown: isMarkdown || isWordDocument,
        isMermaid,
        isSvg,
        isVideo,
        mode: showingSource ? "code" : "preview",
      }),
      content: buildPanelBody(),
      fullscreen,
      headerActions: (
        <>
          <ArtifactAttachmentPanelActions
            content={content}
            copied={copied}
            copyDisabled={isImage || isVideo || isRichDoc}
            downloadUrl={downloadUrl}
            extraActions={<ArtifactShareIconButton share={share} />}
            filename={artifact.filename}
            fullscreen={fullscreen}
            loading={isRichDoc ? richLoading : loading}
            onCopy={() => void copyArtifact()}
            onToggleFullscreen={() => setFullscreen((current) => !current)}
          />
          <ArtifactSharePublishDialogFromState
            artifactPath={artifact.path}
            share={share}
          />
        </>
      ),
      headerLeading: showModeToggle ? (
        <ArtifactPreviewModeToggle
          mode={previewMode}
          onChange={setPreviewMode}
        />
      ) : null,
      resizable: !fullscreen,
      subtitle: artifactPanelSubtitle({
        mimeType,
        sizeBytes: artifact.sizeBytes,
      }),
      title: artifact.filename,
    };
  }

  useEffect(() => {
    if (!open) {
      return;
    }

    update(id, buildPanelConfig());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    open,
    update,
    id,
    artifact,
    fullscreen,
    isHtml,
    isImage,
    isVideo,
    isMarkdown,
    isRichDoc,
    richPreview,
    richLoading,
    richError,
    language,
    mimeType,
    loading,
    error,
    content,
    imagePreviewUrl,
    videoPreviewUrl,
    canPreview,
    copied,
    downloadUrl,
    previewMode,
    share.busy,
    share.publishDialogOpen,
  ]);

  async function copyArtifact() {
    if (isImage || isVideo) {
      return;
    }

    try {
      let text = content;
      if (!text) {
        const result = await client.readProfileArtifactContent(
          profileId,
          artifact.path,
          { inline: true }
        );
        text = new TextDecoder().decode(result.data);
        setContent(text);
      }

      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Clipboard may be unavailable outside secure contexts.
    }
  }

  function presentPanel() {
    show({
      ...buildPanelConfig(),
      content: buildPanelBody(
        canPreview &&
          (isRichDoc
            ? richPreview === null
            : isImage || isVideo
              ? (isImage ? imagePreviewUrl : videoPreviewUrl) === null
              : content === null) &&
          error === null &&
          richError === null
      ),
      defaultWidth: artifactPanelDefaultWidth(artifact.filename, mimeType),
      fullscreen: false,
      id,
      onClose: () => {
        setFullscreen(false);
        setCopied(false);
      },
      resizable: true,
    });
  }

  const presentPanelRef = useRef(presentPanel);
  useEffect(() => {
    presentPanelRef.current = presentPanel;
  });

  function openPanel() {
    setFullscreen(false);
    setCopied(false);
    presentPanel();
  }

  useEffect(() => {
    if (!autoOpen || autoOpenedRef.current || open || isDismissed(id)) {
      return;
    }
    autoOpenedRef.current = true;
    presentPanelRef.current();
  }, [autoOpen, id, isDismissed, open]);

  return {
    className,
    filename: artifact.filename,
    imagePreviewUrl,
    isImage,
    isVideo,
    mimeType,
    onOpen: openPanel,
    selected: open,
    variant,
  };
}

function ArtifactAttachmentPreviewTrigger({
  className,
  filename,
  imagePreviewUrl,
  isImage,
  isVideo,
  mimeType,
  onOpen,
  selected,
  variant,
}: {
  className?: string;
  filename: string;
  imagePreviewUrl: string | null;
  isImage: boolean;
  isVideo: boolean;
  mimeType: string;
  onOpen: () => void;
  selected: boolean;
  variant: ArtifactAttachmentPreviewProps["variant"];
}) {
  if (variant === "icon") {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label="View"
              className={className}
              onClick={onOpen}
              size="icon-sm"
              title="View"
              type="button"
              variant="outline"
            >
              <ViewIcon aria-hidden className="size-3.5" />
            </Button>
          }
        />
        <TooltipContent side="top" sideOffset={8}>
          View
        </TooltipContent>
      </Tooltip>
    );
  }

  const typeLabel = artifactCanvasTypeLabel(filename, mimeType);

  if (isImage) {
    return (
      <button
        aria-pressed={selected}
        className={cn(
          "relative flex w-56 max-w-full shrink-0 flex-col gap-2 overflow-hidden rounded-lg border bg-background p-1.5 text-left transition-colors hover:bg-muted/50",
          selected ? "border-border bg-muted/60" : "border-border",
          className
        )}
        onClick={onOpen}
        type="button"
      >
        {imagePreviewUrl ? (
          <img
            alt=""
            className="aspect-[4/3] w-full rounded-md object-cover"
            src={imagePreviewUrl}
          />
        ) : (
          <div className="flex aspect-[4/3] w-full items-center justify-center rounded-md bg-muted/60">
            <Image01Icon aria-hidden className="size-6 text-muted-foreground" />
          </div>
        )}
        <div className="min-w-0 px-0.5 pb-0.5">
          <p className="truncate font-medium text-foreground text-xs">
            {filename}
          </p>
          <p className="text-2xs text-muted-foreground">{typeLabel}</p>
        </div>
      </button>
    );
  }

  return (
    <button
      aria-pressed={selected}
      className={cn(
        "relative inline-flex max-w-full shrink-0 items-center gap-2.5 rounded-lg border bg-background px-2.5 py-2 text-left transition-colors hover:bg-muted/50",
        selected ? "border-border bg-muted/60" : "border-border",
        className
      )}
      onClick={onOpen}
      type="button"
    >
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
        {isVideo ? (
          <Video01Icon aria-hidden className="size-4 text-muted-foreground" />
        ) : (
          <File01Icon aria-hidden className="size-4 text-muted-foreground" />
        )}
      </div>
      <div className="min-w-0 max-w-[14rem]">
        <p className="truncate font-medium text-foreground text-sm">
          {filename}
        </p>
        <p className="text-muted-foreground text-xs">{typeLabel}</p>
      </div>
    </button>
  );
}

function ArtifactAttachmentPreviewCanvas({
  artifact,
  canPreview,
  canvasKind,
  content,
  downloadUrl,
  error,
  imagePreviewUrl,
  language,
  loading,
  loadingOverride,
  onSelectSheet,
  richError,
  richLoading,
  richPreview,
  sourceLanguage,
  textFormat,
  videoPreviewUrl,
}: {
  artifact: ChatArtifactRef;
  canPreview: boolean;
  canvasKind: "rich" | "source" | "image" | "video" | "html" | "svg" | "text";
  content: string | null;
  downloadUrl: string;
  error: string | null;
  imagePreviewUrl: string | null;
  language: string | null;
  loading: boolean;
  loadingOverride?: boolean;
  onSelectSheet: (sheetName: string, sheetIndex?: number) => void;
  richError: string | null;
  richLoading: boolean;
  richPreview: ArtifactPreview | null;
  sourceLanguage: string | null;
  textFormat: "mermaid" | "markdown" | "plain";
  videoPreviewUrl: string | null;
}) {
  if (canvasKind === "rich") {
    return (
      <ArtifactAttachmentPanelBody
        artifact={artifact}
        canPreview={true}
        downloadUrl={downloadUrl}
        error={richError}
        kind="rich"
        loading={loadingOverride ?? richLoading}
        onSelectSheet={onSelectSheet}
        preview={richPreview}
      />
    );
  }

  if (canvasKind === "source") {
    return (
      <ArtifactAttachmentPanelBody
        artifact={artifact}
        canPreview={canPreview}
        content={content}
        error={error}
        format="plain"
        kind="text"
        language={sourceLanguage ?? null}
        loading={loadingOverride ?? loading}
      />
    );
  }

  return (
    <ArtifactAttachmentPreviewPanelBody
      artifact={artifact}
      canPreview={canPreview}
      content={content}
      error={error}
      imagePreviewUrl={imagePreviewUrl}
      kind={canvasKind}
      language={language ?? null}
      loading={loadingOverride ?? loading}
      textFormat={canvasKind === "text" ? textFormat : "plain"}
      videoPreviewUrl={videoPreviewUrl}
    />
  );
}
