import { lstat, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

// Keep the same application/package and release-gate coverage as the original
// test command. Smoke and heavy jobs remain independently runnable as before.
export const UNIT_TEST_SCOPES = [
  "apps",
  "packages",
  "scripts/e2e-critical-paths.test.ts",
  "scripts/release-gate",
  "scripts/pm2-deploy.test.ts",
  "scripts/verify-docker-startup.test.ts",
  "scripts/verify-docker-health.test.ts",
  "scripts/run-unit-tests.test.ts",
] as const;

// Bun 1.3.14 discovers both dot/underscore test/spec suffixes with all eight
// supported JavaScript/TypeScript extensions (including module variants).
const TEST_FILE = /[._](?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/;
const EXCLUDED_DIRECTORIES = new Set(["node_modules", ".git"]);

export async function collectUnitTestFiles(
  projectRoot: string,
  scopes: readonly string[] = UNIT_TEST_SCOPES
): Promise<string[]> {
  const files = new Set<string>();
  const addFile = (path: string) => {
    if (TEST_FILE.test(path)) {
      files.add(`./${relative(projectRoot, path).split(sep).join("/")}`);
    }
  };
  const visitDirectory = async (directory: string): Promise<void> => {
    // Read and close one directory at a time. Bun's bare CLI path filters scan
    // the whole monorepo before running tests and can exhaust file descriptors.
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
          await visitDirectory(path);
        }
      } else if (entry.isFile()) {
        addFile(path);
      }
    }
  };

  for (const scope of scopes) {
    const path = resolve(projectRoot, scope);
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      await visitDirectory(path);
    } else if (entry.isFile()) {
      addFile(path);
    }
  }
  return [...files].sort();
}

export async function runUnitTests(
  projectRoot: string,
  arguments_: readonly string[] = []
): Promise<number> {
  const files = await collectUnitTestFiles(projectRoot);
  if (files.length === 0) {
    throw new Error(
      "No unit test files were discovered in the configured scopes."
    );
  }
  const child = Bun.spawn(
    [process.execPath, "test", "--parallel=2", ...arguments_, ...files],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        LLM_VCR_MODE: process.env.LLM_VCR_MODE ?? "replay",
      },
      stderr: "inherit",
      stdin: "inherit",
      stdout: "inherit",
    }
  );
  return await child.exited;
}

if (import.meta.main) {
  process.exitCode = await runUnitTests(
    resolve(import.meta.dir, ".."),
    process.argv.slice(2)
  );
}
