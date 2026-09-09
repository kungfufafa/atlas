import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type FileAtlasRequest,
  PREPARED_FILE_PYTHON,
  parseFileAtlasRequest,
  runAtlasFile,
} from "./file-atlas-runner";

const MODEL = "native-file-offline-fixture";
const INPUT = "name,amount\nAster,17\nWillow,29\n";
interface WireRequest {
  messages: Array<{ role: string; content?: string }>;
  tools?: Array<{ function: { name: string } }>;
}
interface ScriptedTool {
  arguments: Record<string, unknown>;
  name: string;
}

async function fixture(readOnlyEditableSource = false) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "atlas-file-adapter-proof-"))
  );
  const sourceDirectory = join(root, "fixture-source");
  await mkdir(join(sourceDirectory, "input"), { recursive: true });
  await writeFile(join(sourceDirectory, "input", "values.csv"), INPUT);
  if (readOnlyEditableSource) {
    await mkdir(join(sourceDirectory, "app"));
    await writeFile(join(sourceDirectory, "app", "money.py"), "VALUE = 1\n");
    for (const file of ["input/values.csv", "app/money.py"]) {
      await chmod(join(sourceDirectory, file), 0o444);
    }
  }
  const canary = join(root, "outside-canary.txt");
  await writeFile(canary, "untouched synthetic outside canary");
  let contacted = 0;
  const deniedServer = Bun.serve({
    fetch() {
      contacted += 1;
      return new Response("network unexpectedly allowed");
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const code = `
import csv, json, os, socket, subprocess, sys
from pathlib import Path
from openpyxl import Workbook
outside = Path(${JSON.stringify(canary)})
proof = {}
for key, operation in [
    ('outside_read', lambda: outside.read_text()),
    ('outside_write', lambda: outside.write_text('changed')),
]:
    try:
        operation()
        proof[key] = 'ALLOWED'
    except OSError:
        proof[key] = 'blocked'
Path('escape-link').symlink_to(outside)
try:
    Path('escape-link').read_text()
    proof['symlink_read'] = 'ALLOWED'
except OSError:
    proof['symlink_read'] = 'blocked'
try:
    with socket.create_connection(('127.0.0.1', ${deniedServer.port}), timeout=1):
        proof['network'] = 'ALLOWED'
except OSError:
    proof['network'] = 'blocked'
child = subprocess.run([sys.executable, '-I', '-c', ${JSON.stringify(`from pathlib import Path\ntry:\n Path(${JSON.stringify(canary)}).read_text()\n print('ALLOWED')\nexcept OSError:\n print('blocked')`)}], capture_output=True, text=True, timeout=3)
proof['descendant_read'] = child.stdout.strip()
proof['environment_scrubbed'] = 'ATLAS_FILE_TEST_SENTINEL' not in os.environ
rows = list(csv.DictReader(Path('input/values.csv').open()))
workbook = Workbook()
sheet = workbook.active
sheet.title = 'Summary'
sheet.append(['name', 'amount'])
for row in rows:
    sheet.append([row['name'], int(row['amount'])])
sheet.append(['TOTAL', sum(int(row['amount']) for row in rows)])
Path('artifacts').mkdir(exist_ok=True)
workbook.save('artifacts/result.xlsx')
Path('work').mkdir(exist_ok=True)
Path('work/isolation-proof.json').write_text(json.dumps(proof))
print(json.dumps(proof))
`;
  const verifyCode = `
import json
from openpyxl import load_workbook
workbook = load_workbook('artifacts/result.xlsx')
print(json.dumps({'sheets': workbook.sheetnames, 'rows': list(workbook['Summary'].values)}))
`;
  const steps: Array<ScriptedTool | string> = readOnlyEditableSource
    ? [
        { arguments: { path: "app/money.py" }, name: "read_file" },
        {
          arguments: {
            edits: [{ newText: "VALUE = 2", oldText: "VALUE = 1" }],
            path: "app/money.py",
          },
          name: "edit_file",
        },
        "Edited app/money.py.",
      ]
    : [
        { arguments: { path: "input/values.csv" }, name: "read_file" },
        { arguments: { path: canary }, name: "read_file" },
        {
          arguments: { code, files: ["input/values.csv"] },
          name: "python_execute",
        },
        { arguments: { path: "escape-link" }, name: "read_file" },
        "Created [the workbook](artifacts/result.xlsx).",
        {
          arguments: { code: verifyCode, files: ["artifacts/result.xlsx"] },
          name: "python_execute",
        },
        "Verified [the workbook](artifacts/result.xlsx); total 46.",
      ];
  const requests: WireRequest[] = [];
  let mainIndex = 0;
  const server = Bun.serve({
    async fetch(incoming) {
      if (
        new URL(incoming.url).pathname !== "/runs/file-test/v1/chat/completions"
      ) {
        return new Response("Unknown model-only route", { status: 404 });
      }
      const request = (await incoming.json()) as WireRequest;
      requests.push(request);
      const title = !request.tools?.length;
      const step = title ? "Native File Proof" : steps[mainIndex++];
      const tool = typeof step === "object" ? step : null;
      const message = tool
        ? {
            content: null,
            role: "assistant",
            tool_calls: [
              {
                function: {
                  arguments: JSON.stringify(tool.arguments),
                  name: tool.name,
                },
                id: "reused-native-call",
                type: "function",
              },
            ],
          }
        : {
            content: step ?? "Unexpected extra model request.",
            role: "assistant",
          };
      return Response.json({
        choices: [
          { finish_reason: tool ? "tool_calls" : "stop", index: 0, message },
        ],
        created: 1,
        id: `offline-${requests.length}`,
        model: MODEL,
        object: "chat.completion",
        usage: { completion_tokens: 10, prompt_tokens: 20, total_tokens: 30 },
      });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const request: FileAtlasRequest = {
    budget: {
      maxGeneratedTokens: 12_000,
      maxOutputTokens: 4096,
      maxProviderRequests: 24,
      timeoutMs: 30_000,
    },
    model: MODEL,
    modelMetadata: {
      entry: {
        capabilities: {
          "chat.tool-use": {
            source: "runtime-probe",
            status: "supported",
            verified: true,
          },
        },
        id: MODEL,
      },
      evidence: {
        endpoint: server.url.origin,
        model: MODEL,
        observedAt: new Date().toISOString(),
        source: "Offline scripted model transport; not a competence benchmark",
      },
    },
    proxyBaseUrl: server.url.origin,
    pythonPath: PREPARED_FILE_PYTHON,
    runId: "file-test",
    sourceDirectory,
    stateRoot: root,
    taskTurns: readOnlyEditableSource
      ? [
          `Edit app/money.py to set VALUE to 2. Prepared Python: ${PREPARED_FILE_PYTHON}.`,
        ]
      : [
          `Create artifacts/result.xlsx from input/values.csv with a total. Prepared Python: ${PREPARED_FILE_PYTHON}. Work inside the supplied workspace.`,
          "Verify the saved workbook with Python and retain its path.",
        ],
  };
  return {
    canary,
    contacted: () => contacted,
    deniedServer,
    request,
    requests,
    root,
    server,
    sourceDirectory,
  };
}

test("actual AgentService Python creates and reopens XLSX while native boundaries block outside access", async () => {
  const local = await fixture();
  const prior = process.env.ATLAS_FILE_TEST_SENTINEL;
  process.env.ATLAS_FILE_TEST_SENTINEL = "synthetic-env-canary";
  try {
    const result = await runAtlasFile(local.request);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("completed");
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.initialHistoryCount).toBe(0);
    expect(result.sessions[0]?.turns.map((turn) => turn.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(result.nativeEvents.map((event) => event.name)).toEqual([
      "read_file",
      "read_file",
      "python_execute",
      "read_file",
      "python_execute",
    ]);
    expect(result.nativeEvents.map((event) => event.turnIndex)).toEqual([
      0, 0, 0, 0, 1,
    ]);
    const executions = result.nativeEvents
      .filter((event) => event.name === "python_execute")
      .map(
        (event) =>
          event.result as { success: boolean; exitCode: number; stdout: string }
      );
    expect(
      executions.every((event) => event.success && event.exitCode === 0)
    ).toBe(true);
    expect(JSON.parse(executions[0]?.stdout ?? "null")).toEqual({
      descendant_read: "blocked",
      environment_scrubbed: true,
      network: "blocked",
      outside_read: "blocked",
      outside_write: "blocked",
      symlink_read: "blocked",
    });
    expect(JSON.parse(executions[1]?.stdout ?? "null")).toEqual({
      rows: [
        ["name", "amount"],
        ["Aster", 17],
        ["Willow", 29],
        ["TOTAL", 46],
      ],
      sheets: ["Summary"],
    });
    expect(local.contacted()).toBe(0);
    expect(await readFile(local.canary, "utf8")).toBe(
      "untouched synthetic outside canary"
    );
    const workspace = result.workspaceRoot;
    if (!workspace) {
      throw new Error("Missing real workspace.");
    }
    expect(await readFile(join(workspace, "input/values.csv"), "utf8")).toBe(
      INPUT
    );
    expect(
      await readFile(join(local.sourceDirectory, "input/values.csv"), "utf8")
    ).toBe(INPUT);
    expect(
      (await readFile(join(workspace, "artifacts/result.xlsx")))
        .subarray(0, 2)
        .toString()
    ).toBe("PK");
    expect(result.artifacts).toContainEqual(
      expect.objectContaining({
        native: expect.objectContaining({
          mimeType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          path: "artifacts/result.xlsx",
        }),
      })
    );
    expect(result.profileArtifacts).toMatchObject({ total: 1 });
    expect(
      result.workspaceFiles.find((file) => file.path === "input/values.csv")
        ?.sha256
    ).toBe(result.sourceCopies[0]?.sha256);
    expect(JSON.stringify(result.nativeEvents[1]?.result)).not.toContain(
      "untouched synthetic outside canary"
    );
    expect(result.nativeEvents[1]?.result).toMatchObject({
      error: expect.any(String),
    });
    expect(JSON.stringify(result.nativeEvents[3]?.result)).not.toContain(
      "untouched synthetic outside canary"
    );
    expect(result.nativeEvents[3]?.result).toMatchObject({
      error: expect.any(String),
    });
    const names =
      local.requests[0]?.tools?.map((tool) => tool.function.name) ?? [];
    expect(names).toContain("python_execute");
    for (const denied of [
      "bash",
      "web_fetch",
      "web_search",
      "spreadsheet",
      "office_document",
      "pdf_document",
      "write_docx",
      "write_pptx",
      "tool_search",
    ]) {
      expect(names).not.toContain(denied);
    }
    expect(
      local.requests.filter((request) => !request.tools?.length)
    ).toHaveLength(1);
    expect(
      result.sessions[0]?.history.filter((message) => message.role === "user")
    ).toHaveLength(2);
    expect(result.finalText).toContain("artifacts/result.xlsx");
    expect(process.env.ATLAS_FILE_TEST_SENTINEL).toBe("synthetic-env-canary");
  } finally {
    if (prior === undefined) {
      delete process.env.ATLAS_FILE_TEST_SENTINEL;
    } else {
      process.env.ATLAS_FILE_TEST_SENTINEL = prior;
    }
    await local.server.stop(true);
    await local.deniedServer.stop(true);
  }
}, 45_000);

test("source symlinks and evaluator manifests fail before any inference", async () => {
  const local = await fixture();
  try {
    await symlink(local.canary, join(local.sourceDirectory, "input", "escape"));
    const result = await runAtlasFile(local.request);
    expect(result.status).toBe("failed");
    expect(result.sourceCopies).toHaveLength(0);
    expect(local.requests).toHaveLength(0);
    const other = join(local.root, "invalid-source");
    await mkdir(other);
    await writeFile(join(other, "expected.json"), '{"answer":42}');
    const rejected = await runAtlasFile({
      ...local.request,
      sourceDirectory: other,
    });
    expect(rejected.status).toBe("failed");
    expect(rejected.sourceCopies).toHaveLength(0);
    expect(local.requests).toHaveLength(0);
  } finally {
    await local.server.stop(true);
    await local.deniedServer.stop(true);
  }
});

test("request validation refuses external transport, unprepared execution and answer injection", async () => {
  const local = await fixture();
  try {
    expect(() =>
      parseFileAtlasRequest({ ...local.request, expected: { answer: 42 } })
    ).toThrow();
    expect(() =>
      parseFileAtlasRequest({ ...local.request, pythonPath: "/bin/sh" })
    ).toThrow();
    expect(() =>
      parseFileAtlasRequest({
        ...local.request,
        proxyBaseUrl: "https://example.com",
      })
    ).toThrow();
    expect(() =>
      parseFileAtlasRequest({
        ...local.request,
        model: "unverified-substitute",
      })
    ).toThrow();
    expect(() =>
      parseFileAtlasRequest({
        ...local.request,
        taskTurns: ["Create the workbook."],
      })
    ).toThrow();
    expect(() =>
      parseFileAtlasRequest({
        ...local.request,
        budget: { ...local.request.budget, maxProviderRequests: 25 },
      })
    ).toThrow();
  } finally {
    await local.server.stop(true);
    await local.deniedServer.stop(true);
  }
});

test("read-only originals produce equal writable workspace copies and allow a native in-place app edit", async () => {
  const local = await fixture(true);
  try {
    const hermesWorkspace = join(local.root, "hermes-preparation");
    const helper = resolve(import.meta.dir, "file_hermes_runner.py");
    const code =
      "import importlib.util,sys\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location('native_file_adapter',sys.argv[1])\nm=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\nm.copy_sources(Path(sys.argv[2]),Path(sys.argv[3]))";
    const copied = Bun.spawn(
      [
        PREPARED_FILE_PYTHON,
        "-I",
        "-c",
        code,
        helper,
        local.sourceDirectory,
        hermesWorkspace,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const [exit, stderr] = await Promise.all([
      copied.exited,
      new Response(copied.stderr).text(),
    ]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    const result = await runAtlasFile(local.request);
    expect(result.status).toBe("completed");
    const workspace = result.workspaceRoot;
    if (!workspace) {
      throw new Error("Missing native workspace");
    }
    for (const file of ["input/values.csv", "app/money.py"]) {
      const atlasMode = (await stat(join(workspace, file))).mode % 0o1000;
      const hermesMode =
        (await stat(join(hermesWorkspace, file))).mode % 0o1000;
      expect(atlasMode).toBe(0o644);
      expect(atlasMode).toBe(hermesMode);
      expect(
        (await stat(join(local.sourceDirectory, file))).mode % 0o1000
      ).toBe(0o444);
    }
    expect(result.nativeEvents.map((event) => event.name)).toEqual([
      "read_file",
      "edit_file",
    ]);
    expect(result.nativeEvents[1]?.result).not.toHaveProperty("error");
    expect(await readFile(join(workspace, "app/money.py"), "utf8")).toBe(
      "VALUE = 2\n"
    );
    expect(await readFile(join(hermesWorkspace, "app/money.py"), "utf8")).toBe(
      "VALUE = 1\n"
    );
    expect(
      await readFile(join(local.sourceDirectory, "app/money.py"), "utf8")
    ).toBe("VALUE = 1\n");
    expect(await readFile(join(workspace, "input/values.csv"), "utf8")).toBe(
      INPUT
    );
    expect(
      await readFile(join(local.sourceDirectory, "input/values.csv"), "utf8")
    ).toBe(INPUT);
  } finally {
    await local.server.stop(true);
    await local.deniedServer.stop(true);
  }
}, 30_000);
