import { readFile } from "node:fs/promises";
import path from "node:path";

const BOOTSTRAP_ENVIRONMENT =
  /^(?:LD_|DYLD_|BUN_|ATLAS_RESTRICTED_)|^(?:NODE_OPTIONS|NODE_PATH)$/;

/** These variables act before the trusted launcher can install Landlock. */
export function validateRestrictedProcessLinuxEnvironment(
  env: NodeJS.ProcessEnv | undefined
): void {
  for (const key of Object.keys(env ?? {})) {
    if (BOOTSTRAP_ENVIRONMENT.test(key)) {
      throw new Error(
        `Restricted process environment variable ${key} is reserved for the confined runtime.`
      );
    }
  }
}

export function restrictedProcessLinuxBootstrapArgs(
  launcherPath: string
): string[] {
  return [
    "--config=/dev/null",
    "--env-file=/dev/null",
    "--no-install",
    launcherPath,
  ];
}

/** Bind the prepared rules to every source used by the trusted C launcher. */
export async function readRestrictedProcessLinuxPolicy(
  rulesSource: string,
  launcherPath: string
): Promise<string> {
  const directory = path.dirname(launcherPath);
  const sources = await Promise.all([
    readFile(launcherPath, "utf8"),
    readFile(path.join(directory, "restricted-process-linux.c"), "utf8"),
    readFile(path.join(directory, "javascript-tool-sandbox-linux.c"), "utf8"),
  ]);
  return JSON.stringify([rulesSource, ...sources]);
}
