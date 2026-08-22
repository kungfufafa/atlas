import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StreamHandlers } from "@atlas/client";
import { createClient } from "@atlas/client";
import { loadLocalAuthToken } from "@atlas/core/local-auth";
import { resolveServerUrl } from "@atlas/core/runtime";

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 180_000;
const CODING_TIMEOUT_MS = 420_000;

interface Journey {
  expectTools?: string[];
  id: string;
  profile: "default" | "super" | "hour";
  prompt: string;
  timeoutMs: number;
}

interface TurnResult {
  durationMs: number;
  error?: string;
  expectTools: string[];
  id: string;
  profile: string;
  profileId: string;
  prompt: string;
  reply: string;
  startedAt: string;
  tools: Array<{ resultPreview?: string; tool: string }>;
}

function journeys(stamp: string): Journey[] {
  return [
    {
      id: "default_presence",
      profile: "default",
      prompt:
        "Siapa kamu? Profile apa kamu? Model apa yang kamu pakai kalau kamu tahu? Jawab singkat 4 kalimat. Timezone saya Asia/Jakarta.",
      timeoutMs: 90_000,
    },
    {
      expectTools: ["write_file"],
      id: "default_file",
      profile: "default",
      prompt: `Tulis file artifacts/hour-${stamp}-memo.md berisi 6 kalimat tentang DeepSeek V4 Flash via OpenCode Go di Atlas. File harus benar-benar tersimpan. Jangan menulis sidecar .atlas-meta.json sendiri.`,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    {
      expectTools: ["bash"],
      id: "super_harness_opencode",
      profile: "super",
      prompt:
        "Ini tugas coding. Gunakan skill coding-agent dan CLI OpenCode (`opencode`) lewat bash — jangan hanya write_file jika opencode tersedia. Di workspace profile ini, buat artifacts/ocgo-harness-check.ts berisi `export function add(a: number, b: number) { return a + b; }` lalu jalankan dengan bun. Laporkan: (1) perintah opencode/bash yang kamu jalankan, (2) stdout, (3) apakah harness OpenCode berhasil. Kalau opencode gagal, laporkan error apa adanya.",
      timeoutMs: CODING_TIMEOUT_MS,
    },
    {
      expectTools: ["spreadsheet", "write_file"],
      id: "default_sheet",
      profile: "default",
      prompt: `Buat spreadsheet artifacts/hour-${stamp}-models.xlsx dengan kolom model, role, notes dan 3 baris: deepseek-v4-flash / Default Agent / volume chat; deepseek-v4-pro / Super Agent / coding harness; opencode CLI / Super Agent / repo coding. File harus tersimpan.`,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    {
      expectTools: ["web_search"],
      id: "super_web",
      profile: "super",
      prompt:
        "Cari di web: DeepSeek V4. Tulis 4 kalimat fakta + 2 URL sumber. Jangan mengarang tautan. Kalau web_search gagal, laporkan error tool.",
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    {
      expectTools: ["write_file"],
      id: "hour_presence",
      profile: "hour",
      prompt:
        "Kamu profile uji 1 jam. Sebut nama profile-mu dan kerjakan ini: tulis artifacts/hour-agent-ping.md berisi satu baris ISO timestamp sekarang (Asia/Jakarta) dan kata OK.",
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    {
      expectTools: ["bash"],
      id: "super_harness_followup",
      profile: "super",
      prompt:
        "Lanjut coding-agent/OpenCode. Tambahkan ke artifacts/ocgo-harness-check.ts fungsi `export function mul(a: number, b: number) { return a * b; }` lalu jalankan file itu lagi. Pakai opencode via bash kalau masih tersedia. Laporkan command + stdout.",
      timeoutMs: CODING_TIMEOUT_MS,
    },
    {
      expectTools: ["web_fetch"],
      id: "default_fetch",
      profile: "default",
      prompt:
        "Fetch https://api.github.com/zen. Kutip body-nya. Kalau gagal, laporkan error tool apa adanya.",
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
    {
      expectTools: ["sub_agent"],
      id: "super_subagent",
      profile: "super",
      prompt:
        "Pakai sub_agent untuk merangkum dalam 3 bullet: kapan coding-agent harus memakai OpenCode CLI vs write_file biasa. Kembalikan hasil sub_agent apa adanya.",
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
  ];
}

function preview(value: unknown): string {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > 1500 ? `${text.slice(0, 1500)}\n…` : text;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(
  label: string,
  work: () => Promise<T>,
  attempts = 4
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      const blob = `${error instanceof Error ? error.message : ""} ${JSON.stringify(error)}`;
      if (
        !/connect|ECONNREFUSED|Unable to connect|ConnectionRefused/i.test(blob)
      ) {
        throw error;
      }
      await sleep(1500 * (i + 1));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`${label} failed after retries`);
}

function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout ${ms}ms on ${label}`)),
      ms
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function main(): Promise<void> {
  const authToken = await loadLocalAuthToken();
  if (!authToken) {
    throw new Error("No local auth token");
  }

  const baseUrl = resolveServerUrl();
  const client = createClient({ authToken, baseUrl });
  const health = await client.health();
  if (!health.ok) {
    throw new Error(`Health failed against ${baseUrl}`);
  }

  const me = await client.getMe();
  const orgId = me.activeOrgId ?? me.orgId;
  if (!orgId) {
    throw new Error("No active org");
  }
  client.setOrgId(orgId);

  const listed = await client.listProfiles();
  const defaultProfile =
    listed.profiles.find((p) => p.isDefault && !p.isSuper) ??
    listed.profiles.find((p) => !p.isSuper);
  const superProfile = listed.profiles.find((p) => p.isSuper);
  if (!(defaultProfile && superProfile)) {
    throw new Error("Need Default and Super Agent profiles");
  }

  let hourProfile = listed.profiles.find((p) => p.name === "Hour Test Agent");
  if (!hourProfile) {
    const cloned = await client.cloneProfile(defaultProfile.id, {
      name: "Hour Test Agent",
    });
    hourProfile = cloned.profile;
  }

  const goProviderId = "ae5d0a4d-c47b-4963-b7ae-1abc3b774099";
  await client.updateProfile(hourProfile.id, {
    model: `${goProviderId}::opencode-go/deepseek-v4-flash`,
  });

  const skills = await client.listSkills();
  const tools = await client.listTools();
  const codingSkill = skills.skills.find((s) => s.name === "coding-agent");
  const bashTool = tools.tools.find((t) => t.name === "bash");
  const superDetail = await client.getProfile(superProfile.id);
  const superSkillIds = new Set(superDetail.profile.skills.map((s) => s.id));
  const superToolNames = new Set(superDetail.profile.tools.map((t) => t.name));
  if (codingSkill && !superSkillIds.has(codingSkill.id)) {
    await client.assignSkill(superProfile.id, { skillId: codingSkill.id });
  }
  if (bashTool && !superToolNames.has("bash")) {
    await client.assignTool(superProfile.id, { toolId: bashTool.id });
  }

  const stamp = Date.now().toString(36);
  const startedAt = Date.now();
  const deadline = startedAt + HOUR_MS;
  const queue = journeys(stamp);
  const results: TurnResult[] = [];
  let round = 0;

  const outDir = join(import.meta.dir, "out");
  await mkdir(outDir, { recursive: true });
  const reportPath = join(outDir, `hour-opencode-go-${stamp}.json`);

  const profileMap = {
    default: defaultProfile,
    hour: hourProfile,
    super: superProfile,
  };

  console.log(
    JSON.stringify({
      baseUrl,
      deadline: new Date(deadline).toISOString(),
      defaultProfile: defaultProfile.name,
      hourProfile: hourProfile.name,
      orgId,
      superProfile: superProfile.name,
    })
  );

  while (Date.now() < deadline) {
    round += 1;
    for (const journey of queue) {
      if (Date.now() >= deadline) {
        break;
      }
      const profile = profileMap[journey.profile];
      let session;
      try {
        session = await withRetry(`session ${journey.id}`, () =>
          client.createSession("cli", {
            profileId: profile.id,
          })
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : JSON.stringify(error) || String(error);
        console.log(
          JSON.stringify({
            durationMs: 0,
            error: message,
            harnessHits: 0,
            id: `${journey.id}_r${round}`,
            profile: journey.profile,
            replyChars: 0,
            tools: [],
          })
        );
        await sleep(2000);
        continue;
      }
      const toolsUsed: TurnResult["tools"] = [];
      const handlers: StreamHandlers = {
        onChunk: () => {},
        onToolEnd: (event) => {
          toolsUsed.push({
            resultPreview: preview(event.result),
            tool: event.tool,
          });
        },
        onToolStart: (event) => {
          toolsUsed.push({ tool: event.tool });
        },
      };
      const turnStarted = Date.now();
      const turn: TurnResult = {
        durationMs: 0,
        expectTools: journey.expectTools ?? [],
        id: `${journey.id}_r${round}`,
        profile: journey.profile,
        profileId: profile.id,
        prompt: journey.prompt,
        reply: "",
        startedAt: new Date(turnStarted).toISOString(),
        tools: toolsUsed,
      };
      try {
        const remaining = deadline - Date.now();
        const timeout = Math.min(
          journey.timeoutMs,
          Math.max(15_000, remaining)
        );
        turn.reply = (
          await withTimeout(
            session.sendStream(journey.prompt, handlers),
            timeout,
            turn.id
          )
        ).trim();
      } catch (error) {
        turn.error = error instanceof Error ? error.message : String(error);
      }
      turn.durationMs = Date.now() - turnStarted;
      results.push(turn);
      const harnessHits = toolsUsed.filter((t) =>
        /bash|opencode/i.test(`${t.tool} ${t.resultPreview ?? ""}`)
      ).length;
      console.log(
        JSON.stringify({
          durationMs: turn.durationMs,
          error: turn.error ?? null,
          harnessHits,
          id: turn.id,
          profile: turn.profile,
          replyChars: turn.reply.length,
          tools: [...new Set(toolsUsed.map((t) => t.tool))],
        })
      );
      await writeFile(
        reportPath,
        `${JSON.stringify(
          {
            elapsedMs: Date.now() - startedAt,
            remainingMs: Math.max(0, deadline - Date.now()),
            results,
            rounds: round,
          },
          null,
          2
        )}\n`
      );
    }
  }

  const toolCounts = new Map<string, number>();
  let harnessTurns = 0;
  let errors = 0;
  for (const turn of results) {
    if (turn.error) {
      errors += 1;
    }
    const names = new Set(turn.tools.map((t) => t.tool));
    if (names.has("bash")) {
      harnessTurns += 1;
    }
    for (const name of names) {
      toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
    }
  }

  const summary = {
    deadline: new Date(deadline).toISOString(),
    elapsedMs: Date.now() - startedAt,
    errors,
    harnessTurns,
    reportPath,
    startedAt: new Date(startedAt).toISOString(),
    successTurns: results.length - errors,
    toolCounts: Object.fromEntries([...toolCounts.entries()].sort()),
    turns: results.length,
  };
  await writeFile(
    join(outDir, `hour-opencode-go-${stamp}-summary.json`),
    `${JSON.stringify(summary, null, 2)}\n`
  );
  console.log(JSON.stringify({ done: true, ...summary }));
}

await main();
