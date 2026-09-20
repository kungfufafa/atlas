import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer, type Plugin } from "vite";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const qaRoute = "/__atlas_approval_qa";
const moduleId = "virtual:atlas-approval-qa";
const outputDir =
  process.env.ATLAS_APPROVAL_QA_OUTPUT_DIR ?? "/tmp/atlas-approval-qa";
const before = process.env.ATLAS_APPROVAL_QA_BEFORE === "1";
const fixture = String.raw`import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ActionApprovalDialog } from '/src/components/chat/ActionApprovalDialog.tsx';
import { ChatMessageList } from '/src/components/chat/chat-message-list.tsx';
import '/src/index.css';
const h = React.createElement;
const recipients = Array.from({length: 6}, (_, i) => '628950000000' + (i + 1));
function Fixture() {
  const [number, setNumber] = useState(0);
  const [mode, setMode] = useState('success');
  const [requests, setRequests] = useState(0);
  const [result, setResult] = useState('');
  const approval = { id: 'approval-' + number, tool: 'send_whatsapp', toolCallId: 'call-' + number,
    title: 'Send WhatsApp message', consequenceSummary: 'Review the message and recipients before sending.',
    status: 'pending', createdAt: new Date().toISOString(),
    details: { to: mode === 'batch' ? recipients : recipients[number % 6], text: 'Meeting jam 3.\nPlease confirm your attendance.' } };
  async function decide(item, decision) {
    setRequests(value => value + 1);
    await new Promise(resolve => setTimeout(resolve, 100));
    if (mode === 'failure') throw new Error('Connection interrupted. Try again.');
    if (mode === 'next') setNumber(value => value + 1);
    setResult(decision + ':' + item.id);
  }
  return h('main', { style: {maxWidth: 680, margin: '40px auto', padding: 16} },
    h('label', null, 'Scenario ', h('select', { 'aria-label': 'Scenario', value: mode,
      onChange: event => {setMode(event.target.value); setNumber(value => value + 1); setResult('');} },
      ...['success', 'next', 'failure', 'batch', 'conversation'].map(value => h('option', {key:value}, value)))),
    h('button', {onClick: () => setNumber(value => value + 1)}, 'Next approval'),
    mode === 'conversation'
      ? h('div', {style:{height:640, display:'flex', flexDirection:'column'}}, h(ChatMessageList, {
        sessionId:'qa-session', streamActive:true, showThinking:false,
        messages: [
          {id:'first-message', role:'assistant', content:'', approval:{...approval,id:'first-decision',toolCallId:'first-call',status:'approved'}},
          {id:'second-message', role:'assistant', content:'', approval:{...approval,id:'second-decision',toolCallId:'second-call'}},
        ]}))
      : h(ActionApprovalDialog, { approval, onConfirm: item => decide(item, 'approved'), onCancel: item => decide(item, 'denied') }),
    h('output', {'data-testid':'requests'}, String(requests)),
    h('output', {'data-testid':'result'}, result));
}
createRoot(document.getElementById('root')).render(h(Fixture));`;
const html = `<!doctype html><html><head><title>Atlas approval regression</title></head><body><div id="root"></div><script type="module" src="/@id/__x00__${moduleId}"></script></body></html>`;
const plugin: Plugin = {
  configResolved(config) {
    config.server.proxy = undefined;
  },
  configureServer(server) {
    server.middlewares.use(qaRoute, (_request, response, next) => {
      void server
        .transformIndexHtml(qaRoute, html)
        .then((result) => {
          response.setHeader("Content-Type", "text/html");
          response.end(result);
        })
        .catch(next);
    });
  },
  load(id) {
    return id === `\0${moduleId}` ? fixture : undefined;
  },
  name: "atlas-approval-qa",
  resolveId(id) {
    return id === moduleId ? `\0${moduleId}` : undefined;
  },
};
await mkdir(outputDir, { recursive: true });
const server = await createServer({
  configFile: join(webRoot, "vite.config.ts"),
  plugins: [plugin],
  root: webRoot,
  server: { host: "127.0.0.1", port: 3000, strictPort: true },
});
const browser = await chromium.launch({ headless: true });
try {
  await server.listen();
  const page = await browser.newPage({
    viewport: { height: 780, width: 1000 },
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:3000${qaRoute}`);
  const confirm = page.getByRole("button", { exact: true, name: "Confirm" });
  await confirm.waitFor();
  await page.screenshot({
    animations: "disabled",
    path: join(outputDir, before ? "before-initial.png" : "after-initial.png"),
  });
  await page.getByRole("combobox", { name: "Scenario" }).selectOption("next");
  await confirm.click();
  await page.getByTestId("result").filter({ hasText: "approved:" }).waitFor();
  if (before) {
    await page
      .getByRole("button", { exact: true, name: "Confirming..." })
      .waitFor();
    await page.screenshot({
      animations: "disabled",
      path: join(outputDir, "before-stuck.png"),
    });
  } else {
    for (let index = 0; index < 5; index += 1) {
      await confirm.click();
      await page.waitForFunction(
        (expected) =>
          document.querySelector('[data-testid="requests"]')?.textContent ===
          String(expected),
        index + 2
      );
    }
    await confirm.waitFor();
    await page.screenshot({
      animations: "disabled",
      path: join(outputDir, "after-consecutive.png"),
    });
    await page
      .getByRole("combobox", { name: "Scenario" })
      .selectOption("failure");
    await confirm.click();
    await page.getByRole("alert").waitFor();
    assert.equal(await confirm.isEnabled(), true);
    await confirm.click();
    await page.getByRole("alert").waitFor();
    await page.screenshot({
      animations: "disabled",
      path: join(outputDir, "after-retry.png"),
    });
    await page
      .getByRole("combobox", { name: "Scenario" })
      .selectOption("batch");
    await page.getByText("6289500000006", { exact: false }).waitFor();
    await page.screenshot({
      animations: "disabled",
      path: join(outputDir, "after-batch.png"),
    });
    await page.getByRole("button", { exact: true, name: "Cancel" }).click();
    await page.getByText("denied", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Next approval" }).click();
    await confirm.click();
    await page.getByText("approved", { exact: true }).waitFor();
    let decisions = 0;
    await page.route(
      "**/v1/sessions/qa-session/approvals/second-decision",
      async (route) => {
        decisions += 1;
        await route.fulfill({
          body: JSON.stringify(
            decisions === 1
              ? { error: "Approval service temporarily unavailable" }
              : { resumed: true, status: "approved" }
          ),
          contentType: "application/json",
          status: decisions === 1 ? 503 : 200,
        });
      }
    );
    await page
      .getByRole("combobox", { name: "Scenario" })
      .selectOption("conversation");
    await confirm.waitFor();
    assert.equal(
      await page
        .getByRole("heading", { name: "Send WhatsApp message" })
        .count(),
      2
    );
    await confirm.click();
    await page.getByRole("alert").waitFor();
    assert.equal(await confirm.isEnabled(), true);
    await confirm.click();
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll("span.capitalize")).filter(
          (element) => element.textContent === "approved"
        ).length === 2
    );
    assert.equal(decisions, 2);
    await page.screenshot({
      animations: "disabled",
      path: join(outputDir, "after-conversation.png"),
    });
    assert.deepEqual(errors, []);
  }
  console.info(
    `Approval ${before ? "baseline captured" : "regression passed"}: ${outputDir}`
  );
} finally {
  await browser.close();
  await server.close();
}
