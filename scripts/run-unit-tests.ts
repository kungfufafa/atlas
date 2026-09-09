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

interface UnitTestShard {
  index: number;
  total: number;
}

const SHARD_ARGUMENT = /^(\d+)\/(\d+)$/;

export function parseUnitTestArguments(arguments_: readonly string[]): {
  forwardedArguments: string[];
  shard?: UnitTestShard;
} {
  const forwardedArguments: string[] = [];
  let shard: UnitTestShard | undefined;
  const iterator = arguments_.values();
  for (const argument of iterator) {
    if (argument === "--shard" || argument.startsWith("--shard=")) {
      const value =
        argument === "--shard"
          ? iterator.next().value
          : argument.slice("--shard=".length);
      const match = value?.match(SHARD_ARGUMENT);
      const shardIndex = Number(match?.[1]);
      const total = Number(match?.[2]);
      if (
        shard ||
        !Number.isSafeInteger(shardIndex) ||
        !Number.isSafeInteger(total) ||
        shardIndex < 1 ||
        total < 1 ||
        shardIndex > total
      ) {
        throw new Error("Specify one valid --shard=N/M with 1 <= N <= M.");
      }
      shard = { index: shardIndex, total };
    } else {
      if (
        argument.startsWith("--parallel") ||
        argument === "--isolate" ||
        argument.startsWith("--isolate=") ||
        argument === "--test-worker"
      ) {
        throw new Error(
          "The unit runner owns process isolation and its two-process concurrency limit."
        );
      }
      forwardedArguments.push(argument);
    }
  }
  return { forwardedArguments, shard };
}

export function partitionUnitTestFiles(
  files: readonly string[],
  shard?: UnitTestShard
): string[] {
  return files.filter(
    (_, index) => !shard || index % shard.total === shard.index - 1
  );
}

interface UnitTestProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

type UnitTestExecutor = (
  command: string[],
  options: UnitTestProcessOptions
) => Promise<number>;

const executeUnitTest: UnitTestExecutor = async (command, options) => {
  const child = Bun.spawn(command, {
    ...options,
    stderr: "inherit",
    stdin: "inherit",
    stdout: "inherit",
  });
  return await child.exited;
};

export async function runUnitTestFiles(
  projectRoot: string,
  files: readonly string[],
  arguments_: readonly string[] = [],
  execute: UnitTestExecutor = executeUnitTest
): Promise<string[]> {
  let nextIndex = 0;
  const failedFiles: string[] = [];
  const runWorker = async () => {
    while (nextIndex < files.length) {
      const file = files[nextIndex++]!;
      try {
        // A fresh OS process also resets native stdio and child-process state.
        // CI observed native stdio errors with Bun 1.3.14's reused workers.
        const exitCode = await execute(
          [process.execPath, "test", ...arguments_, file],
          {
            cwd: projectRoot,
            env: {
              ...process.env,
              LLM_VCR_MODE: process.env.LLM_VCR_MODE ?? "replay",
            },
          }
        );
        if (exitCode !== 0) {
          failedFiles.push(file);
        }
      } catch (error) {
        failedFiles.push(file);
        console.error(`Could not execute unit tests in ${file}:`, error);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(2, files.length) }, runWorker)
  );
  return failedFiles.sort();
}

export async function runUnitTests(
  projectRoot: string,
  arguments_: readonly string[] = []
): Promise<number> {
  const { forwardedArguments, shard } = parseUnitTestArguments(arguments_);
  const discoveredFiles = await collectUnitTestFiles(projectRoot);
  if (discoveredFiles.length === 0) {
    throw new Error(
      "No unit test files were discovered in the configured scopes."
    );
  }
  const files = partitionUnitTestFiles(discoveredFiles, shard);
  const failedFiles = await runUnitTestFiles(
    projectRoot,
    files,
    forwardedArguments
  );
  console.info(
    `Completed ${files.length} unit test files; ${failedFiles.length} failed.`
  );
  if (failedFiles.length > 0) {
    console.error(failedFiles.join("\n"));
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  process.exitCode = await runUnitTests(
    resolve(import.meta.dir, ".."),
    process.argv.slice(2)
  );
}
