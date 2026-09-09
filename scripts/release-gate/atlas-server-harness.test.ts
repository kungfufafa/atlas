import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATLAS_API_VERSION } from "../../packages/core/src/contract";
import { AtlasServerHarness } from "./atlas-server-harness";
import { isPortAvailable } from "./free-port";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function createHarness(
  mode: string,
  preferredPort?: number
): Promise<{ harness: AtlasServerHarness; marker: string; requests: string }> {
  const directory = await mkdtemp(join(tmpdir(), "atlas-harness-health-"));
  temporaryDirectories.push(directory);
  const preloadPath = join(directory, "health-fixture.ts");
  const marker = join(directory, "child.json");
  const requests = join(directory, "requests.txt");
  await writeFile(
    preloadPath,
    `import { appendFileSync, writeFileSync } from "node:fs";
const mode = ${JSON.stringify(mode)};
Bun.serve({hostname:"127.0.0.1", port:Number(process.env.ATLAS_PORT), fetch(request) {
  appendFileSync(${JSON.stringify(requests)}, new URL(request.url).pathname + "\\n");
  if (mode === "stalled-request") return new Promise(() => {});
  if (mode === "stalled-body") return new Response(new ReadableStream({start(controller) { controller.enqueue(new TextEncoder().encode("{")); }}), {headers:{"content-type":"application/json"}});
  if (mode === "html") return new Response("<html>SPA fallback</html>", {headers:{"content-type":"text/html"}});
  return Response.json({ok:mode !== "not-ok", apiVersion:mode === "wrong-version" ? ${ATLAS_API_VERSION + 1} : ${ATLAS_API_VERSION}}, {status:mode === "401" ? 401 : mode === "404" ? 404 : 200});
}});
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid, execPath:process.execPath, version:Bun.version}));
await new Promise(() => {});
`
  );
  return {
    harness: new AtlasServerHarness({
      env: {
        configDir: directory,
        databaseUrl: `file:${join(directory, "unused.sqlite")}`,
        tmpDir: directory,
      },
      preferredPort,
      preloadPath,
    }),
    marker,
    requests,
  };
}

async function expectChildExited(marker: string): Promise<void> {
  const { pid } = JSON.parse(await readFile(marker, "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
}

test.each([
  "html",
  "401",
  "404",
  "wrong-version",
  "not-ok",
  "stalled-request",
  "stalled-body",
])("rejects %s health and releases the actual child and port", async (mode) => {
  const { harness, marker, requests } = await createHarness(mode);
  const startedAt = Date.now();
  try {
    await expect(harness.start(600)).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(2500);
    expect((await readFile(requests, "utf8")).trim().split("\n")).toEqual(
      expect.arrayContaining(["/health"])
    );
    expect(await isPortAvailable(harness.port)).toBe(true);
    await expectChildExited(marker);
  } finally {
    await harness.stop();
  }
});

test("accepts the exact health contract and waits for actual process exit", async () => {
  const { harness, marker } = await createHarness("healthy");
  try {
    const { baseUrl, port } = await harness.start(2000);
    expect(port).toBeGreaterThan(0);
    expect(await (await fetch(`${baseUrl}/health`)).json()).toEqual({
      apiVersion: ATLAS_API_VERSION,
      ok: true,
    });
  } finally {
    await harness.stop();
  }
  await expectChildExited(marker);
  expect(await isPortAvailable(harness.port)).toBe(true);
});

test("starts the child with the running Bun even when PATH has no bun", async () => {
  const { harness, marker } = await createHarness("healthy");
  const originalPath = process.env.PATH;
  process.env.PATH = "";
  try {
    await harness.start(2000);
    expect(JSON.parse(await readFile(marker, "utf8"))).toMatchObject({
      execPath: process.execPath,
      version: Bun.version,
    });
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    await harness.stop();
  }
  await expectChildExited(marker);
});

test("rejects an occupied preferred port before spawning and preserves its owner", async () => {
  const owner = Bun.serve({
    fetch: () => Response.json({ apiVersion: ATLAS_API_VERSION, ok: true }),
    hostname: "127.0.0.1",
    port: 0,
  });
  const { harness, marker } = await createHarness(
    "healthy",
    Number(owner.url.port)
  );
  try {
    await expect(harness.start(1000)).rejects.toThrow();
    await harness.stop();
    expect(existsSync(marker)).toBe(false);
    expect(harness.port).toBe(0);
    expect((await fetch(owner.url)).status).toBe(200);
  } finally {
    await owner.stop(true);
  }
});

test("cleanup reports a port that remains occupied without killing its owner", async () => {
  const owner = Bun.serve({
    fetch: () => new Response("unrelated owner"),
    hostname: "127.0.0.1",
    port: 0,
  });
  const { harness, marker } = await createHarness("healthy");
  const { port: childPort } = await harness.start(2000);
  // Simulate an occupied cleanup target after a listener was replaced externally.
  // The process still belongs to the harness; the occupied listener does not.
  harness.port = Number(owner.url.port);
  try {
    await expect(harness.stop(100)).rejects.toBeInstanceOf(AggregateError);
    await expectChildExited(marker);
    expect(await isPortAvailable(childPort)).toBe(true);
    expect(await (await fetch(owner.url)).text()).toBe("unrelated owner");
  } finally {
    await owner.stop(true);
    await harness.stop();
  }
});

test("retains startup and cleanup failures together", async () => {
  const { harness, marker } = await createHarness("html");
  const stop = harness.stop.bind(harness);
  const cleanupFailure = new Error("controlled cleanup failure");
  harness.stop = async () => {
    await stop();
    throw cleanupFailure;
  };
  try {
    let failure: unknown;
    try {
      await harness.start(600);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.errors).toHaveLength(2);
    expect(aggregate.errors[0]).toBeInstanceOf(Error);
    expect(aggregate.errors[1]).toBe(cleanupFailure);
    expect(aggregate.cause).toBe(aggregate.errors[0]);
    await expectChildExited(marker);
  } finally {
    await stop();
  }
});
