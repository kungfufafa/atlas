import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryServeStaticWeb } from "./static-web";

async function withDist(
  files: Record<string, string | Uint8Array>,
  run: (distDir: string) => Promise<void> | void
): Promise<void> {
  const distDir = await mkdtemp(join(tmpdir(), "atlas-static-web-"));
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = join(distDir, relativePath);
    mkdirSync(join(filePath, ".."), { recursive: true });
    writeFileSync(filePath, contents);
  }
  await run(distDir);
}

describe("tryServeStaticWeb", () => {
  test("gzips JS, CSS, and HTML when the client accepts gzip", async () => {
    const script = "console.log('atlas-dashboard-bundle');\n".repeat(200);
    const css = "body{color:navy}\n".repeat(40);
    const html = "<!doctype html><html><body>atlas</body></html>\n";

    await withDist(
      {
        "assets/index-test.css": css,
        "assets/index-test.js": script,
        "index.html": html,
      },
      async (distDir) => {
        const js = tryServeStaticWeb(
          new Request("http://localhost/assets/index-test.js", {
            headers: { "Accept-Encoding": "gzip, deflate" },
          }),
          distDir
        );
        expect(js?.headers.get("Content-Encoding")).toBe("gzip");
        expect(js?.headers.get("Cache-Control")).toBe(
          "public, max-age=31536000, immutable"
        );
        expect(js?.headers.get("Vary")).toBe("Accept-Encoding");
        expect(
          new TextDecoder().decode(
            Bun.gunzipSync(new Uint8Array(await js!.arrayBuffer()))
          )
        ).toBe(script);

        const cssResponse = tryServeStaticWeb(
          new Request("http://localhost/assets/index-test.css", {
            headers: { "Accept-Encoding": "gzip" },
          }),
          distDir
        );
        expect(cssResponse?.headers.get("Content-Encoding")).toBe("gzip");

        const htmlResponse = tryServeStaticWeb(
          new Request("http://localhost/", {
            headers: { "Accept-Encoding": "gzip" },
          }),
          distDir
        );
        expect(htmlResponse?.headers.get("Content-Encoding")).toBe("gzip");
        expect(htmlResponse?.headers.get("Cache-Control")).toBe("no-cache");
      }
    );
  });

  test("leaves JS uncompressed when gzip is not accepted and keeps index.html uncached", async () => {
    await withDist(
      {
        "assets/index-test.js": "export default 1;\n",
        "index.html": "<html></html>\n",
        "logo.png": new Uint8Array([137, 80, 78, 71]),
      },
      (distDir) => {
        const js = tryServeStaticWeb(
          new Request("http://localhost/assets/index-test.js"),
          distDir
        );
        expect(js?.headers.get("Content-Encoding")).toBeNull();
        expect(js?.headers.get("Cache-Control")).toBe(
          "public, max-age=31536000, immutable"
        );

        const html = tryServeStaticWeb(
          new Request("http://localhost/chat"),
          distDir
        );
        expect(html?.headers.get("Cache-Control")).toBe("no-cache");

        const png = tryServeStaticWeb(
          new Request("http://localhost/logo.png", {
            headers: { "Accept-Encoding": "gzip" },
          }),
          distDir
        );
        expect(png?.headers.get("Content-Encoding")).toBeNull();

        const head = tryServeStaticWeb(
          new Request("http://localhost/assets/index-test.js", {
            headers: { "Accept-Encoding": "gzip" },
            method: "HEAD",
          }),
          distDir
        );
        expect(head?.headers.get("Content-Encoding")).toBe("gzip");
        expect(head?.headers.get("Content-Length")).toBeTruthy();
      }
    );
  });
});
