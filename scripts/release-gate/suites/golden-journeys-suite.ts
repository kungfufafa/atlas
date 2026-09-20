import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import type { SessionMessagesResponse } from "../../../packages/core/src/contract";
import { createPptxBuffer } from "../../../packages/core/src/presentation-engine";
import type {
  AuthenticatedPageResult,
  BrowserHarness,
} from "../browser-harness";
import type { ReleaseGateCheck } from "../decision-engine";
import {
  artifactDigest,
  type JourneyTurnEvidence,
  requireAcceptedCancellation,
  requireCancelledStream,
  requireCompletedReply,
  requireCurrentArtifact,
  requireFetchRecovery,
  requireHistoryRetrieval,
  requireMemoryRoundTrip,
  requirePersistedTool,
  requireUploadedDocument,
  verifyOfficeContent,
} from "../golden-journey-evidence";
import type { TestTenantData } from "../test-factories";
import { recoveryFixtureUrls } from "../web-fetch-fixture";

interface ParsedStreamEvent {
  type: string;
  [key: string]: unknown;
}

export function parseChatStreamEvents(body: string): ParsedStreamEvent[] {
  const events: ParsedStreamEvent[] = [];

  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) {
      continue;
    }

    const payload = line.slice("data: ".length).trim();
    if (!payload || payload === "[DONE]") {
      continue;
    }

    const parsed = JSON.parse(payload) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("type" in parsed) ||
      typeof parsed.type !== "string"
    ) {
      throw new Error("Chat stream contained an invalid event payload.");
    }
    events.push(parsed as ParsedStreamEvent);
  }

  return events;
}

export function requirePendingDeleteApproval(
  events: ParsedStreamEvent[]
): void {
  const approvalEvents = events.filter(
    (event) => event.type === "approval_requested"
  );
  if (approvalEvents.length !== 1) {
    throw new Error(
      `Expected exactly one approval request, received ${approvalEvents.length}.`
    );
  }

  const event = approvalEvents[0];
  const approval = event?.approval;
  if (typeof approval !== "object" || approval === null) {
    throw new Error("Approval request did not include approval details.");
  }

  const record = approval as Record<string, unknown>;
  const details = record.details;
  if (
    record.status !== "pending" ||
    record.tool !== "delete_file" ||
    record.title !== "Permanently delete 1 file(s)" ||
    typeof record.consequenceSummary !== "string" ||
    !record.consequenceSummary.includes(
      "Target: artifacts/archived-atlas-export.zip"
    ) ||
    !record.consequenceSummary.includes("This action is irreversible.") ||
    typeof details !== "object" ||
    details === null ||
    (details as Record<string, unknown>).path !==
      "artifacts/archived-atlas-export.zip"
  ) {
    throw new Error("Approval request did not match the destructive action.");
  }

  if (events.some((streamEvent) => streamEvent.type === "tool_end")) {
    throw new Error("Destructive tool executed before user approval.");
  }

  const terminal = events.find((streamEvent) => streamEvent.type === "done");
  if (terminal?.reply !== "Waiting for approval to continue.") {
    throw new Error("Approval-gated turn did not pause before execution.");
  }
}

const latestTurns = new WeakMap<Page, JourneyTurnEvidence>();
const SESSION_MESSAGE_PATH = /\/v1\/sessions\/([^/]+)\/messages$/;

function latestTurn(page: Page): JourneyTurnEvidence {
  const turn = latestTurns.get(page);
  if (!turn) {
    throw new Error("No completed browser turn was observed.");
  }
  return turn;
}

async function requireAssistantTokens(
  page: Page,
  tokens: string[]
): Promise<void> {
  const content = requireCompletedReply(latestTurn(page));
  if (!tokens.some((token) => content.includes(token))) {
    throw new Error(
      `Assistant reply missing expected tokens: ${tokens.join(", ")}`
    );
  }
}

interface JourneyPage extends Omit<AuthenticatedPageResult, "sendMessage"> {
  runId: string;
  sendMessage: (text: string) => Promise<void>;
  startMessage: (text: string) => Promise<void>;
}

async function downloadArtifact(
  page: Page,
  orgId: string,
  runId: string,
  tool: string,
  extension: string
): Promise<Buffer> {
  const turn = latestTurn(page);
  const artifact = requireCurrentArtifact(turn, { extension, runId, tool });
  const route = new URL(page.url()).pathname.split("/");
  if (route[1] !== "chat" || route[3] !== turn.sessionId || !route[2]) {
    throw new Error("Artifact download is not bound to the active chat route.");
  }
  const response = await page.request.get(
    `${new URL(page.url()).origin}/v1/profiles/${encodeURIComponent(route[2])}/artifacts/content`,
    {
      headers: { "X-Org-Id": orgId },
      params: { path: artifact.path.replace(/^artifacts\//, "") },
    }
  );
  if (!response.ok()) {
    throw new Error(`Current artifact download failed (${response.status()}).`);
  }
  return response.body();
}

export async function runGoldenJourneysSuite(
  browserHarness: BrowserHarness,
  serverBaseUrl: string,
  tenant: TestTenantData,
  options: { journeyIds?: ReadonlySet<string> } = {}
): Promise<ReleaseGateCheck[]> {
  const checks: ReleaseGateCheck[] = [];

  const runJourney = async (
    id: string,
    title: string,
    fn: (pageRes: JourneyPage) => Promise<void>
  ) => {
    if (options.journeyIds && !options.journeyIds.has(id)) {
      return;
    }
    const start = Date.now();
    let pageRes: AuthenticatedPageResult | null = null;
    const evidenceFiles: string[] = [];

    try {
      pageRes = await browserHarness.createAuthenticatedPage(serverBaseUrl, {
        email: tenant.adminEmail,
        password: tenant.adminPassword,
      });

      const runId = randomUUID();
      const currentPage = pageRes;
      let turnCount = 0;
      // Every journey starts fresh; memory/history explicitly open another session.
      await currentPage.page.goto(`${serverBaseUrl}/chat?new=1`);
      const withRun = (text: string) => `${text}\nrelease-gate-run: ${runId}`;
      const sendMessage = async (text: string) => {
        const prompt = withRun(text);
        const pending = currentPage.page.waitForResponse(
          (response) => {
            const request = response.request();
            return (
              request.method() === "POST" &&
              SESSION_MESSAGE_PATH.test(new URL(response.url()).pathname) &&
              request.postDataJSON()?.message === prompt
            );
          },
          { timeout: 30_000 }
        );
        await currentPage.sendMessage(prompt);
        const response = await pending;
        if (!response.ok()) {
          throw new Error(
            `Current chat request failed (${response.status()}).`
          );
        }
        const sessionId = decodeURIComponent(
          SESSION_MESSAGE_PATH.exec(new URL(response.url()).pathname)![1]!
        );
        const events = parseChatStreamEvents(await response.text());
        let messages: SessionMessagesResponse["messages"] = [];
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const persisted = await currentPage.page.request.get(
            `${serverBaseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
            {
              headers: { "X-Org-Id": tenant.orgId },
            }
          );
          if (!persisted.ok()) {
            throw new Error(
              "Could not read the current session's persisted history."
            );
          }
          messages = ((await persisted.json()) as SessionMessagesResponse)
            .messages;
          const evidence = { events, messages, prompt, sessionId };
          latestTurns.set(currentPage.page, evidence);
          try {
            requireCompletedReply(evidence);
            turnCount += 1;
            evidenceFiles.push(
              await currentPage.writeEvidence(`${id}-turn-${turnCount}.json`, {
                evidenceKind:
                  "deterministic mock-provider integration, no live inference",
                networkFixture:
                  id === "golden_journey_l"
                    ? "Test-only DNS/HTTP responses: first source 503, alternative 200. Real web_fetch and tool loop execute."
                    : null,
                runId,
                toolAssignments:
                  "Existing isolated tenant profile; no journey-specific additions",
                ...evidence,
              })
            );
            return;
          } catch (error) {
            if (attempt === 19) {
              throw error;
            }
            await currentPage.page.waitForTimeout(100);
          }
        }
      };
      await fn({
        ...currentPage,
        runId,
        screenshot: async (filename) => {
          const path = await currentPage.screenshot(filename);
          evidenceFiles.push(path);
          return path;
        },
        sendMessage,
        startMessage: (text) => currentPage.sendMessage(withRun(text)),
      });

      checks.push({
        category: "Golden Journeys",
        durationMs: Date.now() - start,
        evidence: evidenceFiles,
        id,
        message: `${title}: deterministic local-provider journey verified; no live inference claim`,
        required: true,
        status: "pass",
      });
    } catch (error) {
      checks.push({
        category: "Golden Journeys",
        durationMs: Date.now() - start,
        evidence: evidenceFiles,
        failureCode: "JOURNEY_FAILURE",
        id,
        message: `${title} failed: ${error instanceof Error ? error.message : String(error)}`,
        required: true,
        status: "fail",
      });
    } finally {
      if (pageRes?.context) {
        try {
          await pageRes.context.close();
        } catch {
          // ignore
        }
      }
    }
  };

  // JOURNEY A: Simple Answer
  await runJourney(
    "golden_journey_a",
    "Journey A: Canned answer transport and persistence only",
    async ({ page, sendMessage, screenshot }) => {
      await sendMessage("Explain what a vector database is.");
      await requireAssistantTokens(page, [
        "HNSW",
        "embeddings",
        "approximate nearest neighbor",
      ]);
      await screenshot("journey_a_simple_answer.png");
    }
  );

  // JOURNEY B: Fresh Web Question
  await runJourney(
    "golden_journey_b",
    "Journey B: Canned Bun answer transport only; web lookup unproven",
    async ({ page, sendMessage, screenshot }) => {
      await sendMessage(
        "Search the web for the official Bun documentation and tell me the command used to install a package."
      );
      await requireAssistantTokens(page, ["bun add"]);
      await screenshot("journey_b_fresh_web.png");
    }
  );

  // JOURNEY C: Deep Research
  await runJourney(
    "golden_journey_c",
    "Journey C: Canned report transport only; research quality unproven",
    async ({ page, sendMessage, screenshot }) => {
      await sendMessage(
        "Research three competitors, compare pricing, security, integrations and enterprise positioning."
      );
      await requireAssistantTokens(page, [
        "Research Report",
        "OpenAI",
        "Anthropic",
      ]);
      await screenshot("journey_c_deep_research.png");
    }
  );

  // JOURNEY D: Presentation artifact creation (no research-quality claim)
  await runJourney(
    "golden_journey_d",
    "Journey D: Eight-slide presentation artifact",
    async ({ page, sendMessage, screenshot, runId }) => {
      await sendMessage("Create an 8-slide presentation about Atlas.");
      const bytes = await downloadArtifact(
        page,
        tenant.orgId,
        runId,
        "write_pptx",
        ".pptx"
      );
      verifyOfficeContent(bytes, { expected: [runId], slideCount: 8 });
      await screenshot("journey_d_presentation.png");
    }
  );

  // JOURNEY E: Artifact Revision
  await runJourney(
    "golden_journey_e",
    "Journey E: Artifact Revision",
    async ({ page, sendMessage, screenshot, runId }) => {
      await sendMessage("Make a presentation about Atlas.");
      const before = await downloadArtifact(
        page,
        tenant.orgId,
        runId,
        "write_pptx",
        ".pptx"
      );
      verifyOfficeContent(before, {
        expected: [runId, "Detailed architecture explanation"],
        slideCount: 4,
      });
      await page
        .getByRole("button", { exact: true, name: `Atlas ${runId} slide 4 4` })
        .click();
      await screenshot("journey_e_before_revision.png");
      await sendMessage("Make slide 4 more visual and cut the text by half.");
      const after = await downloadArtifact(
        page,
        tenant.orgId,
        runId,
        "office_document",
        ".pptx"
      );
      verifyOfficeContent(
        after,
        {
          expected: [runId, "Visual architecture summary"],
          forbidden: ["Detailed architecture explanation"],
          slideCount: 4,
        },
        before
      );
      await page
        .getByRole("button", { exact: true, name: `Atlas ${runId} slide 4 4` })
        .click();
      await page
        .getByText("Visual architecture summary", { exact: true })
        .waitFor({ state: "visible" });
      await screenshot("journey_e_artifact_revision.png");
    }
  );

  // JOURNEY F: Spreadsheet
  await runJourney(
    "golden_journey_f",
    "Journey F: Spreadsheet",
    async ({ page, sendMessage, screenshot, runId }) => {
      await sendMessage("Create a financial model from these assumptions.");
      const before = await downloadArtifact(
        page,
        tenant.orgId,
        runId,
        "spreadsheet",
        ".xlsx"
      );
      verifyOfficeContent(before, { expected: [runId, "100000"] });
      await screenshot("journey_f_before_revision.png");
      await sendMessage("Add a downside case.");
      const after = await downloadArtifact(
        page,
        tenant.orgId,
        runId,
        "spreadsheet",
        ".xlsx"
      );
      verifyOfficeContent(
        after,
        { expected: [runId, "Downside Case", "90000", "100000"] },
        before
      );
      await screenshot("journey_f_spreadsheet.png");
    }
  );

  // JOURNEY G: Browser Agent
  await runJourney(
    "golden_journey_g",
    "Journey G: Canned pricing answer transport only; browser capability unproven",
    async ({ page, sendMessage, screenshot }) => {
      await sendMessage(
        "Open the pricing page and check which plan has SSO and audit logs."
      );
      await requireAssistantTokens(page, ["Enterprise Plan"]);
      await screenshot("journey_g_browser_agent.png");
    }
  );

  // JOURNEY H: Actual database persistence and new-session retrieval
  await runJourney(
    "golden_journey_h",
    "Journey H: Cross-session database memory write/search",
    async ({ page, sendMessage, screenshot, runId }) => {
      await sendMessage(
        "For future presentations, keep them concise and executive-friendly."
      );
      const saved = latestTurn(page);
      requirePersistedTool(saved, "memory_write");
      await screenshot("journey_h_saved_memory.png");
      await page.goto(`${serverBaseUrl}/chat?new=1`);
      await sendMessage("How should you present technical explanations?");
      requireMemoryRoundTrip(saved, latestTurn(page), runId);
      await screenshot("journey_h_memory.png");
    }
  );

  // JOURNEY I: History Retrieval
  await runJourney(
    "golden_journey_i",
    "Journey I: History Retrieval",
    async ({ page, sendMessage, screenshot, runId }) => {
      const fact = `Apollo ${runId} launches October 12.`;
      await sendMessage(`History fixture: ${fact}`);
      const seeded = latestTurn(page);
      await screenshot("journey_i_seeded_history.png");
      await page.goto(`${serverBaseUrl}/chat?new=1`);
      await sendMessage("When did I say Apollo launches?");
      requireHistoryRetrieval(seeded, latestTurn(page), fact);
      await screenshot("journey_i_history_retrieval.png");
    }
  );

  // JOURNEY J: Approval
  await runJourney(
    "golden_journey_j",
    "Journey J: Approval",
    async ({ page, sendMessage, screenshot }) => {
      const streamResponse = page.waitForResponse(
        (response: {
          request: () => { method: () => string };
          url: () => string;
        }) =>
          response.request().method() === "POST" &&
          response.url().includes("/v1/sessions/") &&
          response.url().includes("/messages?stream=true"),
        { timeout: 10_000 }
      );
      await sendMessage("Delete the archived Atlas export permanently.");
      const response = await streamResponse;
      const events = parseChatStreamEvents(await response.text());
      requirePendingDeleteApproval(events);

      await page
        .getByText("Permanently delete 1 file(s)", { exact: true })
        .waitFor({ state: "visible", timeout: 10_000 });
      await page
        .getByText("Target: artifacts/archived-atlas-export.zip", {
          exact: false,
        })
        .waitFor({ state: "visible", timeout: 10_000 });
      await page
        .getByRole("button", { exact: true, name: "Confirm" })
        .waitFor({ state: "visible", timeout: 10_000 });
      await page
        .getByRole("button", { exact: true, name: "Cancel" })
        .waitFor({ state: "visible", timeout: 10_000 });

      const transcript = (await page.textContent("body")) ?? "";
      if (
        transcript.includes("archived Atlas export deleted") ||
        transcript.includes("Confirmation #ORD-9821")
      ) {
        throw new Error("UI reported success before user approval.");
      }
      await screenshot("journey_j_approval.png");
    }
  );

  // JOURNEY K: Cancellation
  await runJourney(
    "golden_journey_k",
    "Journey K: Cancellation",
    async ({ page, sendMessage, startMessage, screenshot }) => {
      const startedRequest = page.waitForRequest(
        (request) =>
          request.method() === "POST" &&
          SESSION_MESSAGE_PATH.test(new URL(request.url()).pathname) &&
          request.postDataJSON()?.message?.includes("Start long research")
      );
      await startMessage(
        "Start long research on artificial general intelligence."
      );
      const request = await startedRequest;
      const sessionId = decodeURIComponent(
        SESSION_MESSAGE_PATH.exec(new URL(request.url()).pathname)![1]!
      );
      const statusUrl = `${serverBaseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/status`;
      const active = await page.request.get(statusUrl, {
        headers: { "X-Org-Id": tenant.orgId },
      });
      const status = await active.json();
      if (
        !active.ok() ||
        status.active !== true ||
        typeof status.turnId !== "string"
      ) {
        throw new Error(
          "The cancellation fixture never reached an active server turn."
        );
      }
      const stopBtn = page.getByRole("button", {
        exact: true,
        name: "Stop response",
      });
      await stopBtn.waitFor({ state: "visible", timeout: 10_000 });
      await screenshot("journey_k_before_cancellation.png");
      const cancellation = page
        .waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            new URL(response.url()).pathname ===
              `/v1/sessions/${sessionId}/cancel`
        )
        .then((response) => ({ kind: "response" as const, response }));
      const aborted = page
        .waitForEvent("requestfailed", {
          predicate: (candidate) => candidate === request,
          timeout: 10_000,
        })
        .then((failed) => ({ failed, kind: "abort" as const }));
      await stopBtn.click();
      const cancelled = await Promise.race([cancellation, aborted]);
      if (cancelled.kind === "response") {
        if (!cancelled.response.ok()) {
          throw new Error(
            `Cancellation request failed (${cancelled.response.status()}).`
          );
        }
        requireAcceptedCancellation(
          cancelled.response.request().postDataJSON(),
          await cancelled.response.json(),
          status.turnId
        );
      }
      await stopBtn.waitFor({ state: "hidden", timeout: 10_000 });
      const stopped = await page.request.get(statusUrl, {
        headers: { "X-Org-Id": tenant.orgId },
      });
      const stoppedStatus = await stopped.json();
      if (!stopped.ok() || stoppedStatus.active !== false) {
        throw new Error("The cancelled server turn remained active.");
      }
      if (cancelled.kind === "abort") {
        requireCancelledStream(
          cancelled.failed.failure()?.errorText ?? null,
          stoppedStatus,
          status.turnId
        );
      }
      await sendMessage("What is 2 + 2?");
      if (requireCompletedReply(latestTurn(page)).trim() !== "4") {
        throw new Error(
          "The post-cancellation follow-up did not complete with the expected reply."
        );
      }
      await screenshot("journey_k_cancellation.png");
    }
  );

  // JOURNEY L: Failure Recovery
  await runJourney(
    "golden_journey_l",
    "Journey L: Sequential fetch recovery with deterministic HTTP/DNS fixtures",
    async ({ page, sendMessage, screenshot, runId }) => {
      const urls = recoveryFixtureUrls(runId);
      await sendMessage(
        `Fetch data from ${urls.failure} and continue with ${urls.success} if the first source fails.`
      );
      requireFetchRecovery(latestTurn(page), urls, runId);
      await screenshot("journey_l_failure_recovery.png");
      await sendMessage("What is 2 + 2?");
      if (requireCompletedReply(latestTurn(page)).trim() !== "4") {
        throw new Error(
          "Chat did not accept a follow-up after fetch recovery."
        );
      }
      await screenshot("journey_l_follow_up.png");
    }
  );

  // JOURNEY M: Generated Office Artifact
  await runJourney(
    "golden_journey_m",
    "Journey M: Generated Office Artifact",
    async ({ page, sendMessage, screenshot, runId }) => {
      await sendMessage("Create a 3-slide presentation about Atlas.");
      const bytes = await downloadArtifact(
        page,
        tenant.orgId,
        runId,
        "write_pptx",
        ".pptx"
      );
      verifyOfficeContent(bytes, { expected: [runId], slideCount: 3 });
      await screenshot("journey_m_generated_office.png");
    }
  );

  // JOURNEY N: Uploaded Office Artifact
  await runJourney(
    "golden_journey_n",
    "Journey N: Uploaded Office Artifact",
    async ({ page, sendMessage, screenshot, runId }) => {
      await page.locator("textarea").first().waitFor({
        state: "visible",
        timeout: 10_000,
      });
      const fileInput = page.locator('input[type="file"]').first();
      const filename = `gate-${runId}-upload.pptx`;
      const bytes = await createPptxBuffer({
        slides: [{ layout: "title", title: `Uploaded ${runId}` }],
        themeColor: "3B82F6",
        title: "Upload fixture",
      });
      await fileInput.setInputFiles({
        buffer: bytes,
        mimeType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        name: filename,
      });
      await page
        .getByText(filename, { exact: true })
        .first()
        .waitFor({ state: "visible" });
      await screenshot("journey_n_before_send.png");
      await sendMessage(
        "Inspect the uploaded Office fixture and report its slide title."
      );
      const turn = latestTurn(page);
      const attachmentId = requireUploadedDocument(turn, filename);
      const original = await page.request.get(
        `${serverBaseUrl}/v1/sessions/${encodeURIComponent(turn.sessionId)}/attachments/${encodeURIComponent(attachmentId)}`,
        { headers: { "X-Org-Id": tenant.orgId } }
      );
      if (
        !original.ok() ||
        artifactDigest(await original.body()) !== artifactDigest(bytes)
      ) {
        throw new Error(
          "Persisted upload differs from the original Office bytes."
        );
      }
      const reads = requirePersistedTool(turn, "office_document");
      if (
        !reads.some((event) =>
          JSON.stringify(event.result).includes(`Uploaded ${runId}`)
        )
      ) {
        throw new Error(
          "The actual Office reader did not read this upload's slide title."
        );
      }
      await screenshot("journey_n_uploaded_office.png");
    }
  );

  // JOURNEY O: Two actual artifact formats from one request
  await runJourney(
    "golden_journey_o",
    "Journey O: Presentation and spreadsheet artifact creation",
    async ({ page, sendMessage, screenshot, runId }) => {
      await sendMessage("Build a spreadsheet plus presentation about Atlas.");
      const deck = await downloadArtifact(
        page,
        tenant.orgId,
        runId,
        "write_pptx",
        ".pptx"
      );
      const sheet = await downloadArtifact(
        page,
        tenant.orgId,
        runId,
        "spreadsheet",
        ".xlsx"
      );
      verifyOfficeContent(deck, { expected: [runId], slideCount: 4 });
      verifyOfficeContent(sheet, { expected: [runId, "100000"] });
      await screenshot("journey_o_multi_capability.png");
    }
  );

  // JOURNEY P: Persisted deck edit in the same conversation
  await runJourney(
    "golden_journey_p",
    "Journey P: Same-session deck appendix edit",
    async ({ page, sendMessage, screenshot, runId }) => {
      await sendMessage("Make a presentation about Atlas.");
      const before = await downloadArtifact(
        page,
        tenant.orgId,
        runId,
        "write_pptx",
        ".pptx"
      );
      await sendMessage(
        "Update the deck and add https://bun.sh/docs to the appendix."
      );
      const after = await downloadArtifact(
        page,
        tenant.orgId,
        runId,
        "office_document",
        ".pptx"
      );
      verifyOfficeContent(
        after,
        {
          expected: [runId, "Appendix: https://bun.sh/docs"],
          forbidden: ["Detailed architecture explanation"],
          slideCount: 4,
        },
        before
      );
      await screenshot("journey_p_follow_up_continuity.png");
    }
  );

  return checks;
}
