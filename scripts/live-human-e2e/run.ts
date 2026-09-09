import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@atlas/client";
import { getUserConfigDir } from "@atlas/core/config";
import { loadLocalAuthToken } from "@atlas/core/local-auth";
import { resolveServerUrl } from "@atlas/core/runtime";

interface JourneySpec {
  id: string;
  prompt: string;
  timeoutMs: number;
}

interface ToolTrace {
  input?: Record<string, unknown>;
  resultPreview?: string;
  tool: string;
  toolCallId?: string;
}

interface ApprovalTrace {
  summary?: string;
  tool?: string;
}

interface ArtifactTrace {
  filename?: string;
  id?: string;
}

interface JourneyResult {
  approvals: ApprovalTrace[];
  artifacts: ArtifactTrace[];
  durationMs: number;
  error?: string;
  id: string;
  prompt: string;
  reply: string;
  tools: ToolTrace[];
}

interface DiskFile {
  bytes: number;
  magic: string;
  mtimeMs: number;
  name: string;
  path: string;
}

interface Issue {
  detail: string;
  id: string;
  severity: "info" | "warn" | "fail";
}

const RESULT_PREVIEW_CHARS = 4000;

export function buildJourneys(
  runStamp: string,
  env: Record<string, string | undefined> = process.env
): JourneySpec[] {
  const briefName = `live-e2e-${runStamp}-brief.md`;
  const sheetName = `live-e2e-${runStamp}-facts.xlsx`;
  const destination = env.ATLAS_LIVE_WHATSAPP_TARGET?.trim();
  const sendsAuthorized = env.ATLAS_LIVE_SEND_AUTHORIZED === "1";
  if (sendsAuthorized !== Boolean(destination)) {
    throw new Error(
      "Live sends require ATLAS_LIVE_SEND_AUTHORIZED=1 and ATLAS_LIVE_WHATSAPP_TARGET naming the authorized test recipient."
    );
  }
  if (destination && !/^[1-9]\d{7,14}$/.test(destination)) {
    throw new Error(
      "ATLAS_LIVE_WHATSAPP_TARGET must be an international phone number containing digits only."
    );
  }

  const journeys: JourneySpec[] = [
    {
      id: "presence",
      prompt:
        "Siapa kamu? Kamu asisten siapa? Jam berapa sekarang di timezone saya? Jawab singkat, tanpa basa-basi.",
      timeoutMs: 90_000,
    },
    {
      id: "memory_name",
      prompt:
        "Menurut MEMORY.md, nama orang yang kamu bantu siapa? Kalau ada lebih dari satu nama, sebutkan semuanya apa adanya dan jelaskan mana yang kamu pakai. Jangan merapikan konflik.",
      timeoutMs: 90_000,
    },
    {
      id: "web_research",
      prompt:
        "Saya perlu brief rapat 5 menit soal Tokopedia. Cari di web: kapan berdiri, siapa founder, siapa pemilik mayoritas sekarang. Tulis 4-6 kalimat fakta, lalu 2 tautan sumber yang kamu pakai. Jangan mengarang tautan.",
      timeoutMs: 180_000,
    },
    {
      id: "web_fetch_verify",
      prompt:
        "Fetch https://id.wikipedia.org/wiki/Tokopedia. Dari teks halaman, konfirmasi tanggal pendirian dan nama founder. Kutip 1-2 kalimat dari halaman. Kalau fetch gagal, laporkan error tool apa adanya — jangan mengarang isi halaman.",
      timeoutMs: 180_000,
    },
    {
      id: "write_memo",
      prompt: `Simpan brief rapat Tokopedia ke artifacts/${briefName}. File harus benar-benar tersimpan di workspace, bukan hanya tabel di chat. Isi: 5-8 kalimat + sumber URL. Jangan menulis file sidecar .atlas-meta.json sendiri.`,
      timeoutMs: 180_000,
    },
    {
      id: "spreadsheet",
      prompt: `Buat spreadsheet artifacts/${sheetName} dengan kolom fact, value, source dan 4 baris: founded, founders, majority_owner, wikipedia_url. Jangan hanya tabel di chat — file-nya harus tersimpan.`,
      timeoutMs: 180_000,
    },
    {
      id: "browser_screenshot",
      prompt:
        "Buka https://www.tokopedia.com/about dengan tool browser, baca heading utama halaman itu, lalu ambil screenshot. Tutup browser sesudahnya. Kalau diblokir, captcha, timeout, atau error, laporkan error tool apa adanya — jangan klaim sukses.",
      timeoutMs: 180_000,
    },
  ];
  if (destination) {
    journeys.push({
      id: "whatsapp_send",
      prompt: `Kirim WhatsApp dari nomor pairing workspace ini ke ${destination} berisi teks: Atlas live e2e ping ${runStamp}. Jangan kirim ke nomor lain.`,
      timeoutMs: 90_000,
    });
  }
  return journeys;
}

export async function runLiveHumanE2e(): Promise<{
  issues: Issue[];
  reportPath: string;
  results: JourneyResult[];
}> {
  // Validate live destinations before authenticating or changing profile tools.
  const runStartedMs = Date.now();
  const journeys = buildJourneys(runStartedMs.toString(36));
  const authToken = await loadLocalAuthToken();
  if (!authToken) {
    throw new Error("No local auth token in ~/.atlas.");
  }

  const baseUrl = resolveServerUrl();
  const client = createClient({ authToken, baseUrl });
  const health = await client.health();

  if (!health.ok) {
    throw new Error(`Health check failed against ${baseUrl}`);
  }

  const orgs = await client.listUserOrgs();
  const org = orgs.orgs[0];
  if (!org) {
    throw new Error("No organization available for this user.");
  }

  client.setOrgId(org.id);

  const profiles = await client.listProfiles();
  const profile =
    profiles.profiles.find((item) => item.isDefault && !item.isSuper) ??
    profiles.profiles.find((item) => !item.isSuper) ??
    profiles.profiles[0];
  if (!profile) {
    throw new Error("No chat profile available.");
  }

  const tools = await client.listTools();
  const profileDetail = await client.getProfile(profile.id);
  const profileTools = new Set(
    profileDetail.profile.tools.map((item) => item.id)
  );
  const wanted = [
    "browser",
    "spreadsheet",
    "web_search",
    "web_fetch",
    "write_file",
    "read_file",
  ];
  if (journeys.some((journey) => journey.id === "whatsapp_send")) {
    wanted.push("send_whatsapp");
  }
  for (const name of wanted) {
    const tool = tools.tools.find((item) => item.name === name);
    if (tool && !profileTools.has(tool.id)) {
      await client.assignTool(profile.id, { toolId: tool.id });
      profileTools.add(tool.id);
    }
  }

  const soulDir = join(
    getUserConfigDir(),
    "orgs",
    org.id,
    "profiles",
    profile.id
  );
  const artifactsDir = join(soulDir, "artifacts");
  const memoryText = await readTextIfExists(join(soulDir, "MEMORY.md"));
  const session = await client.createSession("cli", { profileId: profile.id });
  const results: JourneyResult[] = [];

  for (const journey of journeys) {
    const started = Date.now();
    const toolsUsed: ToolTrace[] = [];
    const approvals: ApprovalTrace[] = [];
    const artifacts: ArtifactTrace[] = [];
    try {
      const reply = await withTimeout(
        session.sendStream(journey.prompt, {
          onApprovalRequested: (approval) => {
            approvals.push({
              summary: approval.consequenceSummary || approval.title,
              tool: approval.tool,
            });
          },
          onArtifactCreated: (artifact) => {
            artifacts.push({
              filename: artifact.filename,
              id: artifact.id,
            });
          },
          onChunk: () => {},
          onToolEnd: (event) => {
            const existing = toolsUsed.find(
              (item) =>
                item.toolCallId === event.toolCallId ||
                (item.tool === event.tool && !item.resultPreview)
            );
            const preview = stringifyPreview(event.result);
            if (existing) {
              existing.resultPreview = preview;
              existing.toolCallId = event.toolCallId;
              return;
            }
            toolsUsed.push({
              resultPreview: preview,
              tool: event.tool,
              toolCallId: event.toolCallId,
            });
          },
          onToolStart: (event) => {
            toolsUsed.push({
              input: event.input,
              tool: event.tool,
              toolCallId: event.toolCallId,
            });
          },
        }),
        journey.timeoutMs,
        journey.id
      );
      results.push({
        approvals,
        artifacts,
        durationMs: Date.now() - started,
        id: journey.id,
        prompt: journey.prompt,
        reply: reply.trim(),
        tools: toolsUsed,
      });
    } catch (error) {
      results.push({
        approvals,
        artifacts,
        durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
        id: journey.id,
        prompt: journey.prompt,
        reply: "",
        tools: toolsUsed,
      });
    }
  }

  const messages = await session.getMessages();
  const diskFiles = await listNewArtifactFiles(artifactsDir, runStartedMs);
  const issues = [
    ...collectIssues(results, diskFiles, memoryText),
    ...(await sidecarSizeIssues(diskFiles)),
  ];

  const report = {
    artifactsDir,
    baseUrl,
    diskFiles,
    evidence: {
      liveMessengerDelivery: journeys.some(
        (journey) => journey.id === "whatsapp_send"
      )
        ? "UNVERIFIED"
        : "NOT_RUN",
      providerInference: "UNVERIFIED",
      scope:
        "Configured server requests and post-run heuristics; the resolved upstream provider and live channel delivery are not independently verified.",
    },
    health: {
      ok: health.ok,
      providerConfigured: health.providerConfigured,
    },
    issues,
    memoryPreview: memoryText.slice(0, 1000),
    org: { id: org.id, name: org.name },
    profile: { id: profile.id, name: profile.name },
    results,
    sessionId: session.id,
    soulDir,
    startedAt: new Date(runStartedMs).toISOString(),
    toolMessageCount: messages.filter((message) => message.role === "tool")
      .length,
    toolsAssigned: [...profileTools],
  };

  const outDir = join(import.meta.dir, "out");
  await mkdir(outDir, { recursive: true });
  await mkdir(tmpdir(), { recursive: true });

  const reportJson = `${JSON.stringify(report, null, 2)}\n`;
  const reportMd = formatMarkdown(report);
  const jsonName = "atlas-live-human-e2e-report.json";
  const mdName = "atlas-live-human-e2e-report.md";

  await writeFile(join(outDir, jsonName), reportJson);
  await writeFile(join(outDir, mdName), reportMd);
  await writeFile(join(tmpdir(), jsonName), reportJson);
  await writeFile(join(tmpdir(), mdName), reportMd);

  console.log(reportMd);
  console.log(`\nJSON: ${join(outDir, jsonName)}`);
  console.log(`Markdown: ${join(outDir, mdName)}`);

  return {
    issues,
    reportPath: join(outDir, jsonName),
    results,
  };
}

function stringifyPreview(value: unknown): string {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (text.length <= RESULT_PREVIEW_CHARS) {
    return text;
  }
  return `${text.slice(0, RESULT_PREVIEW_CHARS)}\n…[truncated ${text.length - RESULT_PREVIEW_CHARS} chars]`;
}

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function sidecarSizeIssues(diskFiles: DiskFile[]): Promise<Issue[]> {
  const issues: Issue[] = [];
  for (const file of diskFiles) {
    if (!file.name.endsWith(".atlas-meta.json")) {
      continue;
    }
    try {
      const meta = JSON.parse(await readFile(file.path, "utf8")) as {
        sizeBytes?: unknown;
      };
      const targetName = file.name.replace(/\.atlas-meta\.json$/, "");
      const target = diskFiles.find((item) => item.name === targetName);
      if (
        target &&
        typeof meta.sizeBytes === "number" &&
        meta.sizeBytes !== target.bytes
      ) {
        issues.push({
          detail: `${file.name} records sizeBytes=${meta.sizeBytes} but ${targetName} is ${target.bytes} bytes on disk.`,
          id: `sidecar_size_mismatch_${targetName}`,
          severity: "warn",
        });
      }
    } catch {
      // skip unreadable sidecar
    }
  }
  return issues;
}

async function listNewArtifactFiles(
  artifactsDir: string,
  sinceMs: number
): Promise<DiskFile[]> {
  let names: string[] = [];
  try {
    names = await readdir(artifactsDir);
  } catch {
    return [];
  }

  const files: DiskFile[] = [];
  for (const name of names) {
    const path = join(artifactsDir, name);
    try {
      const info = await stat(path);
      if (!info.isFile() || info.mtimeMs + 1000 < sinceMs) {
        continue;
      }
      const header = await readFile(path);
      files.push({
        bytes: info.size,
        magic: header.subarray(0, 8).toString("hex"),
        mtimeMs: info.mtimeMs,
        name,
        path,
      });
    } catch {
      // skip unreadable entries
    }
  }

  return files.sort((a, b) => a.name.localeCompare(b.name));
}

export function collectIssues(
  results: JourneyResult[],
  diskFiles: DiskFile[],
  memoryText: string
): Issue[] {
  const issues: Issue[] = [];
  const diskNames = new Set(diskFiles.map((file) => file.name));

  if (/Raka/i.test(memoryText) && /Citra/i.test(memoryText)) {
    issues.push({
      detail:
        "MEMORY.md lists both Raka and Citra as the user. Presence/memory answers can pick one and hide the conflict.",
      id: "memory_name_conflict",
      severity: "warn",
    });
  }

  for (const result of results) {
    if (result.error) {
      issues.push({
        detail: `${result.id}: ${result.error}`,
        id: `journey_error_${result.id}`,
        severity: "fail",
      });
    }

    const claimedFiles = [
      ...result.reply.matchAll(/artifacts\/([A-Za-z0-9._-]+)/g),
    ].map((match) => match[1]);
    for (const name of claimedFiles) {
      if (!diskNames.has(name)) {
        issues.push({
          detail: `${result.id} claimed artifacts/${name} but that file was not created during this run.`,
          id: `missing_artifact_${name}`,
          severity: "fail",
        });
      }
    }

    if (result.id === "whatsapp_send") {
      const blocked =
        result.approvals.length > 0 ||
        result.tools.some((tool) =>
          /APPROVAL_REQUIRED/i.test(tool.resultPreview ?? "")
        ) ||
        /tidak terkirim|not sent|persetujuan|approval required/i.test(
          result.reply
        );
      const claimedSent =
        /(berhasil dikirim|sent successfully|message sent|ok:\s*true)/i.test(
          result.reply
        );
      if (claimedSent && blocked) {
        issues.push({
          detail:
            "WhatsApp reply claimed a send while the tool required approval.",
          id: "whatsapp_false_success",
          severity: "fail",
        });
      } else if (blocked) {
        issues.push({
          detail:
            "The turn reported an approval requirement. This runner did not approve it; successful delivery is not independently verified.",
          id: "whatsapp_approval_gate",
          severity: "info",
        });
      } else if (!claimedSent) {
        issues.push({
          detail: `WhatsApp did not confirm a send. Reply: ${result.reply.slice(0, 240)}`,
          id: "whatsapp_not_sent",
          severity: "warn",
        });
      }
    }

    if (result.id === "web_research") {
      const urls = result.reply.match(/https?:\/\/[^\s)]+/g) ?? [];
      if (urls.length < 2) {
        issues.push({
          detail: "Web research did not cite two http(s) source URLs.",
          id: "research_missing_urls",
          severity: "warn",
        });
      }
      const usedSearch = result.tools.some((tool) =>
        /search|web_fetch/i.test(tool.tool)
      );
      if (!usedSearch) {
        issues.push({
          detail:
            "Web research answered without calling a search/fetch tool — facts may be from model memory.",
          id: "research_no_tool",
          severity: "fail",
        });
      }
      const firecrawlFailed = result.tools.find(
        (tool) =>
          /firecrawl/i.test(tool.tool) &&
          /Anonymous keyless|API key/i.test(tool.resultPreview ?? "")
      );
      if (firecrawlFailed) {
        issues.push({
          detail:
            "Agent called Firecrawl MCP, but it has no API key. That call wasted a live turn.",
          id: "firecrawl_unconfigured",
          severity: "warn",
        });
      }
    }

    if (result.id === "browser_screenshot") {
      const png = diskFiles.find((file) => file.name.endsWith(".png"));
      const denied = /gagal|error|tidak.*screenshot|no screenshot|ERR_/i.test(
        result.reply
      );
      const claimedSuccess =
        /(screenshot disimpan|screenshot saved|heading utamanya)/i.test(
          result.reply
        ) && !denied;
      const pngOk = png?.magic.startsWith("89504e47");
      if (claimedSuccess && !pngOk) {
        issues.push({
          detail:
            "Browser turn claimed a screenshot but no PNG with a valid header was written this run.",
          id: "browser_missing_png",
          severity: "fail",
        });
      } else if (denied) {
        issues.push({
          detail: `Browser did not capture the page. ${result.reply.slice(0, 280)}`,
          id: "browser_navigation_failed",
          severity: "warn",
        });
      }
    }

    if (result.id === "spreadsheet") {
      const xlsx = diskFiles.find((file) => file.name.endsWith(".xlsx"));
      if (!xlsx?.magic.startsWith("504b0304")) {
        issues.push({
          detail:
            "Spreadsheet turn did not leave a ZIP/XLSX (PK header) on disk this run.",
          id: "spreadsheet_missing_xlsx",
          severity: "fail",
        });
      }
    }
  }

  return issues;
}

function formatMarkdown(report: {
  artifactsDir: string;
  baseUrl: string;
  diskFiles: DiskFile[];
  health: { ok: boolean; providerConfigured: boolean };
  issues: Issue[];
  memoryPreview: string;
  org: { id: string; name: string };
  profile: { id: string; name: string };
  results: JourneyResult[];
  sessionId: string;
}): string {
  const lines = [
    "# Atlas configured-server journey checks (provider inference unverified)",
    "",
    `- Server: ${report.baseUrl}`,
    `- Provider configured: ${report.health.providerConfigured}`,
    `- Org: ${report.org.name} (${report.org.id})`,
    `- Profile: ${report.profile.name} (${report.profile.id})`,
    `- Session: ${report.sessionId}`,
    `- Artifacts: ${report.artifactsDir}`,
    "",
    "## Issues",
    "",
  ];

  if (report.issues.length === 0) {
    lines.push("None detected by post-run checks.");
    lines.push("");
  } else {
    for (const issue of report.issues) {
      lines.push(`- **${issue.severity}** \`${issue.id}\`: ${issue.detail}`);
    }
    lines.push("");
  }

  lines.push("## MEMORY.md (workspace, not mocked)");
  lines.push("");
  lines.push("```");
  lines.push(report.memoryPreview.trim() || "(empty)");
  lines.push("```");
  lines.push("");

  lines.push("## Files written this run");
  lines.push("");
  if (report.diskFiles.length === 0) {
    lines.push("(none)");
    lines.push("");
  } else {
    for (const file of report.diskFiles) {
      lines.push(`- ${file.name} — ${file.bytes} bytes — magic ${file.magic}`);
    }
    lines.push("");
  }

  for (const result of report.results) {
    lines.push(`## ${result.id} (${result.durationMs}ms)`);
    lines.push("");
    lines.push(`Prompt: ${result.prompt}`);
    lines.push("");
    const toolNames = result.tools.map((tool) => tool.tool);
    lines.push(`Tools: ${toolNames.join(", ") || "(none)"}`);
    lines.push("");
    if (result.error) {
      lines.push(`ERROR: ${result.error}`);
      lines.push("");
    } else {
      lines.push(result.reply || "(empty reply)");
      lines.push("");
    }
    if (result.approvals.length > 0) {
      lines.push("Approvals:");
      lines.push("");
      lines.push("```");
      lines.push(JSON.stringify(result.approvals, null, 2));
      lines.push("```");
      lines.push("");
    }
    if (result.tools.length > 0) {
      lines.push("Tool traces:");
      lines.push("");
      for (const tool of result.tools) {
        lines.push(`### ${tool.tool}`);
        lines.push("");
        if (tool.input) {
          lines.push("Input:");
          lines.push("");
          lines.push("```json");
          lines.push(JSON.stringify(tool.input, null, 2));
          lines.push("```");
          lines.push("");
        }
        if (tool.resultPreview) {
          lines.push("Result:");
          lines.push("");
          lines.push("```");
          lines.push(tool.resultPreview);
          lines.push("```");
          lines.push("");
        }
      }
    }
  }

  return lines.join("\n");
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

if (import.meta.main) {
  const { issues } = await runLiveHumanE2e();
  if (issues.some((issue) => issue.severity === "fail")) {
    process.exit(1);
  }
}
