const REMOTE_OR_SPECIAL_URL =
  /^(?:[a-z]+:|\/\/|#|data:|blob:|mailto:|javascript:)/i;

const RELATIVE_ASSET_ATTR =
  /\b(?:src|href)\s*=\s*(["'])(?![a-z]+:|\/\/|#|data:|blob:)([^"']+)\1/gi;

const RELATIVE_FETCH_OR_IMPORT =
  /\b(?:fetch|import)\s*\(\s*(["'])(?![a-z]+:|\/\/|#|data:|blob:)([^"']+)\1/gi;

export function dirnameArtifactPath(artifactPath: string): string {
  const normalized = artifactPath.replaceAll("\\", "/");
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? "" : normalized.slice(0, slash + 1);
}

export function resolveSiblingArtifactPath(
  htmlPath: string,
  relativeUrl: string
): string | null {
  const trimmed = relativeUrl.trim().split(/[?#]/, 1)[0] ?? "";
  if (!trimmed || REMOTE_OR_SPECIAL_URL.test(trimmed)) {
    return null;
  }

  const baseDir = dirnameArtifactPath(htmlPath);
  const joined = `${baseDir}${trimmed}`.replaceAll("\\", "/");
  const parts: string[] = [];

  for (const part of joined.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (parts.length === 0) {
        return null;
      }
      parts.pop();
      continue;
    }
    parts.push(part);
  }

  return parts.join("/");
}

export function collectRelativeAssetPaths(html: string): string[] {
  const found = new Set<string>();

  for (const pattern of [RELATIVE_ASSET_ATTR, RELATIVE_FETCH_OR_IMPORT]) {
    pattern.lastIndex = 0;
    for (const match of html.matchAll(pattern)) {
      const raw = match[2]?.trim();
      if (raw) {
        found.add(raw);
      }
    }
  }

  return [...found];
}

export function prettyPrintJson(raw: string): string {
  try {
    return `${JSON.stringify(JSON.parse(raw), null, 2)}\n`;
  } catch {
    return raw;
  }
}

function escapeScriptClose(value: string): string {
  return value.replaceAll("</script", "<\\/script");
}

export function htmlWithVirtualArtifactFiles(
  html: string,
  files: Record<string, string>
): string {
  const payload = escapeScriptClose(JSON.stringify(files));
  const bootstrap = `<script data-atlas-virtual-files>
(() => {
  const files = ${payload};
  const resolve = (input) => {
    try {
      const url = typeof input === "string" ? input : input?.url;
      if (!url) {
        return null;
      }
      const key = String(url).split(/[?#]/, 1)[0].replace(/^\\.\\//, "");
      return Object.hasOwn(files, key) ? key : Object.hasOwn(files, url) ? url : null;
    } catch {
      return null;
    }
  };
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const key = resolve(input);
    if (key == null) {
      return originalFetch(input, init);
    }
    return Promise.resolve(new Response(files[key], { status: 200 }));
  };
})();
</script>`;

  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head(\s[^>]*)?>/i, (match) => `${match}${bootstrap}`);
  }

  if (/<html[\s>]/i.test(html)) {
    return html.replace(
      /<html(\s[^>]*)?>/i,
      (match) => `${match}<head>${bootstrap}</head>`
    );
  }

  return `${bootstrap}${html}`;
}
