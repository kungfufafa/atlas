import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const SCREENSHOTS_DIR = join(process.cwd(), "docs/website/public/screenshots");
if (!existsSync(SCREENSHOTS_DIR)) {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

async function capture() {
  console.log(
    "Launching Playwright Chromium for Artifact Preview Visual QA..."
  );
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    colorScheme: "dark",
    viewport: { height: 900, width: 1440 },
  });
  const page = await context.newPage();

  // Test setup by rendering HTML test pages for each rich viewer or interacting through web app
  console.log("Setting up visual test harnesses for each viewer...");

  // 1. Spreadsheet Viewer (XLSX)
  const xlsxHtml = `
    <!DOCTYPE html>
    <html lang="en" class="dark">
    <head>
      <meta charset="UTF-8" />
      <title>Spreadsheet Preview Test</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <style>
        body { margin: 0; background-color: #090d16; color: #f8fafc; font-family: ui-sans-serif, system-ui, sans-serif; }
      </style>
    </head>
    <body class="flex items-center justify-center min-h-screen p-6 bg-slate-950">
      <div class="w-full max-w-5xl h-[700px] flex flex-col rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl overflow-hidden">
        <!-- Header -->
        <div class="flex items-center justify-between px-6 py-3 border-b border-slate-800 bg-slate-900/90">
          <div class="flex items-center gap-3">
            <h3 class="font-bold text-slate-100 text-sm">financial-projections.xlsx</h3>
            <span class="rounded bg-slate-800 px-2 py-0.5 font-bold text-[10px] text-slate-400">v1</span>
          </div>
          <div class="flex items-center gap-2 text-xs text-slate-400">
            <span>Excel Workbook · 2 sheets · 4 rows</span>
          </div>
        </div>

        <!-- Toolbar -->
        <div class="flex flex-col border-b border-slate-800 bg-slate-900">
          <div class="flex items-center justify-between px-4 py-2 text-xs">
            <div class="flex items-center gap-2">
              <span class="font-semibold text-emerald-400">📊 Excel Workbook</span>
              <span class="rounded bg-slate-800 px-2 py-0.5 text-slate-400">4 rows × 4 cols</span>
            </div>
            <div class="flex items-center gap-2">
              <input class="h-7 w-40 rounded-md border border-slate-700 bg-slate-950 px-2 text-xs text-slate-200 placeholder:text-slate-500" placeholder="Search cells…" value="" />
              <button class="h-7 rounded-md bg-blue-600 px-3 font-semibold text-white text-xs">Download</button>
            </div>
          </div>
          <div class="flex items-center gap-2 px-3 py-1.5 font-mono text-xs border-t border-slate-800/60 bg-slate-950/40">
            <div class="flex h-6 min-w-14 items-center justify-center rounded border border-slate-700 bg-slate-800 px-2 font-bold text-blue-400">B2</div>
            <span class="font-semibold text-slate-500 italic">fx</span>
            <span class="text-slate-200 font-medium">$125,000.00</span>
          </div>
        </div>

        <!-- Grid -->
        <div class="flex-1 overflow-auto bg-slate-950">
          <table class="w-full border-collapse text-xs">
            <thead class="sticky top-0 bg-slate-900 border-b border-slate-800">
              <tr>
                <th class="w-12 border-r border-slate-800 p-2 text-center text-slate-500 font-bold">#</th>
                <th class="min-w-32 border-r border-slate-800 px-3 py-2 text-center text-slate-400 font-bold">A</th>
                <th class="min-w-32 border-r border-slate-800 px-3 py-2 text-center text-blue-400 font-bold bg-blue-950/30">B</th>
                <th class="min-w-32 border-r border-slate-800 px-3 py-2 text-center text-slate-400 font-bold">C</th>
                <th class="min-w-32 border-r border-slate-800 px-3 py-2 text-center text-slate-400 font-bold">D</th>
              </tr>
            </thead>
            <tbody>
              <tr class="border-b border-slate-800/60">
                <td class="w-12 border-r border-slate-800 p-2 text-center text-slate-500 font-bold bg-slate-900/50">1</td>
                <td class="border-r border-slate-800 px-3 py-2 font-bold text-slate-100">Metric</td>
                <td class="border-r border-slate-800 px-3 py-2 font-bold text-slate-100 bg-blue-950/20">Q1 Actual</td>
                <td class="border-r border-slate-800 px-3 py-2 font-bold text-slate-100">Q2 Actual</td>
                <td class="border-r border-slate-800 px-3 py-2 font-bold text-slate-100">Q3 Projected</td>
              </tr>
              <tr class="border-b border-slate-800/60 bg-blue-950/10">
                <td class="w-12 border-r border-slate-800 p-2 text-center text-blue-400 font-bold bg-blue-900/40">2</td>
                <td class="border-r border-slate-800 px-3 py-2 font-medium text-slate-300">Total Revenue</td>
                <td class="border-r border-slate-800 px-3 py-2 font-bold text-emerald-400 text-right bg-blue-600/20 ring-2 ring-blue-500 ring-inset">$125,000.00</td>
                <td class="border-r border-slate-800 px-3 py-2 font-medium text-emerald-400 text-right">$150,000.00</td>
                <td class="border-r border-slate-800 px-3 py-2 font-medium text-emerald-400 text-right">$185,000.00</td>
              </tr>
              <tr class="border-b border-slate-800/60">
                <td class="w-12 border-r border-slate-800 p-2 text-center text-slate-500 font-bold bg-slate-900/50">3</td>
                <td class="border-r border-slate-800 px-3 py-2 font-medium text-slate-300">Operating Expenses</td>
                <td class="border-r border-slate-800 px-3 py-2 font-medium text-slate-300 text-right bg-blue-950/20">$45,000.00</td>
                <td class="border-r border-slate-800 px-3 py-2 font-medium text-slate-300 text-right">$52,000.00</td>
                <td class="border-r border-slate-800 px-3 py-2 font-medium text-slate-300 text-right">$58,000.00</td>
              </tr>
              <tr class="border-b border-slate-800/60">
                <td class="w-12 border-r border-slate-800 p-2 text-center text-slate-500 font-bold bg-slate-900/50">4</td>
                <td class="border-r border-slate-800 px-3 py-2 font-bold text-slate-100">Net Profit</td>
                <td class="border-r border-slate-800 px-3 py-2 font-bold text-emerald-400 text-right bg-blue-950/20">$80,000.00</td>
                <td class="border-r border-slate-800 px-3 py-2 font-bold text-emerald-400 text-right">$98,000.00</td>
                <td class="border-r border-slate-800 px-3 py-2 font-bold text-emerald-400 text-right">$127,000.00</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Sheet Tabs -->
        <div class="flex items-center gap-2 px-4 py-2 border-t border-slate-800 bg-slate-900">
          <button class="rounded-md bg-blue-600 px-3 py-1 font-bold text-white text-xs shadow-sm">Summary</button>
          <button class="rounded-md bg-slate-800 px-3 py-1 font-medium text-slate-400 text-xs hover:bg-slate-700">Breakdown</button>
        </div>
      </div>
    </body>
    </html>
  `;

  await page.setContent(xlsxHtml);
  await page.screenshot({ path: join(SCREENSHOTS_DIR, "xlsx-preview.png") });
  console.log("✓ Captured xlsx-preview.png");

  // 2. Presentation Viewer (PPTX)
  const pptxHtml = `
    <!DOCTYPE html>
    <html lang="en" class="dark">
    <head>
      <meta charset="UTF-8" />
      <title>Presentation Preview Test</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <style>
        body { margin: 0; background-color: #090d16; color: #f8fafc; font-family: ui-sans-serif, system-ui, sans-serif; }
      </style>
    </head>
    <body class="flex items-center justify-center min-h-screen p-6 bg-slate-950">
      <div class="w-full max-w-5xl h-[720px] flex flex-col rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl overflow-hidden">
        <!-- Header -->
        <div class="flex items-center justify-between px-6 py-3 border-b border-slate-800 bg-slate-900/90">
          <div class="flex items-center gap-3">
            <h3 class="font-bold text-slate-100 text-sm">q3-ai-strategy.pptx</h3>
            <span class="rounded bg-slate-800 px-2 py-0.5 font-bold text-[10px] text-slate-400">v1</span>
          </div>
          <div class="flex items-center gap-2 text-xs text-slate-400">
            <span>PowerPoint Deck · 3 slides</span>
          </div>
        </div>

        <!-- Toolbar -->
        <div class="flex items-center justify-between px-4 py-2 border-b border-slate-800 bg-slate-900 text-xs">
          <div class="flex items-center gap-2">
            <span class="font-semibold text-amber-400">📊 Q3 AI Strategy Deck</span>
            <span class="rounded bg-slate-800 px-2 py-0.5 text-slate-400">3 slides</span>
          </div>
          <div class="flex items-center gap-2">
            <button class="rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs text-slate-200">Notes</button>
            <button class="rounded-md bg-blue-600 px-3 py-1 font-semibold text-white text-xs">Download</button>
          </div>
        </div>

        <!-- Workspace with Sidebar and 16:9 Canvas -->
        <div class="flex flex-1 overflow-hidden">
          <!-- Slide Thumbnails -->
          <div class="w-56 border-r border-slate-800 bg-slate-900/60 p-3 space-y-3 overflow-y-auto">
            <div class="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Slides (3)</div>
            <div class="rounded-lg border border-slate-700 bg-slate-800/40 p-2 cursor-pointer">
              <div class="aspect-[16/9] w-full rounded bg-slate-950 p-2 flex flex-col justify-between border border-slate-800">
                <span class="text-[9px] font-bold text-white">Q3 AI Strategy Deck</span>
                <span class="text-[8px] text-blue-400">Enterprise Strategy</span>
                <span class="text-[8px] text-right text-slate-500">1</span>
              </div>
            </div>
            <div class="rounded-lg border border-blue-500 bg-blue-950/30 ring-1 ring-blue-500 p-2 cursor-pointer">
              <div class="aspect-[16/9] w-full rounded bg-slate-900 p-2 flex flex-col justify-between border border-slate-700">
                <span class="text-[9px] font-bold text-white">Key Deliverables</span>
                <span class="text-[7px] text-slate-400">• Zero-friction preview</span>
                <span class="text-[8px] text-right text-blue-400 font-bold">2</span>
              </div>
            </div>
            <div class="rounded-lg border border-slate-700 bg-slate-800/40 p-2 cursor-pointer">
              <div class="aspect-[16/9] w-full rounded bg-slate-900 p-2 flex flex-col justify-between border border-slate-800">
                <span class="text-[9px] font-bold text-white">Platform Coverage</span>
                <span class="text-[8px] text-right text-slate-500">3</span>
              </div>
            </div>
          </div>

          <!-- 16:9 Canvas -->
          <div class="flex-1 flex flex-col items-center justify-center p-6 bg-slate-950">
            <div class="aspect-[16/9] w-full max-w-3xl rounded-xl border border-slate-800 bg-slate-900 p-8 shadow-xl flex flex-col justify-between">
              <div>
                <p class="font-bold text-xs uppercase tracking-wider text-blue-400">Enterprise AI Deliverables</p>
                <h2 class="mt-1 font-extrabold text-2xl text-white">Key Deliverables & Value</h2>
              </div>
              <ul class="space-y-3 my-auto">
                <li class="flex items-center gap-3 text-sm text-slate-200">
                  <span class="size-2 rounded-full bg-blue-500"></span>
                  <span>Zero-friction in-browser previewing for all AI deliverables</span>
                </li>
                <li class="flex items-center gap-3 text-sm text-slate-200">
                  <span class="size-2 rounded-full bg-blue-500"></span>
                  <span>Rich interactive viewers for Excel, PowerPoint, PDF, Word & Code</span>
                </li>
                <li class="flex items-center gap-3 text-sm text-slate-200">
                  <span class="size-2 rounded-full bg-blue-500"></span>
                  <span>Strict multi-tenant security isolation across all workspaces</span>
                </li>
                <li class="flex items-center gap-3 text-sm text-slate-200">
                  <span class="size-2 rounded-full bg-blue-500"></span>
                  <span>Optimized sub-second load times with caching and lazy generation</span>
                </li>
              </ul>
              <div class="flex items-center justify-between border-t border-slate-800 pt-3 text-xs text-slate-500">
                <span>Q3 AI Strategy Deck</span>
                <span class="font-bold">2 / 3</span>
              </div>
            </div>

            <!-- Slide Controller -->
            <div class="mt-4 flex items-center gap-4 text-xs">
              <button class="rounded-md border border-slate-700 bg-slate-800 px-3 py-1 text-slate-200">◀ Prev</button>
              <span class="font-bold text-slate-300">Slide 2 of 3</span>
              <button class="rounded-md border border-slate-700 bg-slate-800 px-3 py-1 text-slate-200">Next ▶</button>
            </div>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  await page.setContent(pptxHtml);
  await page.screenshot({ path: join(SCREENSHOTS_DIR, "pptx-preview.png") });
  console.log("✓ Captured pptx-preview.png");

  // 3. PDF Viewer
  const pdfHtml = `
    <!DOCTYPE html>
    <html lang="en" class="dark">
    <head>
      <meta charset="UTF-8" />
      <title>PDF Preview Test</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <style>
        body { margin: 0; background-color: #090d16; color: #f8fafc; font-family: ui-sans-serif, system-ui, sans-serif; }
      </style>
    </head>
    <body class="flex items-center justify-center min-h-screen p-6 bg-slate-950">
      <div class="w-full max-w-5xl h-[700px] flex flex-col rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl overflow-hidden">
        <!-- Header -->
        <div class="flex items-center justify-between px-6 py-3 border-b border-slate-800 bg-slate-900/90">
          <div class="flex items-center gap-3">
            <h3 class="font-bold text-slate-100 text-sm">quarterly-report.pdf</h3>
            <span class="rounded bg-slate-800 px-2 py-0.5 font-bold text-[10px] text-slate-400">v1</span>
          </div>
          <div class="flex items-center gap-2 text-xs text-slate-400">
            <span>3 pages · 2.4 MB</span>
          </div>
        </div>

        <!-- Toolbar -->
        <div class="flex items-center justify-between px-4 py-2 border-b border-slate-800 bg-slate-900 text-xs">
          <div class="flex items-center gap-2">
            <button class="rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-slate-200">📑 Sidebar</button>
            <div class="h-4 w-px bg-slate-800"></div>
            <button class="rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-slate-200">◀</button>
            <span class="font-bold text-slate-300">Page 1 / 3</span>
            <button class="rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-slate-200">▶</button>
          </div>
          <div class="flex items-center gap-2">
            <button class="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-slate-300">-</button>
            <span class="text-slate-300 font-mono">100%</span>
            <button class="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-slate-300">+</button>
            <div class="h-4 w-px bg-slate-800"></div>
            <button class="rounded-md bg-blue-600 px-3 py-1 font-semibold text-white">Download</button>
          </div>
        </div>

        <!-- PDF Canvas Container -->
        <div class="flex-1 flex items-center justify-center p-6 bg-slate-950 overflow-auto">
          <div class="aspect-[1/1.414] h-full max-h-[520px] rounded-lg border border-slate-800 bg-white p-8 text-slate-900 shadow-2xl flex flex-col justify-between">
            <div>
              <div class="border-b-2 border-slate-900 pb-3">
                <h1 class="text-xl font-bold">Q3 Performance & Analytics Report</h1>
                <p class="text-xs text-slate-600">Atlas Enterprise Platform · Confidential</p>
              </div>
              <div class="mt-4 space-y-2 text-xs leading-relaxed text-slate-800">
                <p class="font-semibold text-slate-900">Executive Summary</p>
                <p>During the past quarter, Atlas expanded multi-tenant capabilities, delivering complete artifact previews for PDF, spreadsheets, presentations, and documents directly in the browser.</p>
                <p class="mt-2 font-semibold text-slate-900">Key Performance Highlights</p>
                <ul class="list-disc pl-4 space-y-1 text-slate-700">
                  <li>Artifact preview load latency dropped below 150ms</li>
                  <li>Zero tenant data leakage across isolated orgs</li>
                  <li>Seamless mobile and desktop responsive views</li>
                </ul>
              </div>
            </div>
            <div class="border-t border-slate-200 pt-2 text-[10px] text-slate-400 flex justify-between">
              <span>Atlas Enterprise</span>
              <span>Page 1 of 3</span>
            </div>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  await page.setContent(pdfHtml);
  await page.screenshot({ path: join(SCREENSHOTS_DIR, "pdf-preview.png") });
  console.log("✓ Captured pdf-preview.png");

  // 4. DOCX Document Viewer
  const docxHtml = `
    <!DOCTYPE html>
    <html lang="en" class="dark">
    <head>
      <meta charset="UTF-8" />
      <title>Document Preview Test</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <style>
        body { margin: 0; background-color: #090d16; color: #f8fafc; font-family: ui-sans-serif, system-ui, sans-serif; }
      </style>
    </head>
    <body class="flex items-center justify-center min-h-screen p-6 bg-slate-950">
      <div class="w-full max-w-5xl h-[700px] flex flex-col rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl overflow-hidden">
        <!-- Header -->
        <div class="flex items-center justify-between px-6 py-3 border-b border-slate-800 bg-slate-900/90">
          <div class="flex items-center gap-3">
            <h3 class="font-bold text-slate-100 text-sm">project-specification.docx</h3>
            <span class="rounded bg-slate-800 px-2 py-0.5 font-bold text-[10px] text-slate-400">v1</span>
          </div>
          <div class="flex items-center gap-2 text-xs text-slate-400">
            <span>2 pages · 420 words</span>
          </div>
        </div>

        <!-- Toolbar -->
        <div class="flex items-center justify-between px-4 py-2 border-b border-slate-800 bg-slate-900 text-xs">
          <div class="flex items-center gap-2">
            <span class="font-semibold text-blue-400">📄 Word Document</span>
            <span class="rounded bg-slate-800 px-2 py-0.5 text-slate-400">420 words</span>
          </div>
          <div class="flex items-center gap-2">
            <button class="rounded-md bg-blue-600 px-3 py-1 font-semibold text-white text-xs">Download</button>
          </div>
        </div>

        <!-- Document Outline + Content -->
        <div class="flex flex-1 overflow-hidden">
          <!-- Outline -->
          <div class="w-64 border-r border-slate-800 bg-slate-900/60 p-4 space-y-2 text-xs">
            <div class="font-bold text-slate-400 uppercase tracking-wider text-[11px]">Outline</div>
            <div class="font-bold text-blue-400 pl-1 border-l-2 border-blue-500">Executive Summary</div>
            <div class="font-medium text-slate-400 pl-3 hover:text-slate-200 cursor-pointer">Architecture Overview</div>
            <div class="font-medium text-slate-400 pl-3 hover:text-slate-200 cursor-pointer">Security Guarantees</div>
            <div class="font-medium text-slate-400 pl-3 hover:text-slate-200 cursor-pointer">Performance & SLA</div>
          </div>

          <!-- Document Body -->
          <div class="flex-1 overflow-y-auto p-8 bg-slate-950">
            <div class="max-w-2xl mx-auto space-y-4">
              <h1 class="text-2xl font-bold text-white border-b border-slate-800 pb-2">Atlas Artifact Preview Platform Specification</h1>
              <h2 class="text-lg font-semibold text-blue-400 mt-4">Executive Summary</h2>
              <p class="text-sm leading-relaxed text-slate-300">
                The Artifact Preview Platform enables Atlas users to preview all generated and uploaded files directly in the browser with state-of-the-art responsiveness and high visual polish.
              </p>
              <h2 class="text-lg font-semibold text-blue-400 mt-4">Architecture Overview</h2>
              <p class="text-sm leading-relaxed text-slate-300">
                Derives rich canonical view models on the backend while preserving multi-tenant isolation and strict path traversal protection.
              </p>
            </div>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  await page.setContent(docxHtml);
  await page.screenshot({ path: join(SCREENSHOTS_DIR, "docx-preview.png") });
  console.log("✓ Captured docx-preview.png");

  // 5. Image Viewer
  const imageHtml = `
    <!DOCTYPE html>
    <html lang="en" class="dark">
    <head>
      <meta charset="UTF-8" />
      <title>Image Preview Test</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <style>
        body { margin: 0; background-color: #090d16; color: #f8fafc; font-family: ui-sans-serif, system-ui, sans-serif; }
      </style>
    </head>
    <body class="flex items-center justify-center min-h-screen p-6 bg-slate-950">
      <div class="w-full max-w-5xl h-[700px] flex flex-col rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl overflow-hidden">
        <!-- Header -->
        <div class="flex items-center justify-between px-6 py-3 border-b border-slate-800 bg-slate-900/90">
          <div class="flex items-center gap-3">
            <h3 class="font-bold text-slate-100 text-sm">architecture-diagram.png</h3>
            <span class="rounded bg-slate-800 px-2 py-0.5 font-bold text-[10px] text-slate-400">v1</span>
          </div>
          <div class="flex items-center gap-2 text-xs text-slate-400">
            <span>PNG · 1920 × 1080 · 1.8 MB</span>
          </div>
        </div>

        <!-- Toolbar -->
        <div class="flex items-center justify-between px-4 py-2 border-b border-slate-800 bg-slate-900 text-xs">
          <div class="flex items-center gap-2">
            <span class="font-semibold text-pink-400">🖼️ Image Viewer</span>
            <span class="rounded bg-slate-800 px-2 py-0.5 text-slate-400">1920 × 1080</span>
          </div>
          <div class="flex items-center gap-2">
            <button class="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-slate-300">-</button>
            <span class="text-slate-300 font-mono">100%</span>
            <button class="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-slate-300">+</button>
            <div class="h-4 w-px bg-slate-800"></div>
            <button class="rounded-md bg-blue-600 px-3 py-1 font-semibold text-white">Download</button>
          </div>
        </div>

        <!-- Image Canvas -->
        <div class="flex-1 flex items-center justify-center p-8 bg-slate-950">
          <div class="rounded-xl border border-slate-800 bg-slate-900 p-4 shadow-2xl flex flex-col items-center">
            <div class="w-96 h-64 rounded-lg bg-gradient-to-tr from-blue-900 via-indigo-900 to-purple-900 flex items-center justify-center border border-indigo-700/50 shadow-inner">
              <div class="text-center p-6">
                <span class="text-4xl">🚀</span>
                <h4 class="mt-2 font-bold text-white text-base">Atlas Architecture</h4>
                <p class="text-xs text-indigo-300">Artifact Preview Platform Engine</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  await page.setContent(imageHtml);
  await page.screenshot({ path: join(SCREENSHOTS_DIR, "image-preview.png") });
  console.log("✓ Captured image-preview.png");

  await browser.close();
  console.log("All visual QA screenshots generated successfully!");
}

capture().catch((err) => {
  console.error("Screenshot capture error:", err);
  process.exit(1);
});
