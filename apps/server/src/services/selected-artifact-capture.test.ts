import { expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir as testTemporaryDirectory } from "node:os";
import { join, join as joinTestTemporaryPath } from "node:path";
import type { Readable, Writable } from "node:stream";
import { resolvePythonRuntime } from "../tools/python-execute-tool";
import { resolveRestrictedExecutable } from "./restricted-process";
import { createSelectedArtifactCapture } from "./selected-artifact-capture";
import { SELECTED_ARTIFACT_CAPTURE_SCRIPT } from "./selected-artifact-capture-worker";

async function fixture(
  run: (profile: string, foreign: string, directory: string) => Promise<void>
) {
  const directory = await realpath(
    await mkdtemp(
      joinTestTemporaryPath(
        testTemporaryDirectory(),
        "atlas-selected-capture-test-"
      )
    )
  );
  const profile = join(directory, "profile");
  const foreign = join(directory, "foreign");
  await mkdir(join(profile, "artifacts", "nested"), { recursive: true });
  await mkdir(join(foreign, "artifacts", "nested"), { recursive: true });
  await writeFile(
    join(profile, "artifacts", "nested", "selected.txt"),
    "selected existing bytes"
  );
  await writeFile(
    join(foreign, "artifacts", "nested", "selected.txt"),
    "foreign secret must not escape"
  );
  try {
    await run(profile, foreign, directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
async function expectedRoot(profile: string) {
  const value = await stat(profile, { bigint: true });
  return { device: String(value.dev), inode: String(value.ino) };
}

// A fixture copy inserts a deterministic OS-pipe barrier into the exact static
// worker. No barrier/environment hook exists in the production capture API.
async function barrierCapture(
  profile: string,
  marker: string,
  mutate: () => Promise<void>,
  sourcePath = "artifacts/nested/selected.txt"
) {
  const insertion = `os.write(3, b"barrier\\n"); require(os.read(4, 1) == b"x", "TEST_NO_ACK")`;
  const token = `# ${marker}`;
  expect(SELECTED_ARTIFACT_CAPTURE_SCRIPT.split(token).length).toBe(2);
  const script = SELECTED_ARTIFACT_CAPTURE_SCRIPT.replace(
    token,
    marker === "CAPTURE_PARENT_OPENED"
      ? `if name == "nested": ${insertion}`
      : marker === "CAPTURE_CHUNK_READ"
        ? `if len(chunks) == 1: ${insertion}`
        : insertion
  );
  const runtime = await resolveRestrictedExecutable(resolvePythonRuntime());
  const input = {
    expectedRoot: await expectedRoot(profile),
    operation: "capture",
    root: profile,
    sourcePath,
  };
  const child = spawn(runtime, ["-I", "-S", "-u", "-c", script], {
    cwd: "/",
    env: { PATH: "/usr/bin:/bin" },
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
  });
  const output: Buffer[] = [];
  const diagnostics: Buffer[] = [];
  child.stdout!.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr!.on("data", (chunk: Buffer) => diagnostics.push(chunk));
  const done = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reached = new Promise<void>((resolve, reject) => {
      (child.stdio[3] as Readable).once("data", () => resolve());
      child.once("close", (code) =>
        reject(
          new Error(
            `Reader exited before barrier: ${code} ${Buffer.concat(diagnostics).toString()}`
          )
        )
      );
      timer = setTimeout(
        () => reject(new Error("Reader barrier timeout")),
        5000
      );
    });
    child.stdin!.end(JSON.stringify(input));
    await reached;
    expect(child.exitCode).toBeNull();
    await mutate();
    (child.stdio[4] as Writable).end("x");
    const code = await done;
    const result = JSON.parse(Buffer.concat(output).toString("utf8")) as {
      error?: { code: string };
      bytesBase64?: string;
    };
    expect(code).toBe(2);
    expect(result.error).toBeDefined();
    expect(result.bytesBase64).toBeUndefined();
    return result.error!.code;
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
    await done;
  }
}

test("captures explicit existing bytes with bound identity, size and digest while preserving source", async () =>
  fixture(async (profile) => {
    const capture = await createSelectedArtifactCapture(profile);
    const result = await capture.capture("artifacts/nested/selected.txt");
    expect(result.bytes.toString()).toBe("selected existing bytes");
    expect(result.evidence.kind).toBe("selected_workspace_capture");
    expect(result.evidence.reader).toBe("posix_dirfd_nofollow");
    expect(result.evidence.rootIdentity).toEqual(await expectedRoot(profile));
    expect(result.evidence.sha256).toBe(
      createHash("sha256").update(result.bytes).digest("hex")
    );
    expect(result.evidence.sizeBytes).toBe(result.bytes.length);
    expect(result.evidence.observedMetadataStable).toBe(true);
    await writeFile(
      join(profile, "artifacts", "nested", "selected.txt"),
      "changed later"
    );
    expect(result.bytes.toString()).toBe("selected existing bytes");
    expect(
      (await capture.capture("artifacts/nested/selected.txt")).bytes.toString()
    ).toBe("changed later");
  }));

test("rejects noncanonical, hidden, sidecar, traversal and absolute selections", async () =>
  fixture(async (profile, foreign) => {
    const capture = await createSelectedArtifactCapture(profile);
    for (const name of [
      "../foreign/artifacts/nested/selected.txt",
      join(foreign, "artifacts/nested/selected.txt"),
      "artifacts/../selected.txt",
      "artifacts//selected.txt",
      "artifacts/.sources/private.pdf",
      "artifacts/nested/.hidden",
      "artifacts/file.atlas-meta.json",
      "artifacts/file.ATLAS-META.JSON",
      "artifacts/file\\name",
      "artifacts/file\u0000name",
      "SOUL.md",
    ]) {
      await expect(capture.capture(name)).rejects.toThrow();
    }
  }));

test("rejects root/parent/final symlinks and hardlinked foreign files", async () =>
  fixture(async (profile, foreign, directory) => {
    await symlink(profile, join(directory, "root-link"));
    await expect(
      createSelectedArtifactCapture(join(directory, "root-link"))
    ).rejects.toThrow();
    const capture = await createSelectedArtifactCapture(profile);
    await symlink(
      join(foreign, "artifacts"),
      join(profile, "artifacts", "foreign")
    );
    await symlink(
      join(foreign, "artifacts", "nested", "selected.txt"),
      join(profile, "artifacts", "linked.txt")
    );
    await link(
      join(foreign, "artifacts", "nested", "selected.txt"),
      join(profile, "artifacts", "hardlinked.txt")
    );
    for (const name of [
      "artifacts/foreign/nested/selected.txt",
      "artifacts/linked.txt",
      "artifacts/hardlinked.txt",
      "artifacts/nested",
    ]) {
      await expect(capture.capture(name)).rejects.toThrow();
    }
    expect(
      await readFile(
        join(foreign, "artifacts", "nested", "selected.txt"),
        "utf8"
      )
    ).toBe("foreign secret must not escape");
  }));

test("replacing the profile root cannot refresh the captured root authority", async () =>
  fixture(async (profile, foreign, directory) => {
    const capture = await createSelectedArtifactCapture(profile);
    await rename(profile, join(directory, "old-profile"));
    await rename(foreign, profile);
    await expect(
      capture.capture("artifacts/nested/selected.txt")
    ).rejects.toThrow();
  }));

test("directory rename and foreign symlink replacement after open returns no usable bytes", async () =>
  fixture(async (profile, foreign) => {
    const code = await barrierCapture(
      profile,
      "CAPTURE_PARENT_OPENED",
      async () => {
        const nested = join(profile, "artifacts", "nested");
        await rename(nested, join(profile, "artifacts", "original"));
        await symlink(join(foreign, "artifacts", "nested"), nested);
      }
    );
    expect(["DIRECTORY_REPLACED", "DIRECTORY_CHANGED"]).toContain(code);
  }));

test("directory rename and real foreign-directory replacement after open returns no usable bytes", async () =>
  fixture(async (profile, foreign) => {
    const code = await barrierCapture(
      profile,
      "CAPTURE_PARENT_OPENED",
      async () => {
        const nested = join(profile, "artifacts", "nested");
        await rename(nested, join(profile, "artifacts", "original"));
        await rename(join(foreign, "artifacts", "nested"), nested);
      }
    );
    expect(["DIRECTORY_REPLACED", "DIRECTORY_CHANGED"]).toContain(code);
  }));

test("root replacement after its descriptor is opened returns no usable bytes", async () =>
  fixture(async (profile, foreign, directory) => {
    const code = await barrierCapture(
      profile,
      "CAPTURE_ROOT_OPENED",
      async () => {
        await rename(profile, join(directory, "old-profile"));
        await symlink(foreign, profile);
      }
    );
    expect(code).toBe("DIRECTORY_REPLACED");
  }));

test("an added hardlink after open fails the post-read identity check", async () =>
  fixture(async (profile) => {
    const code = await barrierCapture(
      profile,
      "CAPTURE_FILE_OPENED",
      async () => {
        await link(
          join(profile, "artifacts", "nested", "selected.txt"),
          join(profile, "artifacts", "extra-link.txt")
        );
      }
    );
    expect(code).toBe("FILE_CHANGED");
  }));

test("same-size mutation during a bounded multichunk read returns no partial bytes", async () =>
  fixture(async (profile) => {
    const file = join(profile, "artifacts", "nested", "selected.txt");
    await writeFile(file, Buffer.alloc(256 * 1024, 65));
    const code = await barrierCapture(
      profile,
      "CAPTURE_CHUNK_READ",
      async () => {
        await writeFile(file, Buffer.alloc(256 * 1024, 66));
      }
    );
    expect(code).toBe("FILE_CHANGED");
  }));

test("oversized files and cancelled requests never return captured bytes", async () =>
  fixture(async (profile) => {
    const capture = await createSelectedArtifactCapture(profile);
    await truncate(
      join(profile, "artifacts", "nested", "selected.txt"),
      25 * 1024 * 1024 + 1
    );
    await expect(
      capture.capture("artifacts/nested/selected.txt")
    ).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(
      capture.capture("artifacts/nested/selected.txt", controller.signal)
    ).rejects.toThrow();
  }));

test("captures empty and exactly maximum-size regular files", async () =>
  fixture(async (profile) => {
    const capture = await createSelectedArtifactCapture(profile);
    const file = join(profile, "artifacts", "nested", "selected.txt");
    await truncate(file, 0);
    expect(
      (await capture.capture("artifacts/nested/selected.txt")).bytes.length
    ).toBe(0);
    await truncate(file, 25 * 1024 * 1024);
    const result = await capture.capture("artifacts/nested/selected.txt");
    expect(result.bytes.length).toBe(25 * 1024 * 1024);
    expect(result.evidence.sizeBytes).toBe(25 * 1024 * 1024);
  }));

test("FIFO capture rejects without waiting for another process to open it", async () =>
  fixture(async (profile) => {
    const runtime = await resolveRestrictedExecutable(resolvePythonRuntime());
    execFileSync(runtime, [
      "-I",
      "-S",
      "-c",
      "import os,sys; os.mkfifo(sys.argv[1])",
      join(profile, "artifacts", "pipe"),
    ]);
    const capture = await createSelectedArtifactCapture(profile);
    await expect(capture.capture("artifacts/pipe")).rejects.toThrow();
  }));

test("renaming a parent away and back is detected even when its final inode matches", async () =>
  fixture(async (profile) => {
    const code = await barrierCapture(
      profile,
      "CAPTURE_PARENT_OPENED",
      async () => {
        const nested = join(profile, "artifacts", "nested");
        const other = join(profile, "artifacts", "temporary");
        await rename(nested, other);
        await rename(other, nested);
      }
    );
    expect(code).toBe("DIRECTORY_CHANGED");
  }));

test("file replacement after open cannot substitute a different selected file", async () =>
  fixture(async (profile, foreign) => {
    const code = await barrierCapture(
      profile,
      "CAPTURE_FILE_OPENED",
      async () => {
        const selected = join(profile, "artifacts", "nested", "selected.txt");
        await rename(
          selected,
          join(profile, "artifacts", "nested", "original.txt")
        );
        await symlink(
          join(foreign, "artifacts", "nested", "selected.txt"),
          selected
        );
      }
    );
    expect(["FILE_CHANGED", "FILE_REPLACED"]).toContain(code);
  }));

async function fakeRuntime(
  directory: string,
  code: string,
  run: () => Promise<void>
) {
  const runtime = await resolveRestrictedExecutable(resolvePythonRuntime());
  const wrapper = join(directory, "trusted-test-runtime");
  await writeFile(wrapper, `#!${runtime}\nimport os,sys,json,time\n${code}\n`);
  await chmod(wrapper, 0o700);
  const old = process.env.ATLAS_PYTHON_PATH;
  process.env.ATLAS_PYTHON_PATH = wrapper;
  try {
    await run();
  } finally {
    if (old === undefined) {
      delete process.env.ATLAS_PYTHON_PATH;
    } else {
      process.env.ATLAS_PYTHON_PATH = old;
    }
  }
}

test("worker stdout and stderr overruns fail closed with no usable capture", async () =>
  fixture(async (profile, _foreign, directory) => {
    for (const code of [
      'sys.stdout.buffer.write(b"x" * (36 * 1024 * 1024)); sys.stdout.flush(); time.sleep(30)',
      'sys.stderr.write("x" * 8193); sys.stderr.flush(); time.sleep(30)',
    ]) {
      await fakeRuntime(directory, code, async () => {
        await expect(createSelectedArtifactCapture(profile)).rejects.toThrow();
      });
    }
  }));

test("cancelling an in-flight worker waits for termination and returns no bytes", async () =>
  fixture(async (profile, _foreign, directory) => {
    const ready = join(directory, "reader-ready");
    const code = `request=json.load(sys.stdin)\nif request["operation"] == "anchor":\n print(json.dumps({"rootIdentity":{"device":"1","inode":"2"}}))\nelse:\n open(${JSON.stringify(ready)}, "w").write(str(os.getpid()))\n time.sleep(30)`;
    await fakeRuntime(directory, code, async () => {
      const capture = await createSelectedArtifactCapture(profile);
      const controller = new AbortController();
      const outcome = capture
        .capture("artifacts/nested/selected.txt", controller.signal)
        .then(
          (value) => ({ value }),
          (error) => ({ error })
        );
      let pid: number | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const value = await readFile(ready, "utf8").catch(() => "");
        if (value) {
          pid = Number(value);
          break;
        }
        await Bun.sleep(10);
      }
      expect(pid).toBeDefined();
      controller.abort();
      expect("error" in (await outcome)).toBe(true);
      expect(() => process.kill(pid!, 0)).toThrow();
    });
  }));

test(
  "the fixed deadline terminates a stalled worker",
  async () =>
    fixture(async (profile, _foreign, directory) => {
      const ready = join(directory, "timeout-reader");
      await fakeRuntime(
        directory,
        `open(${JSON.stringify(ready)}, "w").write(str(os.getpid()))\ntime.sleep(30)`,
        async () => {
          await expect(
            createSelectedArtifactCapture(profile)
          ).rejects.toThrow();
          const pid = Number(await readFile(ready, "utf8"));
          expect(() => process.kill(pid, 0)).toThrow();
        }
      );
    }),
  15_000
);
