import {
  htmlWithJsxIframeCompiler,
  looksLikeJsx,
} from "@/lib/artifact-jsx-iframe";
import { MAX_HTML_PREVIEW_CHARS } from "@/lib/artifact-preview-limits";

const HIDDEN_SCROLLBAR_STYLE =
  "<style data-atlas-html-preview>html,body{scrollbar-width:none;-ms-overflow-style:none}html::-webkit-scrollbar,body::-webkit-scrollbar{display:none}</style>";

/** Scripts run inside the iframe, but without same-origin access to the host app. */
export const ARTIFACT_HTML_IFRAME_SANDBOX =
  "allow-scripts allow-forms allow-popups";

export const ARTIFACT_HTML_PREVIEW_MESSAGE_SOURCE = "atlas-artifact-preview";

export const ARTIFACT_HTML_IFRAME_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; img-src data: blob: https: http:; font-src data: https:; media-src data: blob: https:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

const PREVIEW_HEAD_INJECT = `${HIDDEN_SCROLLBAR_STYLE}<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_HTML_IFRAME_CSP}"><script data-atlas-preview-bridge>
(() => {
  const send = (event, detail) => {
    try {
      const origin = document.referrer ? new URL(document.referrer).origin : "*";
      parent.postMessage({ source: "${ARTIFACT_HTML_PREVIEW_MESSAGE_SOURCE}", event, detail }, origin);
    } catch {
      parent.postMessage({ source: "${ARTIFACT_HTML_PREVIEW_MESSAGE_SOURCE}", event, detail }, "*");
    }
  };
  window.addEventListener("error", (error) => {
    send("error", { message: String(error.message || "Preview script error") });
  });
  send("ready");
})();
</script>`;

export type HtmlPreviewPrepareResult =
  | { srcDoc: string; status: "ok" }
  | { sizeChars: number; status: "too_large" };

export function htmlForArtifactPreview(html: string): string {
  if (/<head[\s>]/i.test(html)) {
    return html.replace(
      /<head(\s[^>]*)?>/i,
      (match) => `${match}${PREVIEW_HEAD_INJECT}`
    );
  }

  if (/<html[\s>]/i.test(html)) {
    return html.replace(
      /<html(\s[^>]*)?>/i,
      (match) => `${match}<head>${PREVIEW_HEAD_INJECT}</head>`
    );
  }

  return `${PREVIEW_HEAD_INJECT}${html}`;
}

export function prepareHtmlPreview(
  html: string,
  filename = ""
): HtmlPreviewPrepareResult {
  if (html.length > MAX_HTML_PREVIEW_CHARS) {
    return { sizeChars: html.length, status: "too_large" };
  }

  const source = looksLikeJsx(html, filename)
    ? htmlWithJsxIframeCompiler(html)
    : html;
  return { srcDoc: htmlForArtifactPreview(source), status: "ok" };
}

export function isTrustedArtifactPreviewMessage(
  event: MessageEvent,
  iframe: HTMLIFrameElement | null
): event is MessageEvent<{
  detail?: { message?: string };
  event?: string;
  source?: string;
}> {
  if (!iframe || event.source !== iframe.contentWindow) {
    return false;
  }

  const hostOrigin =
    typeof window === "undefined" ? undefined : window.location.origin;
  // srcDoc frames have an opaque origin.
  if (event.origin !== "null" && event.origin !== hostOrigin) {
    return false;
  }

  const data = event.data;
  return (
    typeof data === "object" &&
    data !== null &&
    data.source === ARTIFACT_HTML_PREVIEW_MESSAGE_SOURCE
  );
}
