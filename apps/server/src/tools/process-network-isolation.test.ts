import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRestrictedProcess } from "../services/restricted-process";
import { runBash } from "./bash";
import { runPythonExecute } from "./python-execute-tool";

test("host network denial confines real Python and Bash descendants without disabling workspace writes", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "atlas-network-policy-"));
  const previous = process.env.ATLAS_PROCESS_NETWORK;
  let contacted = 0;
  const server = Bun.serve({
    fetch() {
      contacted++;
      return new Response("synthetic-local-response");
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const context = {
    orgId: "network-org",
    profileId: "network-profile",
    workspaceRoot,
  };
  try {
    if (process.platform !== "darwin") {
      process.env.ATLAS_PROCESS_NETWORK = "deny";
      await expect(
        prepareRestrictedProcess({
          args: ["-c", "true"],
          bin: "/bin/sh",
          workspaceRoot,
        })
      ).rejects.toThrow();
      return;
    }
    const code = `
import json, urllib.request
from pathlib import Path
try:
    body = urllib.request.urlopen('http://127.0.0.1:${server.port}/', timeout=2).read().decode()
except OSError:
    body = 'blocked'
Path('network-result.txt').write_text(body)
print(json.dumps({'result': body}))
`;
    process.env.ATLAS_PROCESS_NETWORK = "allow";
    const allowed = await runPythonExecute({ code }, context);
    expect(allowed.success).toBe(true);
    expect(JSON.parse(allowed.stdout).result).toBe("synthetic-local-response");
    expect(contacted).toBe(1);

    process.env.ATLAS_PROCESS_NETWORK = "deny";
    const denied = await runPythonExecute({ code }, context);
    expect(denied.success).toBe(true);
    expect(JSON.parse(denied.stdout).result).toBe("blocked");
    expect(
      await readFile(join(workspaceRoot, "network-result.txt"), "utf8")
    ).toBe("blocked");
    expect(contacted).toBe(1);

    const descendant = await runBash(
      {
        command: `if /usr/bin/curl --silent --max-time 2 http://127.0.0.1:${server.port}/ > response.txt; then exit 12; fi\nprintf confined > descendant.txt`,
        env: { ATLAS_PROCESS_NETWORK: "allow" },
      },
      context
    );
    expect(descendant.exitCode).toBe(0);
    expect(await readFile(join(workspaceRoot, "descendant.txt"), "utf8")).toBe(
      "confined"
    );
    expect(contacted).toBe(1);
  } finally {
    if (previous === undefined) {
      delete process.env.ATLAS_PROCESS_NETWORK;
    } else {
      process.env.ATLAS_PROCESS_NETWORK = previous;
    }
    await server.stop(true);
    await rm(workspaceRoot, { force: true, recursive: true });
  }
});

test("unknown host network settings fail closed before starting a command", async () => {
  const previous = process.env.ATLAS_PROCESS_NETWORK;
  process.env.ATLAS_PROCESS_NETWORK = "deny) (allow default";
  try {
    await expect(
      prepareRestrictedProcess({
        args: ["-c", "true"],
        bin: "/bin/sh",
        workspaceRoot: "/nonexistent-workspace",
      })
    ).rejects.toThrow();
  } finally {
    if (previous === undefined) {
      delete process.env.ATLAS_PROCESS_NETWORK;
    } else {
      process.env.ATLAS_PROCESS_NETWORK = previous;
    }
  }
});
