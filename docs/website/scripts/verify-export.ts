import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const websiteDir = path.join(import.meta.dir, "..");
const contentDir = path.join(websiteDir, "content", "docs");
const outputDir = path.join(websiteDir, "out");

async function assertExportedFile(relativePath: string): Promise<void> {
  const metadata = await stat(path.join(outputDir, relativePath));
  assert(
    metadata.isFile() && metadata.size > 0,
    `Missing export: ${relativePath}`
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

const search = asRecord(
  JSON.parse(await readFile(path.join(outputDir, "api", "search"), "utf8"))
);
const searchDocuments = asRecord(asRecord(search.docs).docs);
const searchPageUrls = new Set(
  Object.values(searchDocuments)
    .map(asRecord)
    .filter((document) => document.type === "page")
    .map((document) => document.url)
);

let pages = 0;
for (const entry of await readdir(contentDir, { recursive: true })) {
  if (!entry.endsWith(".mdx")) {
    continue;
  }
  const relativePath = entry.slice(0, -4);
  const route = relativePath.endsWith(`${path.sep}index`)
    ? path.dirname(relativePath)
    : relativePath;
  await assertExportedFile(path.join(route, "index.html"));
  const pageUrl = `/${route.split(path.sep).join("/")}`;
  assert(searchPageUrls.has(pageUrl), `Missing search page: ${pageUrl}`);
  pages++;
}
assert(pages > 0, "No MDX pages were checked");
for (const relativePath of ["index.html", "llms.txt", "sitemap.xml"]) {
  await assertExportedFile(relativePath);
}

process.stdout.write(
  `Verified ${pages} docs pages, search entries, and exports.\n`
);
