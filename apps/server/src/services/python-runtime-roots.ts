import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { resolveRestrictedExecutable } from "./restricted-process";

const execFileAsync = promisify(execFile);
// Only trusted runtime introspection executes outside the boundary. -I -S
// disables environment, user-site, .pth and sitecustomize startup execution.
const DISCOVER_RUNTIME =
  "import json,sys,sysconfig; print(json.dumps([sysconfig.get_path(k) for k in ('stdlib','platstdlib','purelib','platlib')] + [sys.base_prefix + '/lib']))";

export async function resolvePythonReadRoots(
  runtime: string
): Promise<{ bin: string; readRoots: string[] }> {
  const bin = await resolveRestrictedExecutable(runtime);
  const { stdout } = await execFileAsync(
    bin,
    ["-I", "-S", "-c", DISCOVER_RUNTIME],
    {
      env: { LANG: "en_US.UTF-8", PATH: "/usr/bin:/bin" },
      maxBuffer: 64 * 1024,
      timeout: 10_000,
    }
  );
  const paths: unknown = JSON.parse(stdout);
  if (
    !(
      Array.isArray(paths) &&
      paths.every(
        (value): value is string =>
          typeof value === "string" && path.isAbsolute(value)
      )
    )
  ) {
    throw new Error(
      "Python runtime did not report valid absolute library paths."
    );
  }
  const venvRoot = path.dirname(path.dirname(bin));
  if (existsSync(path.join(venvRoot, "pyvenv.cfg"))) {
    paths.push(
      path.join(venvRoot, "pyvenv.cfg"),
      path.join(venvRoot, "lib"),
      path.join(venvRoot, "bin")
    );
  }
  return { bin, readRoots: paths };
}
