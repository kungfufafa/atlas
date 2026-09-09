#!/usr/bin/env bun
/**
 * Glue over existing live-human-e2e prompts. Not a new eval framework.
 * Reads artifacts/eval/{PROTOCOL.md,model-roster.json,tasks.json}.
 * Never prints or writes OPENCODE_GO_API_KEY.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const API = process.env.ATLAS_API_URL ?? "http://127.0.0.1:4310";
const KEY = process.env.OPENCODE_GO_API_KEY?.trim() ?? "";
const WAVE = process.argv.includes("--wave")
  ? process.argv[process.argv.indexOf("--wave") + 1]
  : "pilot";

const ADMIN_EMAIL = "eval-admin@atlas-tikom.test";
const ADMIN_PASSWORD = "AtlasEvalAdmin9!";
const ORG_SLUG = "atlas-eval";

interface RosterModel {
  apiId: string;
  catalogId: string;
  protocol: string;
}

interface Roster {
  fetchedAt: string;
  models: RosterModel[];
  rosterHash: string;
}

interface Task {
  id: string;
  prompt?: string;
  promptTemplate?: string;
  timeoutMs: number;
}

function redact(value: string): string {
  let out = value;
  if (KEY) {
    out = out.split(KEY).join("[REDACTED_KEY]");
  }
  return out.replace(/sk-[A-Za-z0-9]{20,}/g, "[REDACTED_KEY_LIKE]");
}

function stampFor(runId: string): string {
  return `eval-${runId.replaceAll(/[^a-zA-Z0-9_-]/g, "").slice(0, 24)}`;
}

function taskPrompt(task: Task, runId: string): string {
  if (task.prompt) {
    return task.prompt;
  }
  if (task.promptTemplate) {
    return task.promptTemplate.replaceAll("{stamp}", stampFor(runId));
  }
  throw new Error(`Task ${task.id} has no prompt`);
}

function modelsForWave(roster: Roster): RosterModel[] {
  const byId = new Map(roster.models.map((model) => [model.apiId, model]));
  if (WAVE === "pilot") {
    const model = byId.get("deepseek-v4-flash");
    if (!model) {
      throw new Error(
        "Pilot snapshot ID deepseek-v4-flash missing from roster — infra miss"
      );
    }
    return [model];
  }
  if (WAVE === "flash") {
    return roster.models.filter(
      (model) =>
        model.apiId.includes("flash") && !model.apiId.includes("vision")
    );
  }
  if (WAVE === "larger") {
    return ["kimi-k2.7-code", "deepseek-v4-pro", "glm-5.3"].map((id) => {
      const model = byId.get(id);
      if (!model) {
        throw new Error(`Wave 2 ID ${id} missing from roster`);
      }
      return model;
    });
  }
  throw new Error(`Unknown wave ${WAVE}`);
}

function repsForWave(): number {
  return WAVE === "pilot" ? 1 : 3;
}

async function http(
  url: string,
  init: RequestInit = {}
): Promise<{ json: unknown; status: number; text: string }> {
  const response = await fetch(url, init);
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { json, status: response.status, text };
}

function headers(token?: string, orgId?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Atlas-Auth-Mode": "token",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(orgId ? { "X-Org-Id": orgId } : {}),
  };
}

async function readSseReply(response: Response): Promise<string> {
  const text = await response.text();
  let reply = "";
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }
    const payload = trimmed.slice(5).trim();
    if (!payload) {
      continue;
    }
    try {
      const parsed = JSON.parse(payload) as { reply?: string; type?: string };
      if (parsed.type === "done" && parsed.reply) {
        reply = parsed.reply;
      }
    } catch {
      // ignore
    }
  }
  return reply;
}

async function ensureAtlas(
  catalogId: string
): Promise<{ orgId: string; token: string; profileId: string }> {
  const setup = await http(`${API}/v1/auth/setup`, {
    body: JSON.stringify({
      admin: {
        email: ADMIN_EMAIL,
        name: "Eval Admin",
        password: ADMIN_PASSWORD,
      },
      organization: { name: "Atlas Eval", slug: ORG_SLUG },
    }),
    headers: headers(),
    method: "POST",
  });
  if (setup.status !== 201 && setup.status !== 409) {
    throw new Error(`Atlas setup failed ${setup.status} ${redact(setup.text)}`);
  }

  const login = await http(`${API}/v1/auth/login`, {
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    headers: headers(),
    method: "POST",
  });
  const loginBody = login.json as {
    orgId?: string;
    sessionToken?: string;
  } | null;
  if (login.status !== 200 || !loginBody?.sessionToken || !loginBody.orgId) {
    throw new Error(`Atlas login failed ${login.status} ${redact(login.text)}`);
  }
  const token = loginBody.sessionToken;
  const orgId = loginBody.orgId;

  const listed = await http(`${API}/v1/providers`, {
    headers: headers(token, orgId),
  });
  const providers =
    (listed.json as { providers?: Array<{ id: string; type: string }> } | null)
      ?.providers ?? [];
  const existing = providers.find((item) => item.type === "opencode_go");
  if (!existing) {
    const created = await http(`${API}/v1/providers`, {
      body: JSON.stringify({
        apiKey: KEY,
        label: "OpenCode Go Eval",
        model: catalogId,
        type: "opencode_go",
      }),
      headers: headers(token, orgId),
      method: "POST",
    });
    if (created.status >= 400) {
      throw new Error(
        `Create provider failed ${created.status} ${redact(created.text)}`
      );
    }
    if (JSON.stringify(created.json).includes(KEY)) {
      throw new Error("Provider create echoed API key — aborting");
    }
  }

  const profiles = await http(`${API}/v1/profiles`, {
    headers: headers(token, orgId),
  });
  const profile =
    (
      profiles.json as { profiles?: Array<{ id: string; isDefault?: boolean }> }
    )?.profiles?.find((item) => item.isDefault) ??
    (profiles.json as { profiles?: Array<{ id: string }> })?.profiles?.[0];
  if (!profile) {
    throw new Error("No Atlas profile after setup");
  }
  return { orgId, profileId: profile.id, token };
}

async function runAtlasCell(input: {
  catalogId: string;
  orgId: string;
  profileId: string;
  prompt: string;
  timeoutMs: number;
  token: string;
}): Promise<{
  class: string;
  elapsedMs: number;
  ok: boolean;
  reply: string;
  sessionId?: string;
  status: number;
}> {
  const created = await http(`${API}/v1/sessions`, {
    body: JSON.stringify({
      channel: "web",
      model: input.catalogId,
      profileId: input.profileId,
    }),
    headers: headers(input.token, input.orgId),
    method: "POST",
  });
  const sessionId = (created.json as { sessionId?: string } | null)?.sessionId;
  if (!sessionId) {
    return {
      class: "agent",
      elapsedMs: 0,
      ok: false,
      reply: redact(created.text),
      status: created.status,
    };
  }

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await fetch(
      `${API}/v1/sessions/${encodeURIComponent(sessionId)}/messages?stream=true`,
      {
        body: JSON.stringify({ content: input.prompt, stream: true }),
        headers: {
          ...headers(input.token, input.orgId),
          Accept: "text/event-stream",
        },
        method: "POST",
        signal: controller.signal,
      }
    );
    const reply = response.ok
      ? await readSseReply(response)
      : await response.text();
    const elapsedMs = Date.now() - started;
    const reserved =
      reply.includes("web_search") &&
      (response.status === 400 || /reserved/i.test(reply));
    return {
      class: reserved ? "infra" : reply.trim() ? "ok" : "empty",
      elapsedMs,
      ok: response.ok && Boolean(reply.trim()),
      reply: redact(reply),
      sessionId,
      status: response.status,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      class: /abort/i.test(message) ? "timeout" : "agent",
      elapsedMs: Date.now() - started,
      ok: false,
      reply: redact(message),
      sessionId,
      status: 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runHermesCell(input: {
  apiId: string;
  hermesHome: string;
  prompt: string;
  resultPath: string;
  timeoutMs: number;
}): Promise<{
  class: string;
  elapsedMs: number;
  ok: boolean;
  reply: string;
  status: number;
}> {
  const requestPath = `${input.resultPath}.req.json`;
  await writeFile(
    requestPath,
    `${JSON.stringify(
      {
        apiId: input.apiId,
        baseUrl: "https://opencode.ai/zen/go/v1",
        hermesHome: input.hermesHome,
        hermesRoot: "/tmp/atlas-eval/hermes-agent",
        prompt: input.prompt,
        resultPath: input.resultPath,
      },
      null,
      2
    )}\n`
  );

  const hermesPython =
    process.env.HERMES_PYTHON?.trim() ||
    "/tmp/atlas-eval/hermes-agent/.venv/bin/python";
  const proc = Bun.spawn(
    [hermesPython, join(ROOT, "scripts/eval/run-hermes-cell.py"), requestPath],
    {
      env: {
        ...process.env,
        OPENCODE_GO_API_KEY: KEY,
      },
      stderr: "pipe",
      stdout: "pipe",
    }
  );
  const timeout = setTimeout(() => proc.kill(), input.timeoutMs);
  const exitCode = await proc.exited;
  clearTimeout(timeout);
  const stderr = redact(await new Response(proc.stderr).text());
  let result: {
    class?: string;
    elapsedMs?: number;
    error?: string;
    ok?: boolean;
    reply?: string;
  } = {};
  try {
    result = JSON.parse(await readFile(input.resultPath, "utf8"));
  } catch {
    result = { class: exitCode === 78 ? "infra" : "agent", ok: false };
  }
  return {
    class: result.class ?? (exitCode === 0 ? "ok" : "agent"),
    elapsedMs: result.elapsedMs ?? 0,
    ok: Boolean(result.ok),
    reply: redact(result.reply ?? result.error ?? stderr),
    status: exitCode ?? 1,
  };
}

async function main(): Promise<void> {
  if (!KEY) {
    throw new Error("OPENCODE_GO_API_KEY is required");
  }

  const roster = JSON.parse(
    await readFile(join(ROOT, "artifacts/eval/model-roster.json"), "utf8")
  ) as Roster;
  const expected =
    "da388a47c29410f71ea719088fd7684a7e74adde62329ada43e3c3746827c188";
  if (roster.rosterHash !== expected) {
    throw new Error(
      `Roster hash mismatch: ${roster.rosterHash} !== ${expected}`
    );
  }
  const tasksFile = JSON.parse(
    await readFile(join(ROOT, "artifacts/eval/tasks.json"), "utf8")
  ) as { scored: Task[] };
  const models = modelsForWave(roster);
  const reps = repsForWave();
  const waveId = `${WAVE}-${new Date().toISOString().replaceAll(":", "")}`;
  const waveDir = join(ROOT, "artifacts/eval/runs", waveId);
  await mkdir(waveDir, { recursive: true });

  let atlasAuth: Awaited<ReturnType<typeof ensureAtlas>> | null = null;
  try {
    atlasAuth = await ensureAtlas(models[0]!.catalogId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeFile(
      join(waveDir, "atlas-setup.json"),
      `${JSON.stringify({ error: redact(message), ok: false }, null, 2)}\n`
    );
  }

  const cells: unknown[] = [];
  for (const model of models) {
    for (const task of tasksFile.scored) {
      for (let rep = 1; rep <= reps; rep += 1) {
        for (const agent of ["atlas", "hermes"] as const) {
          const runId = `${agent}-${model.apiId}-${task.id}-r${rep}`;
          const cellDir = join(waveDir, runId);
          await mkdir(cellDir, { recursive: true });
          const prompt = taskPrompt(task, runId);
          const startedAt = new Date().toISOString();
          let result: Record<string, unknown>;
          if (agent === "atlas") {
            if (atlasAuth) {
              result = await runAtlasCell({
                catalogId: model.catalogId,
                orgId: atlasAuth.orgId,
                profileId: atlasAuth.profileId,
                prompt,
                timeoutMs: task.timeoutMs,
                token: atlasAuth.token,
              });
            } else {
              result = {
                class: "infra",
                ok: false,
                reply: "Atlas setup failed",
              };
            }
          } else {
            result = await runHermesCell({
              apiId: model.apiId,
              hermesHome: join("/tmp/atlas-eval/hermes-home", runId),
              prompt,
              resultPath: join(cellDir, "hermes-result.json"),
              timeoutMs: task.timeoutMs,
            });
          }
          const cell = {
            agent,
            catalogId: model.catalogId,
            class: result.class,
            elapsedMs: result.elapsedMs,
            finishedAt: new Date().toISOString(),
            modelApiId: model.apiId,
            ok: result.ok,
            protocol: model.protocol,
            rep,
            reply: redact(String(result.reply ?? "")).slice(0, 4000),
            rosterHash: roster.rosterHash,
            runId,
            startedAt,
            taskId: task.id,
            wave: WAVE,
          };
          if (JSON.stringify(cell).includes(KEY)) {
            throw new Error("Cell artifact contained API key — aborting");
          }
          await writeFile(
            join(cellDir, "cell.json"),
            `${JSON.stringify(cell, null, 2)}\n`
          );
          cells.push(cell);
          console.log(
            JSON.stringify({
              agent,
              class: cell.class,
              model: model.apiId,
              ok: cell.ok,
              runId,
              task: task.id,
            })
          );
        }
      }
    }
  }

  const summary = {
    cells,
    rosterHash: roster.rosterHash,
    wave: WAVE,
    waveId,
  };
  await writeFile(
    join(waveDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`
  );
  const hash = createHash("sha256").update(JSON.stringify(cells)).digest("hex");
  console.log(
    JSON.stringify({ cellCount: cells.length, summaryHash: hash, waveId })
  );
}

main().catch((error) => {
  console.error(redact(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
