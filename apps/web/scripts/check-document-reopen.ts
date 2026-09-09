/**
 * Read-only browser regression for a local QA chat containing document uploads.
 * Run against Vite (React StrictMode) with a saved Playwright storage state:
 * ATLAS_UI_QA_SESSION_URL=http://127.0.0.1:3000/chat/<profile>/<session>
 * ATLAS_UI_QA_STORAGE_STATE=/tmp/qa/browser-state.json
 * ATLAS_UI_QA_DOCUMENTS=slides.pptx,table.tsv,data.json,records.jsonl
 * ATLAS_UI_QA_REPLY='Expected fixture reply'
 * bun run apps/web/scripts/check-document-reopen.ts
 * Optional: ATLAS_UI_QA_ORIGINALS_DIR compares downloads with original fixtures.
 * Optional: ATLAS_UI_QA_OUTPUT_DIR selects the screenshot/report directory.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  MessageContentPart,
  SessionMessagesResponse,
} from "@atlas/core/contract";
import { chromium, type Page } from "playwright";

function required(name: string): string {
  const value = process.env[name]?.trim();
  assert.ok(value, `${name} is required.`);
  return value;
}

async function assertChatVisible(
  page: Page,
  documents: string[],
  reply: string
) {
  await page
    .getByText(reply, { exact: true })
    .first()
    .waitFor({ timeout: 30_000 });
  for (const document of documents) {
    await page.getByText(document, { exact: true }).first().waitFor();
  }
  assert.equal(
    await page
      .getByRole("button", { exact: true, name: "Stop response" })
      .count(),
    0
  );
}

const sessionUrl = new URL(required("ATLAS_UI_QA_SESSION_URL"));
assert.ok(
  ["localhost", "127.0.0.1", "[::1]"].includes(sessionUrl.hostname),
  "Use an isolated local QA server."
);
const route = /^\/chat\/([^/]+)\/([^/]+)$/.exec(sessionUrl.pathname);
assert.ok(route, "Session URL must identify a profile and a session.");
const documents = required("ATLAS_UI_QA_DOCUMENTS")
  .split(",")
  .map((name) => name.trim());
const reply = required("ATLAS_UI_QA_REPLY");
const outputDirectory =
  process.env.ATLAS_UI_QA_OUTPUT_DIR ??
  (await mkdtemp(path.join(tmpdir(), "atlas-document-reopen-")));
await mkdir(outputDirectory, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    storageState: required("ATLAS_UI_QA_STORAGE_STATE"),
    viewport: { height: 1000, width: 1440 },
  });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const meResponse = await context.request.get(
    `${sessionUrl.origin}/v1/auth/me`
  );
  assert.equal(meResponse.status(), 200);
  const me = await meResponse.json();
  const headers = { "X-Org-Id": me.activeOrgId ?? me.orgId };
  const messagesUrl = `${sessionUrl.origin}/v1/sessions/${route[2]}/messages`;
  const historyResponse = await context.request.get(messagesUrl, { headers });
  assert.equal(historyResponse.status(), 200);
  const history = (await historyResponse.json()) as SessionMessagesResponse;
  const attachments = history.messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.filter(
          (
            part
          ): part is Extract<MessageContentPart, { type: "document_ref" }> =>
            part.type === "document_ref"
        )
      : []
  );
  assert.deepEqual(
    attachments.map((file) => file.filename).sort(),
    [...documents].sort()
  );
  assert.equal(
    new Set(attachments.map((file) => file.attachmentId)).size,
    documents.length
  );
  for (const attachment of attachments) {
    assert.ok(attachment.attachmentId);
    const response = await context.request.get(
      `${sessionUrl.origin}/v1/sessions/${route[2]}/attachments/${attachment.attachmentId}`,
      { headers }
    );
    assert.equal(response.status(), 200);
    if (process.env.ATLAS_UI_QA_ORIGINALS_DIR) {
      assert.equal(path.basename(attachment.filename), attachment.filename);
      const original = await readFile(
        path.join(process.env.ATLAS_UI_QA_ORIGINALS_DIR, attachment.filename)
      );
      assert.deepEqual(await response.body(), original);
    }
  }
  await page.goto(sessionUrl.href);
  for (const stage of ["opened", "reloaded", "reloaded-again"]) {
    if (stage !== "opened") {
      await page.reload();
    }
    await assertChatVisible(page, documents, reply);
    await page.screenshot({
      fullPage: true,
      path: path.join(outputDirectory, `${stage}.png`),
    });
  }
  assert.deepEqual(pageErrors, []);
  await writeFile(
    path.join(outputDirectory, "report.json"),
    JSON.stringify(
      {
        documentCount: documents.length,
        originalBytesVerified: Boolean(process.env.ATLAS_UI_QA_ORIGINALS_DIR),
        pageErrors,
        reloadedTwice: true,
        stableAttachmentIds: attachments.map(
          (attachment) => attachment.attachmentId
        ),
      },
      null,
      2
    )
  );
  console.log(
    `Document reopen regression passed. Evidence: ${outputDirectory}`
  );
} finally {
  await browser.close();
}
