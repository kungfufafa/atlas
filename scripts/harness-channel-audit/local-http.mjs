import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import ExcelJS from "../../packages/core/node_modules/exceljs/excel.js";

const root = process.env.ATLAS_HARNESS_AUDIT_DIR;
if (!root) {
  throw new Error(
    "Use scripts/harness-channel-audit/run.ts to create an isolated fixture."
  );
}
const base = `http://127.0.0.1:${process.env.ATLAS_HARNESS_AUDIT_PORT}`;
const results = [];
const cookie = new Map();
let orgId = "";
let profileId = "";
const requestLog = [];
const mock = Bun.serve({
  async fetch(req) {
    if (new URL(req.url).pathname.endsWith("/models")) {
      return Response.json({
        data: [{ id: "audit-model", object: "model", owned_by: "local" }],
      });
    }
    const body = await req.json();
    const messages = body.messages ?? [];
    const lastUser = messages.findLastIndex((m) => m.role === "user");
    const text = JSON.stringify(messages[lastUser]?.content ?? "");
    const mode = /AUDIT_(H\d+[A-Z]?)/.exec(text)?.[1];
    const prior = messages
      .slice(lastUser + 1)
      .filter((m) => m.role === "tool")
      .map((m) => JSON.parse(m.content));
    let call;
    if (mode === "H01" || mode === "H02") {
      if (prior.length === 0) {
        call = {
          arguments: {
            action: "create",
            data: [
              ["ID", "Amount"],
              ["00123", 7],
              ["9007199254740993", 11],
            ],
            path: `artifacts/${mode}.xlsx`,
            sheetName: "Audit",
          },
          name: "spreadsheet",
        };
      }
      if (prior.length === 1) {
        call = {
          arguments: {
            action: "read_range",
            path: prior[0].path,
            range: "A1:B3",
          },
          name: "spreadsheet",
        };
      }
      if (prior.length === 2) {
        call = {
          arguments: {
            action: "write_range",
            expectedRevision: prior[1].revision,
            path: prior[0].path,
            range: "B2",
            values: [[prior[1].rows[1][1] + prior[1].rows[2][1]]],
          },
          name: "spreadsheet",
        };
      }
      if (prior.length === 3) {
        call = {
          arguments: {
            action: "read_range",
            path: prior[2].path,
            range: "A1:B3",
          },
          name: "spreadsheet",
        };
      }
    } else if (mode === "H03") {
      if (prior.length === 0) {
        call = { arguments: {}, name: "unassigned_audit_tool" };
      }
      if (prior.length === 1) {
        call = {
          arguments: {
            action: "create",
            data: [[{ invalid: true }]],
            path: "artifacts/invalid.xlsx",
          },
          name: "spreadsheet",
        };
      }
      if (prior.length === 2) {
        call = {
          arguments: {
            content: `ID,Label
00123,"Recovered, yes"
`,
            path: "artifacts/recovered.csv",
          },
          name: "write_file",
        };
      }
    } else if (["H04A", "H04D", "H07", "H10"].includes(mode)) {
      if (prior.length === 0) {
        call = {
          arguments: { path: `artifacts/${mode}-target.csv` },
          name: "delete_file",
        };
      }
    } else if (mode === "H06") {
      if (prior.length === 0) {
        call = {
          arguments: {
            content: `ID
00123
`,
            path: "artifacts/disconnect.csv",
          },
          name: "write_file",
        };
      } else {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, 30_000);
          req.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              resolve(undefined);
            },
            { once: true }
          );
        });
      }
    }
    requestLog.push({
      call,
      mode,
      offered: body.tools?.map((t) => t.function.name),
      prior,
      stage: prior.length,
    });
    await writeFile(
      `${root}/model-boundary.json`,
      JSON.stringify(requestLog, null, 2)
    );
    const toolCalls = call
      ? [
          {
            function: {
              arguments: JSON.stringify(call.arguments),
              name: call.name,
            },
            id: `${mode}-${prior.length}`,
            type: "function",
          },
        ]
      : undefined;
    const content = call
      ? null
      : mode
        ? `Audit fixture ${mode} finished.`
        : "Audit session";
    const finish = call ? "tool_calls" : "stop";
    const common = { created: 1, id: "audit-completion", model: "audit-model" };
    if (!body.stream) {
      return Response.json({
        ...common,
        choices: [
          {
            finish_reason: finish,
            index: 0,
            message: {
              content,
              role: "assistant",
              ...(toolCalls ? { tool_calls: toolCalls } : {}),
            },
          },
        ],
        object: "chat.completion",
        usage: { completion_tokens: 10, prompt_tokens: 10, total_tokens: 20 },
      });
    }
    const chunks = [
      {
        ...common,
        choices: [
          {
            delta: {
              content,
              role: "assistant",
              ...(toolCalls
                ? { tool_calls: toolCalls.map((t) => ({ index: 0, ...t })) }
                : {}),
            },
            finish_reason: null,
            index: 0,
          },
        ],
        object: "chat.completion.chunk",
      },
      {
        ...common,
        choices: [{ delta: {}, finish_reason: finish, index: 0 }],
        object: "chat.completion.chunk",
      },
    ];
    return new Response(
      chunks
        .map(
          (chunk) => `data: ${JSON.stringify(chunk)}

`
        )
        .join("") +
        `data: [DONE]

`,
      { headers: { "content-type": "text/event-stream" } }
    );
  },
  hostname: "127.0.0.1",
  port: Number(process.env.ATLAS_HARNESS_MODEL_PORT),
});
async function req(url, method = "GET", data, signal) {
  const response = await fetch(`${base}${url}`, {
    body: data === undefined ? undefined : JSON.stringify(data),
    headers: {
      Cookie: [...cookie].map(([k, v]) => `${k}=${v}`).join("; "),
      "content-type": "application/json",
      Origin: base,
      "X-Org-Id": orgId,
      "x-csrf-token": cookie.get("atlas_csrf") ?? "",
    },
    method,
    signal,
  });
  for (const item of response.headers.getSetCookie()) {
    const [name, value] = item.split(";", 1)[0].split("=");
    cookie.set(name, value);
  }
  return response;
}
async function json(url, method = "GET", data) {
  const response = await req(url, method, data);
  const value = await response.json();
  assert.ok(
    response.ok,
    JSON.stringify({ status: response.status, url, value })
  );
  return value;
}
async function run(id, fn) {
  try {
    const detail = await fn();
    results.push({ detail, id, status: "pass" });
  } catch (error) {
    results.push({
      error: String(error),
      id,
      stack: error.stack,
      status: "fail",
    });
  }
  await writeFile(`${root}/report.json`, JSON.stringify(results, null, 2));
  console.log(results.at(-1));
}
async function session() {
  return (await json("/v1/sessions", "POST", { channel: "web", profileId }))
    .sessionId;
}
async function history(id) {
  return (await json(`/v1/sessions/${id}/messages`)).messages;
}
function tools(messages) {
  return messages.filter((m) => m.role === "tool");
}
function pairs(messages) {
  const calls = messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.toolCalls ?? []);
  const outputs = tools(messages);
  assert.equal(calls.length, outputs.length);
  for (const call of calls) {
    assert.equal(outputs.filter((m) => m.toolCallId === call.id).length, 1);
  }
  return calls.length;
}
async function stream(id, message, onEvent) {
  const abort = new AbortController();
  const response = await req(
    `/v1/sessions/${id}/messages?stream=true`,
    "POST",
    { message, policy: "standard" },
    abort.signal
  );
  assert.equal(response.status, 200);
  let buffer = "";
  const events = [];
  try {
    for await (const chunk of response.body) {
      buffer += new TextDecoder().decode(chunk);
      const blocks = buffer.split(`

`);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const data = block
          .split(`
`)
          .find((s) => s.startsWith("data:"));
        if (!data) {
          continue;
        }
        const e = JSON.parse(data.slice(5));
        events.push(e);
        await onEvent?.(e, abort);
      }
    }
  } catch (error) {
    if (!abort.signal.aborted) {
      throw error;
    }
  }
  await writeFile(
    `${root}/${message}-events.json`,
    JSON.stringify(events, null, 2)
  );
  return events;
}
try {
  if (await Bun.file(`${root}/fixture-state.json`).exists()) {
    const saved = await Bun.file(`${root}/fixture-state.json`).json();
    for (const [k, v] of Object.entries(saved.cookies)) {
      cookie.set(k, String(v));
    }
    orgId = saved.orgId;
  } else {
    await json("/v1/auth/setup", "POST", {
      admin: {
        email: "harness-audit@example.test",
        name: "Harness Audit",
        password: "isolated-audit-fixture-2026!",
      },
      organization: { name: "Harness Audit", slug: "harness-audit" },
    });
  }
  const me = await json("/v1/auth/me");
  orgId = me.activeOrgId ?? me.orgId;
  if (!(await json("/v1/providers")).providers.length) {
    await json("/v1/providers", "POST", {
      apiKey: "fixture-not-real",
      baseUrl: `http://127.0.0.1:${process.env.ATLAS_HARNESS_MODEL_PORT}/v1`,
      customModels: [
        {
          capabilities: {
            "chat.tool-use": {
              source: "admin-override",
              status: "supported",
              verified: true,
            },
          },
          default: true,
          id: "audit-model",
          name: "Audit",
        },
      ],
      label: "Offline audit peer",
      model: "audit-model",
      skipValidation: true,
      type: "openai_compatible",
      wireApi: "chat",
    });
  }
  const profiles = await json("/v1/profiles");
  profileId =
    profiles.profiles.find((p) => !p.isSuper)?.id ?? profiles.profiles[0].id;
  const catalog = (await json("/v1/tools")).tools;
  for (const name of [
    "spreadsheet",
    "write_file",
    "read_file",
    "delete_file",
  ]) {
    const tool = catalog.find((t) => t.name === name);
    assert.ok(tool, `Missing tool ${name}`);
    await json(`/v1/profiles/${profileId}/tools`, "POST", { toolId: tool.id });
  }
  const workspace = `${root}/state/orgs/${orgId}/profiles/${profileId}`;
  await mkdir(`${workspace}/artifacts`, { recursive: true });
  await writeFile(
    `${root}/fixture-state.json`,
    JSON.stringify(
      { cookies: Object.fromEntries(cookie), orgId, profileId, workspace },
      null,
      2
    )
  );
  for (const id of ["H01", "H02"]) {
    await run(id, async () => {
      const sid = await session();
      if (id === "H01") {
        await json(`/v1/sessions/${sid}/messages`, "POST", {
          message: `AUDIT_${id}`,
          policy: "standard",
        });
      } else {
        await stream(sid, `AUDIT_${id}`);
      }
      const messages = await history(sid);
      assert.equal(pairs(messages), 4);
      const output = tools(messages).map((m) => JSON.parse(m.content));
      assert.deepEqual(output[1].rows, [
        ["ID", "Amount"],
        ["00123", 7],
        ["9007199254740993", 11],
      ]);
      assert.equal(output[3].rows[1][1], 18);
      assert.notEqual(output[0].path, output[2].path);
      const source = new ExcelJS.Workbook();
      await source.xlsx.readFile(
        output[0].path.startsWith("/")
          ? output[0].path
          : `${workspace}/${output[0].path}`
      );
      assert.equal(source.worksheets[0].getCell("B2").value, 7);
      const updated = new ExcelJS.Workbook();
      await updated.xlsx.readFile(
        output[2].path.startsWith("/")
          ? output[2].path
          : `${workspace}/${output[2].path}`
      );
      assert.equal(updated.worksheets[0].getCell("B2").value, 18);
      await writeFile(
        `${root}/${id}-history.json`,
        JSON.stringify(messages, null, 2)
      );
      return {
        original: output[0].path,
        output: output[2].path,
        pairs: 4,
        sessionId: sid,
      };
    });
  }
  await run("H03", async () => {
    const sid = await session();
    await json(`/v1/sessions/${sid}/messages`, "POST", {
      message: "AUDIT_H03",
      policy: "standard",
    });
    const messages = await history(sid);
    assert.equal(pairs(messages), 3);
    const outputs = tools(messages).map((m) => JSON.parse(m.content));
    assert.ok(outputs[0].error);
    assert.ok(outputs[1].error);
    assert.equal(
      await readFile(outputs[2].path, "utf8"),
      `ID,Label
00123,"Recovered, yes"
`
    );
    return { errors: outputs.slice(0, 2), recovered: true, sessionId: sid };
  });
  for (const id of ["H04A", "H04D", "H07"]) {
    await run(id, async () => {
      const sid = await session();
      const target = `${workspace}/artifacts/${id}-target.csv`;
      await writeFile(
        target,
        `ID
00123
`
      );
      let approvalId;
      let decisionStatus;
      const events = await stream(sid, `AUDIT_${id}`, async (e, abort) => {
        if (e.type !== "approval_requested") {
          return;
        }
        approvalId = e.approval.id;
        assert.ok(await Bun.file(target).exists());
        if (id === "H07") {
          abort.abort();
          return;
        }
        const r = await req(
          `/v1/sessions/${sid}/approvals/${approvalId}`,
          "POST",
          { decision: id === "H04A" ? "approved" : "denied" }
        );
        decisionStatus = r.status;
        assert.equal(r.status, 200, await r.text());
      });
      assert.ok(approvalId);
      await Bun.sleep(200);
      const stillExists = await Bun.file(target).exists();
      assert.equal(stillExists, id !== "H04A");
      const duplicate = await req(
        `/v1/sessions/${sid}/approvals/${approvalId}`,
        "POST",
        { decision: "approved" }
      );
      assert.equal(duplicate.status, 409);
      const messages = await history(sid);
      await writeFile(
        `${root}/${id}-history.json`,
        JSON.stringify(messages, null, 2)
      );
      return {
        approvalId,
        decisionStatus,
        lateDecision: duplicate.status,
        pairs: pairs(messages),
        sessionId: sid,
        stillExists,
        terminal: events.at(-1),
      };
    });
  }
  await run("H06", async () => {
    const sid = await session();
    await stream(sid, "AUDIT_H06", async (e, abort) => {
      if (e.type === "tool_end") {
        abort.abort();
      }
    });
    await Bun.sleep(250);
    const messages = await history(sid);
    assert.equal(pairs(messages), 1);
    assert.equal(
      await readFile(JSON.parse(tools(messages)[0].content).path, "utf8"),
      `ID
00123
`
    );
    const status = await json(`/v1/sessions/${sid}/status`);
    return { pairs: 1, sessionId: sid, status };
  });
  await run("H14", async () => {
    const sid = await session();
    const bytes = await readFile(`${workspace}/artifacts/H01.xlsx`);
    const response = await json(`/v1/sessions/${sid}/messages`, "POST", {
      documents: [
        {
          data: bytes.toString("base64"),
          filename: "original.xlsx",
          mediaType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      ],
      message: "Retain original attachment",
      policy: "standard",
    });
    const messages = await history(sid);
    const ref = messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((p) => p.type === "document_ref");
    assert.ok(ref);
    const stored = await req(
      `/v1/sessions/${sid}/attachments/${ref.attachmentId}`
    );
    assert.deepEqual(Buffer.from(await stored.arrayBuffer()), bytes);
    const rejected = await req(`/v1/sessions/${sid}/messages`, "POST", {
      documents: [
        {
          data: "TVo=",
          filename: "bad.exe",
          mediaType: "application/octet-stream",
        },
      ],
      message: "invalid",
    });
    assert.equal(rejected.status, 400);
    return {
      attachmentId: ref.attachmentId,
      rejected: rejected.status,
      sessionId: sid,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
} catch (error) {
  results.push({
    error: String(error),
    id: "SETUP",
    stack: error.stack,
    status: "fail",
  });
  console.log(results.at(-1));
  await writeFile(`${root}/report.json`, JSON.stringify(results, null, 2));
} finally {
  mock.stop(true);
}
if (results.some((entry) => entry.status === "fail")) {
  process.exitCode = 1;
}
