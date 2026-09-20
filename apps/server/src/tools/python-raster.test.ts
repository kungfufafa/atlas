import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { resolvePythonRuntime, runPythonExecute } from "./python-execute-tool";

const execFileAsync = promisify(execFile);
const SOURCE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMwTpv5HwAENAIyWy0K4AAAAABJRU5ErkJggg==",
  "base64"
);

test("a runtime without Pillow retains partial raster files without publishing artifacts", async () => {
  const fixtureRoot = await mkdtemp(
    path.join(tmpdir(), "atlas-python-raster-")
  );
  const runtimeRoot = path.join(fixtureRoot, "runtime");
  const workspaceRoot = path.join(fixtureRoot, "workspace");
  const previousPythonPath = process.env.ATLAS_PYTHON_PATH;

  try {
    // A fresh stdlib-only venv excludes both global and user site-packages,
    // even when the host's selected runtime already contains Pillow.
    await execFileAsync(
      resolvePythonRuntime(),
      ["-I", "-m", "venv", "--without-pip", runtimeRoot],
      { timeout: 10_000 }
    );
    process.env.ATLAS_PYTHON_PATH = path.join(runtimeRoot, "bin", "python3");
    await mkdir(path.join(workspaceRoot, ".sources"), { recursive: true });
    await writeFile(
      path.join(workspaceRoot, ".sources", "photo.png"),
      SOURCE_PNG
    );

    const result = await runPythonExecute(
      {
        code: `from pathlib import Path
Path('artifacts').mkdir()
Path('artifacts/partial.png').write_bytes(Path('.sources/photo.png').read_bytes())
from PIL import Image
Image.open('.sources/photo.png').transpose(Image.Transpose.FLIP_LEFT_RIGHT).save('artifacts/edited.png')`,
        files: [".sources/photo.png"],
      },
      { orgId: "org_fixture", profileId: "profile_fixture", workspaceRoot }
    );

    expect(result.success).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("ModuleNotFoundError");
    expect(result.stderr).toContain("'PIL'");
    expect(result.artifacts).toEqual([]);
    expect(result.artifactsGenerated).toEqual([
      {
        mimeType: "image/png",
        name: "partial.png",
        path: "artifacts/partial.png",
        size: SOURCE_PNG.length,
      },
    ]);
    expect(
      await readFile(path.join(workspaceRoot, "artifacts/partial.png"))
    ).toEqual(SOURCE_PNG);
    expect(
      await readFile(path.join(workspaceRoot, ".sources/photo.png"))
    ).toEqual(SOURCE_PNG);
  } finally {
    if (previousPythonPath === undefined) {
      delete process.env.ATLAS_PYTHON_PATH;
    } else {
      process.env.ATLAS_PYTHON_PATH = previousPythonPath;
    }
    await rm(fixtureRoot, { force: true, recursive: true });
  }
}, 20_000);
