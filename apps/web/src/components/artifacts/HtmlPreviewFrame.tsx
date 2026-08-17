import { useEffect, useRef, useState } from "react";
import {
  ARTIFACT_HTML_IFRAME_SANDBOX,
  isTrustedArtifactPreviewMessage,
  prepareHtmlPreview,
} from "@/lib/artifact-html-preview";

export function HtmlPreviewFrame({
  html,
  title,
  filename,
  className = "h-full min-h-0 w-full flex-1 border-0 bg-background",
}: {
  html: string;
  title: string;
  filename?: string;
  className?: string;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [scriptError, setScriptError] = useState<string | null>(null);
  const prepared = prepareHtmlPreview(html, filename ?? title);

  useEffect(() => {
    setScriptError(null);

    function onMessage(event: MessageEvent) {
      if (!isTrustedArtifactPreviewMessage(event, iframeRef.current)) {
        return;
      }
      if (event.data.event === "error" && event.data.detail?.message) {
        setScriptError(event.data.detail.message);
      }
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [html]);

  if (prepared.status === "too_large") {
    return (
      <p className="p-4 text-muted-foreground text-sm">
        This HTML is too large to preview.
      </p>
    );
  }

  return (
    <>
      {scriptError ? (
        <p className="border-border border-b px-4 py-2 text-muted-foreground text-xs">
          Preview script error. The page may be incomplete.
        </p>
      ) : null}
      <iframe
        className={className}
        ref={iframeRef}
        referrerPolicy="no-referrer"
        sandbox={ARTIFACT_HTML_IFRAME_SANDBOX}
        srcDoc={prepared.srcDoc}
        title={title}
      />
    </>
  );
}
