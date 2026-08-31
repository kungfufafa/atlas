import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

const serverRoot = path.resolve(import.meta.dir, "..");
const sourceRoot = path.join(serverRoot, "src");
const runtimeAssetNames = [
  "javascript-tool-runner.js",
  "javascript-tool-sandbox-linux.c",
  "javascript-tool-sandbox-linux.js",
] as const;
const serverExternals = [
  "playwright",
  "playwright-core",
  "@openai/codex",
  "@anthropic-ai/claude-agent-sdk",
];

export interface BuildServerOptions {
  outdir?: string;
}

export async function buildServer(
  options: BuildServerOptions = {}
): Promise<string> {
  const outdir = path.resolve(options.outdir ?? path.join(serverRoot, "dist"));
  await mkdir(outdir, { recursive: true });

  // Keep dependency resolution identical to `bun build` run from this workspace.
  // Bun.build's JavaScript API currently resolves workspace-package dependencies
  // relative to the caller, which breaks when this helper is imported by a root test.
  const buildProcess = Bun.spawn({
    cmd: [
      process.execPath,
      "build",
      "./src/index.ts",
      `--outdir=${outdir}`,
      "--target=bun",
      ...serverExternals.map((dependency) => `--external=${dependency}`),
    ],
    cwd: serverRoot,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    buildProcess.exited,
    new Response(buildProcess.stderr).text(),
    new Response(buildProcess.stdout).text(),
  ]);
  if (exitCode !== 0) {
    const diagnostics = [stdout.trim(), stderr.trim()]
      .filter(Boolean)
      .join("\n");
    throw new Error(`Server build failed:\n${diagnostics}`);
  }

  const serviceRoot = path.join(sourceRoot, "services");
  await Promise.all(
    runtimeAssetNames.map((assetName) =>
      copyFile(path.join(serviceRoot, assetName), path.join(outdir, assetName))
    )
  );
  return outdir;
}

function parseOutdir(args: string[]): string | undefined {
  const outdirIndex = args.indexOf("--outdir");
  if (outdirIndex === -1) {
    return;
  }
  const value = args[outdirIndex + 1]?.trim();
  if (!value) {
    throw new Error("--outdir requires a directory path.");
  }
  return value;
}

if (import.meta.main) {
  await buildServer({ outdir: parseOutdir(process.argv.slice(2)) });
}
