import { spyOn } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { runWithUserConfigDir } from "../user-config";

let atlasConfigDirChain: Promise<void> = Promise.resolve();

/** Serializes ATLAS_CONFIG_DIR mutations across parallel bun test files. */
export async function withExclusiveAtlasConfigDir<T>(
  run: () => Promise<T>
): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = atlasConfigDirChain;
  atlasConfigDirChain = previous.then(() => gate);
  await previous;

  try {
    return await run();
  } finally {
    release();
  }
}

/** Serializes ATLAS_CONFIG_DIR and os.homedir() across parallel bun test files. */
export async function withIsolatedAtlasHome<T>(
  prefix: string,
  run: (homeDir: string) => Promise<T>
): Promise<T> {
  return withExclusiveAtlasConfigDir(async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), prefix));
    const configDir = path.join(homeDir, ".atlas");
    await mkdir(configDir, { recursive: true });
    const previousConfigDir = process.env.ATLAS_CONFIG_DIR;
    process.env.ATLAS_CONFIG_DIR = configDir;
    const homedirSpy = spyOn(os, "homedir").mockReturnValue(homeDir);

    try {
      return await runWithUserConfigDir(configDir, () => run(homeDir));
    } finally {
      homedirSpy.mockRestore();
      if (previousConfigDir === undefined) {
        delete process.env.ATLAS_CONFIG_DIR;
      } else {
        process.env.ATLAS_CONFIG_DIR = previousConfigDir;
      }
      await rm(homeDir, { force: true, recursive: true });
    }
  });
}
