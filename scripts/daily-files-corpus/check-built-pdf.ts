/** Bundled package-resolution smoke, not a simulated HTTP/model invocation. */
import {
  copyFile,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildServer } from "../../apps/server/scripts/build";

const repository = path.resolve(import.meta.dir, "../..");
const output = await mkdtemp(
  path.join(repository, "apps/server/.daily-pdf-build-")
);
const workspace = await mkdtemp(path.join(tmpdir(), "atlas-built-pdf-"));
const evidence = path.resolve(
  process.argv[2] ?? "/private/tmp/atlas-built-pdf-evidence.json"
);
try {
  await buildServer({ outdir: output });
  const serverBytes = (await stat(path.join(output, "index.js"))).size;
  for (const filename of [
    "pdf-libreoffice-report.pdf",
    "pdf-scanned-reportlab.pdf",
  ]) {
    await copyFile(
      path.join(repository, "packages/core/src/testing/fixtures", filename),
      path.join(workspace, filename)
    );
  }
  const entry = path.join(output, "pdf-smoke.ts");
  await writeFile(
    entry,
    `
import { pdfDocumentTool } from ${JSON.stringify(path.join(repository, "packages/core/src/tools/pdf-document.ts"))};
import { executeProtectedTool } from ${JSON.stringify(path.join(repository, "packages/core/src/tools/execution.ts"))};
const results = [];
for (const filename of ["pdf-libreoffice-report.pdf","pdf-scanned-reportlab.pdf"]) {
  const result = await executeProtectedTool(pdfDocumentTool,{operation:"extract",documentRef:filename},{workspaceRoot:process.argv[2]});
  if (!result.success) throw new Error(JSON.stringify(result.error));
  results.push({filename,...result});
}
process.stdout.write(JSON.stringify(results));
`
  );
  const bundle = Bun.spawn(
    [
      process.execPath,
      "build",
      entry,
      "--target=bun",
      `--outfile=${path.join(output, "pdf-smoke.js")}`,
    ],
    { stderr: "pipe", stdout: "pipe" }
  );
  const [bundleCode, bundleErrors] = await Promise.all([
    bundle.exited,
    new Response(bundle.stderr).text(),
    new Response(bundle.stdout).text(),
  ]);
  if (bundleCode !== 0) {
    throw new Error(bundleErrors);
  }
  const run = Bun.spawn(
    [process.execPath, path.join(output, "pdf-smoke.js"), workspace],
    {
      cwd: workspace,
      env: { HOME: workspace, TMPDIR: workspace },
      stderr: "pipe",
      stdout: "pipe",
    }
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    run.exited,
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr);
  }
  const results = JSON.parse(stdout) as Array<{
    data: {
      complete: boolean;
      pages: Array<{ text: string; needsOcr: boolean }>;
    };
  }>;
  if (
    !results[0]?.data.pages[0]?.text.includes("Total units: 18") ||
    results[1]?.data.complete !== false ||
    results[1]?.data.pages[0]?.needsOcr !== true
  ) {
    throw new Error(
      "Bundled PDF results did not match the independent fixtures."
    );
  }
  await writeFile(
    evidence,
    JSON.stringify(
      {
        results,
        scope:
          "Full server compilation plus real protected PDF extraction from a bundled entry under the server package; no HTTP/model invocation",
        serverBytes,
        stderr,
      },
      null,
      2
    )
  );
  process.stdout.write(`${await readFile(evidence, "utf8")}\n`);
} finally {
  await rm(output, { force: true, recursive: true });
  await rm(workspace, { force: true, recursive: true });
}
