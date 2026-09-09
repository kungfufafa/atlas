import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright";
import { createServer, type Plugin } from "vite";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = resolve(
  webRoot,
  "../../packages/core/src/testing/fixtures"
);
const qaRoute = "/__atlas_pdf_viewer_qa";
const port = Number(process.env.ATLAS_PDF_QA_PORT ?? 4310);
const outputDir =
  process.env.ATLAS_PDF_QA_OUTPUT_DIR ??
  (await mkdtemp(join(tmpdir(), "atlas-pdf-viewer-")));

const fixtureModuleId = "virtual:atlas-pdf-viewer-qa";
const fixtureHtml = `<!doctype html>
<html><head><title>Atlas PDF viewer regression</title></head>
<body style="margin:0"><div id="root"></div>
<script type="module" src="/@id/__x00__${fixtureModuleId}"></script></body></html>`;
const fixtureModule = `import React, { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PdfViewer } from '/src/components/artifacts/viewers/PdfViewer.tsx';
import '/src/index.css';
const h = React.createElement;
function Fixture() {
  const [document, setDocument] = useState('report');
  const [mounted, setMounted] = useState(true);
  const url = '${qaRoute}/' + document + '.pdf';
  const preview = { type: 'pdf', pageCount: 2, filename: document + '.pdf',
    mimeType: 'application/pdf', sizeBytes: 1, previewVersion: 1,
    status: 'available', generatedAt: '2026-09-09T00:00:00Z', previewUrl: url };
  return h('div', { style: { height: '100vh', display: 'flex', flexDirection: 'column' } },
    h('div', { style: { padding: 12, display: 'flex', gap: 12 } },
      h('label', null, 'Document ', h('select', { 'aria-label': 'Document', value: document,
        onChange: event => setDocument(event.target.value) },
        ...['report', 'replacement', 'broken', 'slow'].map(name =>
          h('option', { value: name, key: name }, name)))),
      h('button', { onClick: () => setMounted(value => !value) },
        mounted ? 'Unmount viewer' : 'Mount viewer')),
    h('div', { style: { flex: 1, minHeight: 0 } },
      mounted && h(PdfViewer, { preview, downloadUrl: url })));
}
createRoot(document.getElementById('root')).render(h(StrictMode, null, h(Fixture)));
`;

function fixturePlugin(report: Buffer, replacement: Buffer): Plugin {
  return {
    configResolved(config) {
      // This fixture server owns only PDF test data, never the Atlas API.
      config.server.proxy = undefined;
    },
    configureServer(server) {
      server.middlewares.use(qaRoute, (request, response, next) => {
        const path = request.url?.split("?")[0];
        if (path === "/" || path === "") {
          void (async () => {
            try {
              const html = await server.transformIndexHtml(
                qaRoute,
                fixtureHtml
              );
              response.setHeader("Content-Type", "text/html");
              response.end(html);
            } catch (error) {
              next(error);
            }
          })();
          return;
        }
        if (!path?.endsWith(".pdf")) {
          next();
          return;
        }
        const send = () => {
          if (response.destroyed) {
            return;
          }
          response.setHeader("Content-Type", "application/pdf");
          let bytes = report;
          if (path === "/replacement.pdf") {
            bytes = replacement;
          } else if (path === "/broken.pdf") {
            bytes = Buffer.from("Invalid PDF fixture");
          }
          response.end(bytes);
        };
        if (path === "/slow.pdf") {
          const timer = setTimeout(send, 1000);
          response.on("close", () => clearTimeout(timer));
        } else {
          send();
        }
      });
    },
    load(id) {
      return id === `\0${fixtureModuleId}` ? fixtureModule : undefined;
    },
    name: "atlas-pdf-viewer-regression",
    resolveId(id) {
      return id === fixtureModuleId ? `\0${fixtureModuleId}` : undefined;
    },
  };
}

async function waitForRenderedPage(page: Page): Promise<void> {
  await page.locator("canvas").waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const canvas = document.querySelector("canvas");
    if (!canvas || canvas.width < 500) {
      return false;
    }
    const context = canvas.getContext("2d");
    if (!context) {
      return false;
    }
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let offset = 0; offset < data.length; offset += 64) {
      if (data[offset + 3] === 255 && (data[offset] ?? 255) < 200) {
        return true;
      }
    }
    return false;
  });
}

async function verifyNavigation(page: Page): Promise<void> {
  const number = page.getByRole("spinbutton", { name: "Page number" });
  assert.equal(await number.inputValue(), "1");
  await page.getByRole("button", { exact: true, name: "Next page" }).click();
  assert.equal(await number.inputValue(), "2");
  await page.getByRole("button", { exact: true, name: "Zoom in" }).click();
  await page.waitForFunction(
    () => (document.querySelector("canvas")?.width ?? 0) > 700
  );
  await page
    .getByRole("button", { exact: true, name: "Toggle thumbnails" })
    .click();
  await page.getByRole("button", { exact: true, name: "Page 1 1" }).click();
  assert.equal(await number.inputValue(), "1");
  await page.keyboard.press("ArrowRight");
  assert.equal(await number.inputValue(), "2");
  for (let index = 0; index < 12; index += 1) {
    await page
      .getByRole("button", {
        exact: true,
        name: index % 2 ? "Zoom out" : "Zoom in",
      })
      .click();
  }
  await waitForRenderedPage(page);
  await page.screenshot({ path: join(outputDir, "page-and-zoom.png") });
}

async function verifyReplacementAndRecovery(page: Page): Promise<void> {
  const select = page.getByRole("combobox", { name: "Document" });
  await select.selectOption("replacement");
  await waitForRenderedPage(page);
  assert.equal(
    await page.getByRole("spinbutton", { name: "Page number" }).inputValue(),
    "1"
  );
  assert.equal(
    await page
      .getByRole("button", { exact: true, name: "Next page" })
      .isDisabled(),
    true
  );
  await select.selectOption("broken");
  await page.getByText("Invalid PDF structure.", { exact: true }).waitFor();
  await page.screenshot({ path: join(outputDir, "invalid-file.png") });
  await select.selectOption("report");
  await waitForRenderedPage(page);
}

async function verifyCancelledLoad(page: Page): Promise<void> {
  const select = page.getByRole("combobox", { name: "Document" });
  await select.selectOption("slow");
  await page
    .getByRole("button", { exact: true, name: "Unmount viewer" })
    .click();
  await select.selectOption("replacement");
  await page.getByRole("button", { exact: true, name: "Mount viewer" }).click();
  await waitForRenderedPage(page);
  // Let the old response deadline pass: it must not replace the current document.
  await page.waitForTimeout(1100);
  assert.equal(
    await page
      .getByRole("button", { exact: true, name: "Next page" })
      .isDisabled(),
    true
  );
  await page.screenshot({ path: join(outputDir, "recovered.png") });
}

await mkdir(outputDir, { recursive: true });
const [report, replacement] = await Promise.all([
  readFile(join(fixtureRoot, "pdf-navigation-pypdf.pdf")),
  readFile(join(fixtureRoot, "pdf-libreoffice-report.pdf")),
]);
const server = await createServer({
  configFile: join(webRoot, "vite.config.ts"),
  plugins: [fixturePlugin(report, replacement)],
  root: webRoot,
  server: { hmr: false, host: "127.0.0.1", port, strictPort: true },
});
let browser: Browser | undefined;
try {
  browser = await chromium.launch({ headless: true });
  await server.listen();
  const page = await browser.newPage({
    viewport: { height: 900, width: 1280 },
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}${qaRoute}/`);
  await waitForRenderedPage(page);
  await page.screenshot({ path: join(outputDir, "initial.png") });
  await verifyNavigation(page);
  await verifyReplacementAndRecovery(page);
  await verifyCancelledLoad(page);
  assert.deepEqual(
    errors,
    [],
    "PDF viewer must not leave uncaught browser errors"
  );
  console.info(`PDF viewer regression passed. Screenshots: ${outputDir}`);
} finally {
  await Promise.all([browser?.close(), server.close()]);
}
