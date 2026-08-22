import type { AtlasClient } from "@atlas/client";
import type { WhatsAppAuthStore } from "../../apps/platform/whatsapp/src/auth-store";
import type { MockLLMServerHarness } from "../release-gate/mock-llm-server-harness";
import {
  isZipMagic,
  NOTES_MARKER,
  notesTxt,
  RESULT_MD,
  RESULT_XLSX,
  SALES_MARKER,
  salesCsv,
  salesXlsx,
  zipArchive,
} from "./fixtures";
import {
  createDiscordDocumentProbe,
  createTelegramDocumentProbe,
  createWhatsAppDocumentMessage,
  type DiscordProbe,
  type TelegramProbe,
  type WhatsAppProbe,
} from "./transports";

export interface ScenarioResult {
  durationMs: number;
  evidence: string[];
  id: string;
  message: string;
  required: true;
  status: "pass" | "fail";
}

export interface ChannelLoopContext {
  authStore: WhatsAppAuthStore;
  client: AtlasClient;
  discordHandle: (message: DiscordProbe["message"]) => Promise<void>;
  mockLlm: MockLLMServerHarness;
  orgId: string;
  profileId: string;
  reloadWhatsAppConfig: (ini: string) => Promise<void>;
  telegramHandle: (ctx: TelegramProbe["ctx"]) => Promise<void>;
  whatsapp: WhatsAppProbe;
}

const PAIRED_PHONE_JID = "6281111111111@s.whatsapp.net";
const ALLOWED_PHONE_DIGITS = "6281111111111";
const LID_JID = "236283431522503@lid";
const TG_USER = 4242;
const DISCORD_USER = "424242424242424242";

export async function runChannelLoopScenarios(
  ctx: ChannelLoopContext
): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  const csv = salesCsv();
  const notes = notesTxt();
  const xlsx = await salesXlsx();
  const zip = zipArchive();

  results.push(
    await runScenario("wa_captionless_csv_to_xlsx", async (evidence) => {
      const jid = "6282000000001@s.whatsapp.net";
      ctx.whatsapp.sent.length = 0;
      ctx.whatsapp.setDownload(csv.bytes);
      const before = ctx.mockLlm.recordedRequests.length;
      await ctx.whatsapp.handle({
        inbound: createWhatsAppDocumentMessage({
          fileLength: csv.bytes.byteLength,
          fileName: csv.filename,
          mimeType: csv.mediaType,
          remoteJid: jid,
        }),
        jid,
        text: "",
      });
      assertPromptReachedLlm(ctx, before, evidence);
      await assertFileCameBack(ctx, {
        evidence,
        expectedName: RESULT_XLSX,
        filenames: outboundWhatsAppNames(ctx.whatsapp),
        zip: true,
      });
    })
  );

  results.push(
    await runScenario("wa_xlsx_to_xlsx", async (evidence) => {
      const jid = "6282000000002@s.whatsapp.net";
      ctx.whatsapp.sent.length = 0;
      ctx.whatsapp.setDownload(xlsx.bytes);
      const before = ctx.mockLlm.recordedRequests.length;
      await ctx.whatsapp.handle({
        inbound: createWhatsAppDocumentMessage({
          fileLength: xlsx.bytes.byteLength,
          fileName: xlsx.filename,
          mimeType: xlsx.mediaType,
          remoteJid: jid,
        }),
        jid,
        text: "",
      });
      assertPromptReachedLlm(ctx, before, evidence);
      await assertFileCameBack(ctx, {
        evidence,
        expectedName: RESULT_XLSX,
        filenames: outboundWhatsAppNames(ctx.whatsapp),
        zip: true,
      });
    })
  );

  results.push(
    await runScenario("wa_captionless_txt_to_md", async (evidence) => {
      const jid = "6282000000003@s.whatsapp.net";
      ctx.whatsapp.sent.length = 0;
      ctx.whatsapp.setDownload(notes.bytes);
      const before = ctx.mockLlm.recordedRequests.length;
      await ctx.whatsapp.handle({
        inbound: createWhatsAppDocumentMessage({
          fileLength: notes.bytes.byteLength,
          fileName: notes.filename,
          mimeType: notes.mediaType,
          remoteJid: jid,
        }),
        jid,
        text: "",
      });
      assertPromptReachedLlm(ctx, before, evidence);
      await assertFileCameBack(ctx, {
        evidence,
        expectedName: RESULT_MD,
        filenames: outboundWhatsAppNames(ctx.whatsapp),
        zip: false,
      });
    })
  );

  results.push(
    await runScenario("wa_zip_rejected", async (evidence) => {
      const jid = "6282000000004@s.whatsapp.net";
      ctx.whatsapp.sent.length = 0;
      ctx.whatsapp.setDownload(zip.bytes);
      const before = ctx.mockLlm.recordedRequests.length;
      await ctx.whatsapp.handle({
        inbound: createWhatsAppDocumentMessage({
          fileLength: zip.bytes.byteLength,
          fileName: zip.filename,
          mimeType: zip.mediaType,
          remoteJid: jid,
        }),
        jid,
        text: "",
      });
      if (ctx.mockLlm.recordedRequests.length !== before) {
        throw new Error("Rejected zip still reached the LLM.");
      }
      const reply = ctx.whatsapp.sent[0]?.text ?? "";
      if (!/unsupported file type/i.test(reply)) {
        throw new Error(`Expected unsupported-type reply, got: ${reply}`);
      }
      evidence.push("zip rejected before agent turn");
    })
  );

  results.push(
    await runScenario("tg_captionless_csv_to_xlsx", async (evidence) => {
      const probe = createTelegramDocumentProbe({
        fileName: csv.filename,
        fileSize: csv.bytes.byteLength,
        mimeType: csv.mediaType,
        userId: TG_USER,
      });
      const before = ctx.mockLlm.recordedRequests.length;
      await ctx.telegramHandle(probe.ctx);
      assertPromptReachedLlm(ctx, before, evidence);
      await assertFileCameBack(ctx, {
        evidence,
        expectedName: RESULT_XLSX,
        filenames: probe.documents.map((file) => file.filename),
        zip: true,
      });
    })
  );

  results.push(
    await runScenario("discord_xlsx_to_xlsx", async (evidence) => {
      const url = `https://cdn.channel-loop.test/${xlsx.filename}`;
      const probe = createDiscordDocumentProbe({
        channelId: "dm_channel_loop_xlsx",
        contentType: xlsx.mediaType,
        fileName: xlsx.filename,
        fileSize: xlsx.bytes.byteLength,
        url,
        userId: DISCORD_USER,
      });
      const before = ctx.mockLlm.recordedRequests.length;
      await ctx.discordHandle(probe.message);
      assertPromptReachedLlm(ctx, before, evidence);
      await assertFileCameBack(ctx, {
        evidence,
        expectedName: RESULT_XLSX,
        filenames: probe.documents.map((file) => file.filename),
        zip: true,
      });
    })
  );

  results.push(
    await runScenario("wa_lid_allowlist_drop", async (evidence) => {
      await ctx.reloadWhatsAppConfig(allowlistIni());
      ctx.whatsapp.sent.length = 0;
      ctx.whatsapp.setDownload(csv.bytes);
      const before = ctx.mockLlm.recordedRequests.length;
      await ctx.whatsapp.handle({
        inbound: createWhatsAppDocumentMessage({
          fileLength: csv.bytes.byteLength,
          fileName: csv.filename,
          mimeType: csv.mediaType,
          remoteJid: LID_JID,
        }),
        jid: LID_JID,
        text: "",
      });
      if (ctx.mockLlm.recordedRequests.length !== before) {
        throw new Error("Unmapped LID chat reached the LLM.");
      }
      if (ctx.whatsapp.sent.length > 0) {
        throw new Error("Unmapped LID chat received a reply.");
      }
      evidence.push("unmapped LID dropped with no agent turn");
    })
  );

  results.push(
    await runScenario("wa_lid_allowlist_senderpn", async (evidence) => {
      await ctx.reloadWhatsAppConfig(allowlistIni());
      ctx.whatsapp.sent.length = 0;
      ctx.whatsapp.setDownload(csv.bytes);
      const before = ctx.mockLlm.recordedRequests.length;
      await ctx.whatsapp.handle({
        inbound: createWhatsAppDocumentMessage({
          fileLength: csv.bytes.byteLength,
          fileName: csv.filename,
          mimeType: csv.mediaType,
          remoteJid: LID_JID,
        }),
        jid: LID_JID,
        senderPn: PAIRED_PHONE_JID,
        text: "",
      });
      assertPromptReachedLlm(ctx, before, evidence);
      await assertFileCameBack(ctx, {
        evidence,
        expectedName: RESULT_XLSX,
        filenames: outboundWhatsAppNames(ctx.whatsapp),
        zip: true,
      });
    })
  );

  results.push(
    await runScenario("wa_text_no_file_out", async (evidence) => {
      await ctx.reloadWhatsAppConfig(openIni());
      ctx.whatsapp.sent.length = 0;
      await ctx.whatsapp.handle({
        jid: "6282000000009@s.whatsapp.net",
        text: "hello",
      });
      const files = outboundWhatsAppNames(ctx.whatsapp);
      if (files.length > 0) {
        throw new Error(`Text-only turn sent files: ${files.join(", ")}`);
      }
      const reply = ctx.whatsapp.sent.find((item) => item.text)?.text ?? "";
      if (!reply.trim()) {
        throw new Error("Text-only turn produced no reply.");
      }
      evidence.push(`text reply without file: ${reply.slice(0, 80)}`);
    })
  );

  return results;
}

function registerChannelLoopScenarios(mockLlm: MockLLMServerHarness): void {
  mockLlm.registerScenario({
    handler: (req) => {
      if (isPostTool(req)) {
        return {
          content: `Processed ${SALES_MARKER}. Saved artifacts/${RESULT_XLSX}.`,
        };
      }

      return {
        toolCalls: [
          {
            args: {
              action: "create",
              columns: ["sku", "qty", "revenue"],
              data: [
                ["WIDGET", 5, 250],
                ["GADGET", 3, 180],
              ],
              path: `artifacts/${RESULT_XLSX}`,
              sheetName: "Cleaned",
            },
            name: "spreadsheet",
          },
        ],
      };
    },
    id: "channel-loop-sales",
    matcher: (req) => extractPrompt(req).includes(SALES_MARKER),
  });

  mockLlm.registerScenario({
    handler: (req) => {
      if (isPostTool(req)) {
        return {
          content: `Processed ${NOTES_MARKER}. Saved artifacts/${RESULT_MD}.`,
        };
      }

      return {
        toolCalls: [
          {
            args: {
              content: `# Summary\n\n${NOTES_MARKER} cleaned and saved.\n`,
              path: `artifacts/${RESULT_MD}`,
            },
            name: "write_file",
          },
        ],
      };
    },
    id: "channel-loop-notes",
    matcher: (req) => extractPrompt(req).includes(NOTES_MARKER),
  });
}

export { registerChannelLoopScenarios };

async function runScenario(
  id: string,
  fn: (evidence: string[]) => Promise<void>
): Promise<ScenarioResult> {
  const started = Date.now();
  const evidence: string[] = [];

  try {
    await withTimeout(fn(evidence), 90_000, id);
    return {
      durationMs: Date.now() - started,
      evidence,
      id,
      message: `${id} passed`,
      required: true,
      status: "pass",
    };
  } catch (error) {
    return {
      durationMs: Date.now() - started,
      evidence,
      id,
      message: error instanceof Error ? error.message : String(error),
      required: true,
      status: "fail",
    };
  }
}

function assertPromptReachedLlm(
  ctx: ChannelLoopContext,
  before: number,
  evidence: string[]
): void {
  const added = ctx.mockLlm.recordedRequests.slice(before);
  if (added.length === 0) {
    throw new Error("Inbound file never reached the mock LLM.");
  }

  const prompt = added.map((req) => extractPrompt(req)).join("\n");
  evidence.push(`llm requests after inbound: ${added.length}`);
  if (prompt.includes("[File:")) {
    evidence.push("llm saw [File:] marker from document parser");
  }
}

async function assertFileCameBack(
  ctx: ChannelLoopContext,
  options: {
    evidence: string[];
    expectedName: string;
    filenames: string[];
    zip: boolean;
  }
): Promise<void> {
  if (!options.filenames.includes(options.expectedName)) {
    throw new Error(
      `Channel did not send ${options.expectedName}. Sent: ${options.filenames.join(", ") || "(none)"}`
    );
  }

  const { data } = await ctx.client.readProfileArtifactContent(
    ctx.profileId,
    options.expectedName
  );
  const bytes = new Uint8Array(data);
  if (bytes.byteLength === 0) {
    throw new Error(`${options.expectedName} was empty on disk.`);
  }

  if (options.zip && !isZipMagic(bytes)) {
    throw new Error(
      `${options.expectedName} is not a ZIP/Office file (missing PK header).`
    );
  }

  const listed = await ctx.client.listProfileArtifacts(ctx.profileId);
  const names = listed.artifacts.map(
    (artifact) => artifact.filename ?? artifact.path
  );
  if (!names.some((name) => name.endsWith(options.expectedName))) {
    throw new Error(
      `${options.expectedName} missing from artifact list: ${names.join(", ") || "(empty)"}`
    );
  }

  options.evidence.push(
    `sent ${options.expectedName} (${bytes.byteLength} bytes); listed: ${names.join(", ")}`
  );
}

function outboundWhatsAppNames(probe: WhatsAppProbe): string[] {
  return probe.sent
    .map((item) => item.fileName)
    .filter((name): name is string => Boolean(name));
}

function extractPrompt(req: {
  messages: Array<{
    content?:
      | string
      | Array<{ filename?: string; text?: string; type: string }>;
    role: string;
  }>;
}): string {
  const chunks: string[] = [];

  for (const message of req.messages) {
    if (typeof message.content === "string") {
      chunks.push(message.content);
      continue;
    }

    if (!Array.isArray(message.content)) {
      continue;
    }

    for (const part of message.content) {
      if (typeof part === "string") {
        chunks.push(part);
        continue;
      }

      if (typeof part.text === "string") {
        chunks.push(part.text);
      }
      if (typeof part.filename === "string") {
        chunks.push(part.filename);
      }
    }
  }

  return chunks.join("\n");
}

function isPostTool(req: { messages: Array<{ role: string }> }): boolean {
  return req.messages.at(-1)?.role === "tool";
}

function openIni(): string {
  return [
    "# Atlas WhatsApp bridge",
    "phone_number=1234567890",
    "profile_id=default",
    "access_mode=open",
    `paired_jid=${PAIRED_PHONE_JID}`,
    "",
  ].join("\n");
}

function allowlistIni(): string {
  return [
    "# Atlas WhatsApp bridge",
    "phone_number=1234567890",
    "profile_id=default",
    "access_mode=allowlist",
    `allowed_numbers=${ALLOWED_PHONE_DIGITS}`,
    `paired_jid=${PAIRED_PHONE_JID}`,
    "",
  ].join("\n");
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
