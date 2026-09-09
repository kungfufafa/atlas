import type { AtlasClient } from "@atlas/client";
import { toArtifactsRelativePath } from "@atlas/core/channel-artifacts";
import type { WhatsAppAuthStore } from "../../apps/platform/whatsapp/src/auth-store";
import type {
  MockChatRequest,
  MockLLMServerHarness,
} from "../release-gate/mock-llm-server-harness";
import {
  assertSalesResult,
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
  type OutboundFile,
  type TelegramProbe,
  type WhatsAppProbe,
} from "./transports";

export interface ScenarioResult {
  diagnostics?: {
    apiRequests: ChannelLoopApiRequest[];
    whatsappReplies: Array<{
      text?: string;
      fileName?: string;
      mimetype?: string;
    }>;
  };
  durationMs: number;
  evidence: string[];
  id: string;
  message: string;
  required: true;
  status: "pass" | "fail";
}

export interface ChannelLoopApiRequest {
  error?: string;
  method: string;
  path: string;
  status?: number;
}

export interface ChannelLoopContext {
  apiRequests?: ChannelLoopApiRequest[];
  assertGuestSession: (
    channel: "whatsapp" | "telegram" | "discord",
    channelUserId: string
  ) => Promise<void>;
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
  const runScenario = async (
    id: string,
    fn: (evidence: string[]) => Promise<void>
  ) => {
    const before = ctx.apiRequests?.length ?? 0;
    const result = await runScenarioResult(id, fn);
    if (result.status === "fail") {
      result.diagnostics = {
        apiRequests: ctx.apiRequests?.slice(before) ?? [],
        whatsappReplies: id.startsWith("wa_")
          ? ctx.whatsapp.sent.map(({ text, fileName, mimetype }) => ({
              fileName,
              mimetype,
              text,
            }))
          : [],
      };
    }
    return result;
  };
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
        files: outboundWhatsAppFiles(ctx.whatsapp),
        requests: ctx.mockLlm.recordedRequests.slice(before),
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
        files: outboundWhatsAppFiles(ctx.whatsapp),
        requests: ctx.mockLlm.recordedRequests.slice(before),
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
        files: outboundWhatsAppFiles(ctx.whatsapp),
        requests: ctx.mockLlm.recordedRequests.slice(before),
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
        files: probe.documents,
        requests: ctx.mockLlm.recordedRequests.slice(before),
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
        files: probe.documents,
        requests: ctx.mockLlm.recordedRequests.slice(before),
        zip: true,
      });
    })
  );

  results.push(
    await runScenario("wa_unpaired_guest_csv_to_xlsx", async (evidence) => {
      const jid = "6282000000010@s.whatsapp.net";
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
        text: "Clean this workbook and send the result",
      });
      await ctx.assertGuestSession("whatsapp", jid);
      assertPromptReachedLlm(ctx, before, evidence);
      await assertFileCameBack(ctx, {
        evidence,
        expectedName: RESULT_XLSX,
        files: outboundWhatsAppFiles(ctx.whatsapp),
        requests: ctx.mockLlm.recordedRequests.slice(before),
        zip: true,
      });
      evidence.push("unpaired sender used an authorized guest session");
    })
  );

  results.push(
    await runScenario("tg_unpaired_guest_csv_to_xlsx", async (evidence) => {
      const userId = 4244;
      const probe = createTelegramDocumentProbe({
        caption: "Clean this workbook and send the result",
        fileName: csv.filename,
        fileSize: csv.bytes.byteLength,
        mimeType: csv.mediaType,
        userId,
      });
      const before = ctx.mockLlm.recordedRequests.length;
      await ctx.telegramHandle(probe.ctx);
      await ctx.assertGuestSession("telegram", String(userId));
      assertPromptReachedLlm(ctx, before, evidence);
      await assertFileCameBack(ctx, {
        evidence,
        expectedName: RESULT_XLSX,
        files: probe.documents,
        requests: ctx.mockLlm.recordedRequests.slice(before),
        zip: true,
      });
      evidence.push("unpaired sender used an authorized guest session");
    })
  );

  results.push(
    await runScenario(
      "discord_unpaired_guest_xlsx_to_xlsx",
      async (evidence) => {
        const userId = "424242424242424244";
        const probe = createDiscordDocumentProbe({
          caption: "Clean this workbook and send the result",
          channelId: "dm_channel_loop_guest",
          contentType: xlsx.mediaType,
          fileName: xlsx.filename,
          fileSize: xlsx.bytes.byteLength,
          url: `https://cdn.channel-loop.test/${xlsx.filename}`,
          userId,
        });
        const before = ctx.mockLlm.recordedRequests.length;
        await ctx.discordHandle(probe.message);
        await ctx.assertGuestSession("discord", userId);
        assertPromptReachedLlm(ctx, before, evidence);
        await assertFileCameBack(ctx, {
          evidence,
          expectedName: RESULT_XLSX,
          files: probe.documents,
          requests: ctx.mockLlm.recordedRequests.slice(before),
          zip: true,
        });
        evidence.push("unpaired sender used an authorized guest session");
      }
    )
  );

  results.push(
    await runScenario("wa_unpaired_guest_txt_to_md", async (evidence) => {
      const jid = "6282000000011@s.whatsapp.net";
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
        text: "Finish these notes and send a summary file",
      });
      await ctx.assertGuestSession("whatsapp", jid);
      assertPromptReachedLlm(ctx, before, evidence);
      await assertFileCameBack(ctx, {
        evidence,
        expectedName: RESULT_MD,
        files: outboundWhatsAppFiles(ctx.whatsapp),
        requests: ctx.mockLlm.recordedRequests.slice(before),
        zip: false,
      });
      evidence.push("unpaired sender used an authorized guest session");
    })
  );

  results.push(
    await runScenario("tg_unpaired_guest_txt_to_md", async (evidence) => {
      const userId = 4245;
      const probe = createTelegramDocumentProbe({
        caption: "Finish these notes and send a summary file",
        fileName: notes.filename,
        fileSize: notes.bytes.byteLength,
        mimeType: notes.mediaType,
        userId,
      });
      const before = ctx.mockLlm.recordedRequests.length;
      await ctx.telegramHandle(probe.ctx);
      await ctx.assertGuestSession("telegram", String(userId));
      assertPromptReachedLlm(ctx, before, evidence);
      await assertFileCameBack(ctx, {
        evidence,
        expectedName: RESULT_MD,
        files: probe.documents,
        requests: ctx.mockLlm.recordedRequests.slice(before),
        zip: false,
      });
      evidence.push("unpaired sender used an authorized guest session");
    })
  );

  results.push(
    await runScenario("discord_unpaired_guest_txt_to_md", async (evidence) => {
      const userId = "424242424242424245";
      const probe = createDiscordDocumentProbe({
        caption: "Finish these notes and send a summary file",
        channelId: "dm_channel_loop_guest_notes",
        contentType: notes.mediaType,
        fileName: notes.filename,
        fileSize: notes.bytes.byteLength,
        url: `https://cdn.channel-loop.test/${notes.filename}`,
        userId,
      });
      const before = ctx.mockLlm.recordedRequests.length;
      await ctx.discordHandle(probe.message);
      await ctx.assertGuestSession("discord", userId);
      assertPromptReachedLlm(ctx, before, evidence);
      await assertFileCameBack(ctx, {
        evidence,
        expectedName: RESULT_MD,
        files: probe.documents,
        requests: ctx.mockLlm.recordedRequests.slice(before),
        zip: false,
      });
      evidence.push("unpaired sender used an authorized guest session");
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
        files: outboundWhatsAppFiles(ctx.whatsapp),
        requests: ctx.mockLlm.recordedRequests.slice(before),
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

const SAVED_SOURCE_PATH_PATTERN =
  /The original file is saved at ("(?:[^"\\]|\\.)*")/;

function registerChannelLoopScenarios(mockLlm: MockLLMServerHarness): void {
  mockLlm.registerScenario({
    handler: (req) => {
      const sourcePath = savedSourcePath(req)!;
      const results = completedToolResults(req, false);
      const failed = results.find((result) => result.result.error);
      if (failed) {
        return {
          content: `Could not process the source file: ${String(failed.result.error)}`,
        };
      }
      const written = results.find(
        (result) =>
          result.name === "spreadsheet" && result.args.action === "create"
      );
      if (written) {
        return {
          content: `Saved artifacts/${canonicalReturnedPath([req], RESULT_XLSX)}.`,
        };
      }
      const source = results.find(
        (result) =>
          result.name === "spreadsheet" &&
          result.args.action === "read_range" &&
          result.args.path === sourcePath
      );
      if (!source) {
        return {
          toolCalls: [
            {
              args: { action: "read_range", path: sourcePath },
              name: "spreadsheet",
            },
          ],
        };
      }
      const rows = source.result.rows;
      if (
        !Array.isArray(rows) ||
        rows.some((row) => !Array.isArray(row)) ||
        source.result.hasMoreRows ||
        source.result.hasMoreColumns
      ) {
        throw new Error(
          "Source spreadsheet read did not provide complete rows."
        );
      }
      const columns = rows[0];
      const data = rows
        .slice(1)
        .filter((row) => row[0] !== SALES_MARKER)
        .map((row) => [row[0], Number(row[1]), Number(row[2])]);
      return {
        toolCalls: [
          {
            args: {
              action: "create",
              columns,
              data,
              path: `artifacts/${RESULT_XLSX}`,
              sheetName: "Cleaned",
            },
            name: "spreadsheet",
          },
        ],
      };
    },
    id: "channel-loop-sales",
    matcher: (req) => /\.(?:csv|xlsx)$/.test(savedSourcePath(req) ?? ""),
  });
  mockLlm.registerScenario({
    handler: (req) => {
      const sourcePath = savedSourcePath(req)!;
      const results = completedToolResults(req, false);
      const failed = results.find((result) => result.result.error);
      if (failed) {
        return {
          content: `Could not process the source file: ${String(failed.result.error)}`,
        };
      }
      const written = results.find((result) => result.name === "write_file");
      if (written) {
        return {
          content: `Saved artifacts/${canonicalReturnedPath([req], RESULT_MD)}.`,
        };
      }
      const source = results.find(
        (result) =>
          result.name === "read_file" && result.args.path === sourcePath
      );
      if (!source) {
        return {
          toolCalls: [{ args: { path: sourcePath }, name: "read_file" }],
        };
      }
      const content = source.result.content;
      if (typeof content !== "string" || !content.includes(NOTES_MARKER)) {
        throw new Error("Source read_file did not return the attached notes.");
      }
      return {
        toolCalls: [
          {
            args: {
              content: `# Summary\n\n${content.split("\n")[0]} cleaned and saved.\n`,
              path: `artifacts/${RESULT_MD}`,
            },
            name: "write_file",
          },
        ],
      };
    },
    id: "channel-loop-notes",
    matcher: (req) => /\.txt$/.test(savedSourcePath(req) ?? ""),
  });
}

function savedSourcePath(req: MockChatRequest): string | null {
  const user = req.messages.findLast((message) => message.role === "user");
  if (!user) {
    return null;
  }
  const match = SAVED_SOURCE_PATH_PATTERN.exec(
    extractPrompt({ messages: [user] })
  );
  return match?.[1] ? (JSON.parse(match[1]) as string) : null;
}

interface CompletedToolResult {
  args: Record<string, unknown>;
  name: string;
  result: Record<string, unknown>;
}

function completedToolResults(
  req: MockChatRequest,
  failOnToolError = true
): CompletedToolResult[] {
  const calls = new Map<
    string,
    { name: string; args: Record<string, unknown> }
  >();
  for (const message of req.messages) {
    for (const call of message.tool_calls ?? []) {
      const raw: unknown = call.function
        ? Reflect.get(call.function, "arguments")
        : undefined;
      if (typeof raw !== "string" || !call.function?.name) {
        continue;
      }
      const args: unknown = JSON.parse(raw);
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        throw new Error("Invalid tool arguments in channel loop");
      }
      calls.set(call.id, {
        args: args as Record<string, unknown>,
        name: call.function.name,
      });
    }
  }
  const results: CompletedToolResult[] = [];
  for (const message of req.messages) {
    const call = message.tool_call_id
      ? calls.get(message.tool_call_id)
      : undefined;
    if (
      message.role !== "tool" ||
      !call ||
      typeof message.content !== "string"
    ) {
      continue;
    }
    const result: unknown = JSON.parse(message.content);
    if (
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      (failOnToolError && Reflect.get(result, "error"))
    ) {
      throw new Error(`Source or output tool failed: ${message.content}`);
    }
    results.push({ ...call, result: result as Record<string, unknown> });
  }
  return results;
}

export { registerChannelLoopScenarios };

async function runScenarioResult(
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

  const initialPrompt = extractPrompt({
    messages: added[0]!.messages.filter((message) => message.role === "user"),
  });
  evidence.push(`llm requests after inbound: ${added.length}`);
  if (initialPrompt.includes("[File:")) {
    throw new Error("The source attachment was dumped into the prompt.");
  }
  const sourcePath = savedSourcePath(added[0]!);
  if (!sourcePath) {
    throw new Error("The first turn did not receive a saved source path.");
  }
  if (
    initialPrompt.includes(SALES_MARKER) ||
    initialPrompt.includes(NOTES_MARKER)
  ) {
    throw new Error(
      "Source content reached the model before the matching file tool ran."
    );
  }
  const sourceRead = added
    .flatMap((request) => completedToolResults(request))
    .find(
      (result) =>
        result.args.path === sourcePath &&
        (result.name === "read_file" ||
          (result.name === "spreadsheet" &&
            result.args.action === "read_range"))
    );
  if (!sourceRead) {
    throw new Error("The matching source tool did not run on the saved path.");
  }
  evidence.push(
    `${sourceRead.name} read original ${sourcePath} before creating the result`
  );
}

async function assertFileCameBack(
  ctx: ChannelLoopContext,
  options: {
    evidence: string[];
    expectedName: string;
    files: OutboundFile[];
    requests: MockChatRequest[];
    zip: boolean;
  }
): Promise<void> {
  const returnedPath = canonicalReturnedPath(
    options.requests,
    options.expectedName
  );
  const returnedName = returnedPath.split("/").at(-1)!;
  const matches = options.files.filter(
    (file) => file.filename === returnedName
  );
  const sent = matches[0];
  if (matches.length !== 1 || !sent?.bytes) {
    throw new Error(
      `Expected exactly one captured upload for returned path ${returnedPath}; received ${options.files.map((file) => file.filename).join(", ") || "none"}.`
    );
  }

  const { data } = await ctx.client.readProfileArtifactContent(
    ctx.profileId,
    returnedPath
  );
  const bytes = new Uint8Array(data);
  if (!Buffer.from(bytes).equals(Buffer.from(sent.bytes))) {
    throw new Error(
      `Uploaded bytes differ from the canonical saved artifact ${returnedPath}.`
    );
  }
  if (bytes.byteLength === 0) {
    throw new Error(`${options.expectedName} was empty on disk.`);
  }

  if (options.zip && !isZipMagic(bytes)) {
    throw new Error(
      `${options.expectedName} is not a ZIP/Office file (missing PK header).`
    );
  }

  if (options.zip) {
    await assertSalesResult(bytes);
  } else if (
    Buffer.from(bytes).toString("utf8") !==
    `# Summary\n\n${NOTES_MARKER} cleaned and saved.\n`
  ) {
    throw new Error(
      "Uploaded markdown does not contain the exact expected summary."
    );
  }

  const listed = await ctx.client.listProfileArtifacts(ctx.profileId);
  const names = listed.artifacts.map(
    (artifact) => artifact.filename ?? artifact.path
  );
  if (!names.some((name) => name === returnedPath)) {
    throw new Error(
      `${options.expectedName} missing from artifact list: ${names.join(", ") || "(empty)"}`
    );
  }

  options.evidence.push(
    `sent canonical ${returnedPath} (${bytes.byteLength} exact bytes); verified document content; listed: ${names.join(", ")}`
  );
}

function canonicalReturnedPath(
  requests: MockChatRequest[],
  requestedName: string
): string {
  const paths = new Set<string>();
  for (const request of requests) {
    const calls = new Set<string>();
    for (const message of request.messages) {
      for (const call of message.tool_calls ?? []) {
        const raw: unknown = call.function
          ? Reflect.get(call.function, "arguments")
          : undefined;
        if (typeof raw !== "string") {
          continue;
        }
        const input: unknown = JSON.parse(raw);
        if (
          input &&
          typeof input === "object" &&
          Reflect.get(input, "path") === `artifacts/${requestedName}`
        ) {
          calls.add(call.id);
        }
      }
    }
    for (const message of request.messages) {
      if (
        message.role !== "tool" ||
        !message.tool_call_id ||
        !calls.has(message.tool_call_id) ||
        typeof message.content !== "string"
      ) {
        continue;
      }
      const result: unknown = JSON.parse(message.content);
      if (
        !result ||
        typeof result !== "object" ||
        Reflect.get(result, "error")
      ) {
        throw new Error(
          "Requested artifact tool did not complete successfully."
        );
      }
      const resultPath: unknown = Reflect.get(result, "path");
      const relativePath =
        typeof resultPath === "string"
          ? toArtifactsRelativePath(resultPath)
          : null;
      if (!relativePath) {
        throw new Error(
          "Requested artifact tool did not return an artifacts path."
        );
      }
      paths.add(relativePath);
    }
  }
  if (paths.size !== 1) {
    throw new Error(
      `Expected one canonical returned path for ${requestedName}, received ${paths.size}.`
    );
  }
  return [...paths][0]!;
}

function outboundWhatsAppFiles(probe: WhatsAppProbe): OutboundFile[] {
  return probe.sent.flatMap((item) =>
    item.fileName
      ? [
          {
            bytes:
              item.document instanceof Uint8Array
                ? new Uint8Array(item.document)
                : undefined,
            filename: item.fileName,
          },
        ]
      : []
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
