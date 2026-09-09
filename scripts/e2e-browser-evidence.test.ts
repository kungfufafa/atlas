import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BROWSER_SCENARIOS,
  buildBrowserSmokeReport,
  createBrowserSmokeOutputDirectory,
  findNewAssistantDisplay,
  loadBrowserFixtureConfig,
} from "./e2e-browser-evidence";

const fixture = {
  ATLAS_BROWSER_FIXTURE_CHAT_PATH: "/chat/profile_fixture/session_fixture",
  ATLAS_BROWSER_FIXTURE_EMAIL: "fixture@example.test",
  ATLAS_BROWSER_FIXTURE_ORG_ID: "org_fixture",
  ATLAS_BROWSER_FIXTURE_PASSWORD: "synthetic-fixture-password",
  ATLAS_TEST_BASE_URL: "http://127.0.0.1:4310",
};
const completed = BROWSER_SCENARIOS.map((scenario) => scenario.id);

test.each(Object.keys(fixture))(
  "requires explicit fixture configuration: %s",
  (key) => {
    expect(() =>
      loadBrowserFixtureConfig({ ...fixture, [key]: undefined })
    ).toThrow();
  }
);

test("rejects a generic chat route and embedded URL credentials", () => {
  expect(() =>
    loadBrowserFixtureConfig({
      ...fixture,
      ATLAS_BROWSER_FIXTURE_CHAT_PATH: "/chat",
    })
  ).toThrow();
  expect(() =>
    loadBrowserFixtureConfig({
      ...fixture,
      ATLAS_TEST_BASE_URL: "http://user:password@localhost:4310",
    })
  ).toThrow();
  expect(loadBrowserFixtureConfig(fixture).chatPath).toBe(
    fixture.ATLAS_BROWSER_FIXTURE_CHAT_PATH
  );
});

test.each(["HTTP 401", "HTTP 404", "uncaught TypeError"])(
  "browser error fails a completed smoke: %s",
  (error) => {
    expect(
      buildBrowserSmokeReport({ browserErrors: [error], completed }).status
    ).toBe("FAIL");
  }
);

test("successful screenshots do not claim tool, file, provider or isolation proof", () => {
  expect(
    buildBrowserSmokeReport({ browserErrors: [], completed })
  ).toMatchObject({
    fileContentAndFidelity: "NOT_VERIFIED",
    persistedToolExecution: "NOT_VERIFIED",
    providerInference: "NOT_VERIFIED",
    pythonIsolation: "NOT_VERIFIED",
    status: "UI_SMOKE_PASSED",
  });
  expect(
    buildBrowserSmokeReport({ browserErrors: [], completed: [] }).status
  ).toBe("FAIL");
  expect(
    buildBrowserSmokeReport({
      browserErrors: [],
      completed,
      failure: "navigation failed",
    }).status
  ).toBe("FAIL");
});

test("old assistant text cannot satisfy the next display observation", () => {
  expect(findNewAssistantDisplay(["65536"], 1, "65536")).toBeUndefined();
  expect(
    findNewAssistantDisplay(["65536", "still working"], 1, "65536")
  ).toBeUndefined();
  expect(
    findNewAssistantDisplay(["earlier", "Result: 65536"], 1, "65536")
  ).toBe("Result: 65536");
});

test("output directories are fresh and an unconfigured standalone run records NOT_RUN", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "atlas-browser-evidence-"));
  try {
    const first = await createBrowserSmokeOutputDirectory(root);
    const second = await createBrowserSmokeOutputDirectory(root);
    expect(first).not.toBe(second);
    await expect(
      createBrowserSmokeOutputDirectory("relative-output")
    ).rejects.toThrow();
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "e2e-browser-test.ts")],
      {
        env: { ATLAS_BROWSER_OUTPUT_DIR: root, PATH: process.env.PATH },
        stderr: "pipe",
        stdout: "pipe",
      }
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toBe("");
    expect(stdout).toContain("NOT_RUN:");
    const entries = await readdir(root);
    const reportDirectory = entries
      .map((name) => path.join(root, name))
      .find((directory) => directory !== first && directory !== second);
    expect(reportDirectory).toBeDefined();
    const report = JSON.parse(
      await readFile(path.join(reportDirectory!, "report.json"), "utf8")
    );
    expect(report).toMatchObject({
      completedDisplayObservations: [],
      observations: [],
      persistedToolExecution: "NOT_VERIFIED",
      status: "NOT_RUN",
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
