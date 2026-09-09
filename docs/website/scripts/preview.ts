import { realpath, stat } from "node:fs/promises";
import path from "node:path";

const outputDir = await realpath(path.join(import.meta.dir, "..", "out"));
const basePath = "/atlas";
const port = Number(process.env.PORT ?? 3004);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

const server = Bun.serve({
  async fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, {
        headers: { Allow: "GET, HEAD" },
        status: 405,
      });
    }

    const url = new URL(request.url);
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response("Invalid path", { status: 400 });
    }
    if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) {
      return new Response("Not found", { status: 404 });
    }

    const relativePath = pathname.slice(basePath.length);
    const target = path.resolve(outputDir, `.${relativePath || "/"}`);
    const candidates = [target, path.join(target, "index.html")];
    for (const candidate of candidates) {
      const resolved = await realpath(candidate).catch(() => null);
      if (!resolved?.startsWith(`${outputDir}${path.sep}`)) {
        continue;
      }
      if (!(await stat(resolved)).isFile()) {
        continue;
      }
      const file = Bun.file(resolved);
      return new Response(request.method === "HEAD" ? null : file, {
        headers: { "Content-Type": file.type },
      });
    }
    return new Response("Not found", { status: 404 });
  },
  hostname: "127.0.0.1",
  port,
});

process.stdout.write(`Docs preview: ${server.url.origin}${basePath}/\n`);
