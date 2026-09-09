import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

export const shuffleSeed = 20_260_906;
export const bootstrapSettings = { draws: 100_000, seed: 20_260_906 } as const;
export const sha256 = (data: string | Buffer): string =>
  createHash("sha256").update(data).digest("hex");

export function shuffle<T>(items: readonly T[], seed = shuffleSeed): T[] {
  // biome-ignore lint/suspicious/noBitwiseOperators: The schedule PRNG requires unsigned 32-bit state.
  let state = seed >>> 0;
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    // biome-ignore lint/suspicious/noBitwiseOperators: Explicit wraparound makes the preregistered schedule reproducible.
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const other = Math.floor((state / 4_294_967_296) * (index + 1));
    const temp = result[index];
    result[index] = result[other]!;
    result[other] = temp!;
  }
  return result;
}

export async function atlasSourceHashes(
  repository: string
): Promise<Record<string, string>> {
  const listing = Bun.spawn(
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: repository, stderr: "pipe", stdout: "pipe" }
  );
  const paths = (await new Response(listing.stdout).text())
    .split("\0")
    .filter(
      (path) =>
        /^(?:apps|packages)\//.test(path) ||
        [
          "package.json",
          "bun.lock",
          "tsconfig.json",
          "tsconfig.typecheck.json",
        ].includes(path)
    )
    .sort();
  if (await listing.exited) {
    throw new Error("Unable to enumerate Atlas source.");
  }
  const result: Record<string, string> = {};
  for (const path of paths) {
    result[path] = sha256(await readFile(join(repository, path)));
  }
  return result;
}

export async function harnessSourceHashes(
  repository: string
): Promise<Record<string, string>> {
  const names = (await readdir(join(repository, "scripts/harness-compare")))
    .filter((name) => /\.(?:ts|py|json)$/.test(name))
    .sort();
  const result: Record<string, string> = {};
  for (const name of names) {
    const path = `scripts/harness-compare/${name}`;
    result[path] = sha256(await readFile(join(repository, path)));
  }
  return result;
}

export async function hermesSourceHashes(
  root: string
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name)
    );
    for (const entry of entries) {
      if (
        [".git", "__pycache__", "node_modules", ".pytest_cache"].includes(
          entry.name
        ) ||
        entry.name.endsWith(".egg-info")
      ) {
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (
        entry.isFile() &&
        /\.(?:py|yaml|toml|json|md)$/.test(entry.name)
      ) {
        result[relative(root, path)] = sha256(await readFile(path));
      }
    }
  };
  await visit(root);
  return result;
}

export async function assertFrozenFiles(
  repository: string,
  hashes: Record<string, string>
): Promise<void> {
  for (const [path, expected] of Object.entries(hashes)) {
    if (sha256(await readFile(join(repository, path))) !== expected) {
      throw new Error(`Frozen comparison input changed: ${path}`);
    }
  }
}
