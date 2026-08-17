const JSX_TAG = /<[A-Za-z][\w.-]*(\s|>|\/)/;

export function looksLikeJsx(source: string, filename = ""): boolean {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".jsx") || lower.endsWith(".tsx")) {
    return true;
  }
  if (/<html[\s>]|<!doctype html/i.test(source)) {
    return false;
  }
  return (
    JSX_TAG.test(source) &&
    (/\bexport\s+default\b/.test(source) ||
      /\bfunction\s+[A-Z]/.test(source) ||
      /\bfrom\s+["']react["']/.test(source))
  );
}

export function transformJsx(source: string): string {
  let out = source
    .replace(/import\s+[^;]+;/g, "")
    .replace(/export\s+default\s+/g, "var __Default = ");

  for (let i = 0; i < 20; i += 1) {
    // Constructor: a /...<\// regex literal would break the iframe script tag.
    // biome-ignore lint/complexity/useRegexLiterals: injected into srcDoc via Function#toString
    const pairTag = new RegExp(
      "<([A-Za-z][\\w.-]*)([^>]*)>([\\s\\S]*?)<\\/\\1>",
      "g"
    );
    const next = out.replace(
      pairTag,
      (_all, tag: string, attrs: string, body: string) => {
        const inner = body.trim();
        const children = inner
          ? inner.startsWith("h(")
            ? inner
            : JSON.stringify(inner)
          : "";
        return `h(${JSON.stringify(tag)},${attrsToObjectLiteral(attrs)}${children ? `,${children}` : ""})`;
      }
    );
    if (next === out) {
      break;
    }
    out = next;
  }

  return out.replace(
    /<([A-Za-z][\w.-]*)([^>]*)\/>/g,
    (_all, tag: string, attrs: string) =>
      `h(${JSON.stringify(tag)},${attrsToObjectLiteral(attrs)})`
  );
}

function attrsToObjectLiteral(raw: string): string {
  const props: string[] = [];
  const re = /([A-Za-z_:][\w:-]*)(?:=(?:"([^"]*)"|'([^']*)'|\{([^}]+)\}))?/g;
  let match = re.exec(raw);
  while (match) {
    const name = match[1] === "class" ? "className" : match[1];
    if (match[4]) {
      props.push(`${JSON.stringify(name)}:${match[4]}`);
    } else if (match[2] !== undefined || match[3] !== undefined) {
      props.push(
        `${JSON.stringify(name)}:${JSON.stringify(match[2] ?? match[3])}`
      );
    } else {
      props.push(`${JSON.stringify(name)}:true`);
    }
    match = re.exec(raw);
  }
  return `{${props.join(",")}}`;
}

function jsxIframeRuntimeSource(): string {
  return `(() => {
    const h = (type, props, ...kids) => {
      const el = document.createElement(type);
      for (const [key, value] of Object.entries(props || {})) {
        if (key === "className") el.setAttribute("class", String(value));
        else if (key === "style" && value && typeof value === "object") Object.assign(el.style, value);
        else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value);
        else if (value != null && key !== "children") el.setAttribute(key, String(value));
      }
      for (const child of kids.flat(Infinity)) {
        if (child == null || child === false) continue;
        if (child instanceof Node) el.append(child);
        else el.append(document.createTextNode(String(child)));
      }
      return el;
    };
    const transformJsx = ${transformJsx.toString()};
    const attrsToObjectLiteral = ${attrsToObjectLiteral.toString()};
    const source = document.getElementById("atlas-jsx-source")?.textContent || "";
    const root = document.getElementById("root") || document.body;
    try {
      const compiled = transformJsx(source);
      const run = new Function("h", compiled + ";\\nconst C = typeof __Default === 'function' ? __Default : (typeof App === 'function' ? App : null); if (C) { const node = C(); root.innerHTML = ''; if (node instanceof Node) root.append(node); }");
      run(h);
    } catch (error) {
      root.textContent = "JSX preview failed.";
      try { parent.postMessage({ source: "atlas-artifact-preview", event: "error", detail: { message: String(error) } }, "*"); } catch {}
    }
  })();`;
}

export function htmlWithJsxIframeCompiler(source: string): string {
  const escaped = source.replaceAll("</script", "<\\/script");
  return `<!DOCTYPE html><html><head></head><body>
<div id="root"></div>
<script type="text/plain" id="atlas-jsx-source">${escaped}</script>
<script data-atlas-jsx-compiler>
${jsxIframeRuntimeSource()}
</script>
</body></html>`;
}
