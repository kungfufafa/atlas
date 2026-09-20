import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { release } from "node:os";
import { join } from "node:path";
import { runBash } from "../../apps/server/src/tools/bash";
import { runPythonExecute } from "../../apps/server/src/tools/python-execute-tool";

// Runs as the production image's non-root user, without mounting host data.
assert.equal(process.platform, "linux");
assert.equal(
  process.getuid?.(),
  1000,
  "Container verification must run as the production non-root user."
);
const root = await mkdtemp("/atlas/data/file-check-");
const workspaceRoot = join(root, "profile");
const sibling = join(root, "other-profile", "private.txt");
await mkdir(workspaceRoot, { recursive: true });
await mkdir(join(root, "other-profile"), { recursive: true });
await writeFile(sibling, "synthetic sibling canary");
const context = {
  orgId: "container-check",
  profileId: "profile",
  workspaceRoot,
};
const runtimeCheck = await readFile(join(import.meta.dir, "verify.py"), "utf8");
const python = await runPythonExecute(
  {
    code: `${runtimeCheck}\nfrom pathlib import Path\ntry:\n    Path(${JSON.stringify(sibling)}).read_text()\nexcept PermissionError:\n    pass\nelse:\n    raise AssertionError("Sibling read escaped filesystem isolation")\n`,
    timeout: 120_000,
  },
  context
);
assert.equal(python.success, true, python.stderr);
assert.equal(python.exitCode, 0, python.stderr);
assert.equal(JSON.parse(python.stdout.trim()).status, "passed");
for (const [filename, mimeType] of [
  ["edited.jpg", "image/jpeg"],
  ["edited.png", "image/png"],
] as const) {
  const artifactPath = `artifacts/runtime-check/${filename}`;
  const artifacts = python.artifacts.filter(
    (artifact) => artifact.path === artifactPath
  );
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0]?.filename, filename);
  assert.equal(artifacts[0]?.mimeType, mimeType);
  assert.equal(
    artifacts[0]?.sizeBytes,
    (await readFile(join(workspaceRoot, artifactPath))).length
  );
}
// A nonzero cat alone cannot distinguish a permission denial from another
// failure. This child runs within Bash's inherited boundary and requires the
// actual filesystem operations to fail with EPERM/EACCES, never ENOENT.
const permissionProbe = `
import errno, json, sys
from pathlib import Path
target = Path(sys.argv[1])
denied = {}
for operation in ('read', 'write'):
    try:
        target.read_bytes() if operation == 'read' else target.write_bytes(b'ESCAPED')
    except PermissionError as error:
        assert error.errno in (errno.EPERM, errno.EACCES)
        denied[operation] = error.errno
    else:
        raise AssertionError(operation + ' escaped the filesystem boundary')
print(json.dumps(denied))
`;
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
const bash = await runBash(
  {
    command: `set -euo pipefail
printf 'workspace allowed' > allowed.txt
test "$(/bin/cat allowed.txt)" = 'workspace allowed'
if (: < ${shellQuote(sibling)}) 2>/dev/null; then exit 7; fi
if (: > ${shellQuote(sibling)}) 2>/dev/null; then exit 8; fi
/usr/bin/python3 -I -c ${shellQuote(permissionProbe)} ${shellQuote(sibling)}`,
  },
  context
);
assert.equal(bash.exitCode, 0, bash.stderr);
assert.equal(bash.timedOut, false);
const bashDenied: unknown = JSON.parse(bash.stdout.trim());
assert.ok(typeof bashDenied === "object" && bashDenied !== null);
assert.deepEqual(Object.keys(bashDenied).sort(), ["read", "write"]);
for (const errorNumber of Object.values(bashDenied)) {
  assert.ok(errorNumber === 1 || errorNumber === 13);
}
assert.equal(await readFile(sibling, "utf8"), "synthetic sibling canary");
console.log(
  JSON.stringify({
    evidenceClass: "actual production container processes",
    filesystem: {
      bash: { deniedErrnos: bashDenied },
      python: "sibling read denied",
    },
    liveMessengers: "NOT_RUN",
    liveProvider: "NOT_RUN",
    python: JSON.parse(python.stdout.trim()),
    runtime: {
      architecture: process.arch,
      bun: Bun.version,
      kernel: release(),
      platform: process.platform,
      uid: process.getuid?.(),
    },
    status: "passed",
  })
);
