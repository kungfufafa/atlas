import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { WHATSAPP_OUTBOUND_TOKEN_HEADER } from "@atlas/core";
import { writePrivateTextFile } from "@atlas/core/fs";
import {
  ensureWhatsAppOutboundToken,
  getWhatsAppConfigDir,
  getWhatsAppConfigPath,
} from "@atlas/core/whatsapp-config";
import { startWhatsAppOutboundServer } from "./outbound-server";

const AUTH_TOKEN = `atlas_wa_${"a".repeat(43)}`;

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function writePairedWorkspaceConfig(orgId: string): Promise<void> {
  await writePrivateTextFile(
    getWhatsAppConfigPath(orgId),
    [
      "profile_id=default",
      "phone_number=6281111111111",
      "paired_jid=6281111111111@s.whatsapp.net",
      "access_mode=pairing",
      "outbound_port=0",
      "",
    ].join("\n"),
    { ensureDir: getWhatsAppConfigDir(orgId) }
  );
}

describe("WhatsApp outbound server destination send", () => {
  let tempHome = "";
  let homedirSpy: ReturnType<typeof spyOn<typeof os, "homedir">> | null = null;
  let stop: (() => void) | undefined;

  async function authorizedHeaders(orgId: string): Promise<HeadersInit> {
    const token = await ensureWhatsAppOutboundToken(orgId);
    return {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      "Content-Type": "application/json",
      [WHATSAPP_OUTBOUND_TOKEN_HEADER]: token ?? "",
    };
  }

  afterEach(async () => {
    stop?.();
    stop = undefined;
    homedirSpy?.mockRestore();
    homedirSpy = null;
    if (tempHome) {
      await rm(tempHome, { force: true, recursive: true });
      tempHome = "";
    }
  });

  test("sends from the paired workspace number to the requested phone", async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "atlas-wa-outbound-srv-"));
    homedirSpy = spyOn(os, "homedir").mockReturnValue(tempHome);
    await writePrivateTextFile(
      getWhatsAppConfigPath("org_finance"),
      [
        "profile_id=default",
        "phone_number=6281111111111",
        "paired_jid=6281111111111@s.whatsapp.net",
        "access_mode=pairing",
        "outbound_port=0",
        "",
      ].join("\n"),
      { ensureDir: getWhatsAppConfigDir("org_finance") }
    );

    const sent: Array<{ jid: string; text: string }> = [];
    const server = await startWhatsAppOutboundServer({
      authorizationToken: AUTH_TOKEN,
      getSendHandle: () => ({
        invalidate: () => true,
        sendMessage: async (jid, content) => {
          sent.push({ jid, text: content.text });
        },
      }),
      orgId: "org_finance",
    });
    stop = server.stop;

    const response = await fetch(`http://127.0.0.1:${server.port}/send`, {
      body: JSON.stringify({
        text: "Meeting jam 3",
        to: "6289500000001",
      }),
      headers: await authorizedHeaders("org_finance"),
      method: "POST",
    });
    const body = (await response.json()) as {
      jid?: string;
      ok?: boolean;
      sender?: string;
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.jid).toBe("6289500000001@s.whatsapp.net");
    expect(body.sender).toBe("6281111111111@s.whatsapp.net");
    expect(sent).toEqual([
      { jid: "6289500000001@s.whatsapp.net", text: "Meeting jam 3" },
    ]);
  });

  test("rejects destinations outside an allowlist", async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "atlas-wa-outbound-srv-"));
    homedirSpy = spyOn(os, "homedir").mockReturnValue(tempHome);
    await writePrivateTextFile(
      getWhatsAppConfigPath("org_finance"),
      [
        "profile_id=default",
        "phone_number=6281111111111",
        "paired_jid=6281111111111@s.whatsapp.net",
        "access_mode=allowlist",
        "allowed_numbers=6282222222222",
        "outbound_port=43113",
        "",
      ].join("\n"),
      { ensureDir: getWhatsAppConfigDir("org_finance") }
    );

    const sent: Array<{ jid: string; text: string }> = [];
    const server = await startWhatsAppOutboundServer({
      authorizationToken: AUTH_TOKEN,
      getSendHandle: () => ({
        invalidate: () => true,
        sendMessage: async (jid, content) => {
          sent.push({ jid, text: content.text });
        },
      }),
      orgId: "org_finance",
    });
    stop = server.stop;

    const response = await fetch(`http://127.0.0.1:${server.port}/send`, {
      body: JSON.stringify({
        text: "should not send",
        to: "6289500000001",
      }),
      headers: await authorizedHeaders("org_finance"),
      method: "POST",
    });
    const body = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toContain("allowlist");
    expect(sent).toEqual([]);
  });

  test("binds distinct ephemeral ports so two workspaces can listen at once", async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "atlas-wa-outbound-srv-"));
    homedirSpy = spyOn(os, "homedir").mockReturnValue(tempHome);

    for (const orgId of ["org_alpha", "org_beta"]) {
      await writePrivateTextFile(
        getWhatsAppConfigPath(orgId),
        [
          "profile_id=default",
          "phone_number=6281111111111",
          "paired_jid=6281111111111@s.whatsapp.net",
          "access_mode=pairing",
          "outbound_port=0",
          "",
        ].join("\n"),
        { ensureDir: getWhatsAppConfigDir(orgId) }
      );
    }

    const first = await startWhatsAppOutboundServer({
      authorizationToken: AUTH_TOKEN,
      getSendHandle: () => ({
        invalidate: () => true,
        sendMessage: async () => undefined,
      }),
      orgId: "org_alpha",
    });
    stop = first.stop;
    const second = await startWhatsAppOutboundServer({
      authorizationToken: AUTH_TOKEN,
      getSendHandle: () => ({
        invalidate: () => true,
        sendMessage: async () => undefined,
      }),
      orgId: "org_beta",
    });
    stop = () => {
      first.stop();
      second.stop();
    };

    expect(first.port).toBeGreaterThan(0);
    expect(second.port).toBeGreaterThan(0);
    expect(first.port).not.toBe(second.port);
  });

  test("fails closed when either outbound authorization layer is missing or wrong", async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "atlas-wa-outbound-srv-"));
    homedirSpy = spyOn(os, "homedir").mockReturnValue(tempHome);
    await writePrivateTextFile(
      getWhatsAppConfigPath("org_finance"),
      [
        "profile_id=default",
        "phone_number=6281111111111",
        "paired_jid=6281111111111@s.whatsapp.net",
        "access_mode=pairing",
        "outbound_port=0",
        "",
      ].join("\n"),
      { ensureDir: getWhatsAppConfigDir("org_finance") }
    );

    const sent: string[] = [];
    const server = await startWhatsAppOutboundServer({
      authorizationToken: AUTH_TOKEN,
      getSendHandle: () => ({
        invalidate: () => true,
        sendMessage: async (_jid, content) => {
          sent.push(content.text);
        },
      }),
      orgId: "org_finance",
    });
    stop = server.stop;
    const payload = JSON.stringify({ text: "must not send" });

    const missing = await fetch(`http://127.0.0.1:${server.port}/send`, {
      body: payload,
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const wrong = await fetch(`http://127.0.0.1:${server.port}/send`, {
      body: payload,
      headers: {
        Authorization: "Bearer wrong-token",
        "Content-Type": "application/json",
        [WHATSAPP_OUTBOUND_TOKEN_HEADER]:
          (await ensureWhatsAppOutboundToken("org_finance")) ?? "",
      },
      method: "POST",
    });
    const missingWorkspaceToken = await fetch(
      `http://127.0.0.1:${server.port}/send`,
      {
        body: payload,
        headers: {
          Authorization: `Bearer ${AUTH_TOKEN}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      }
    );

    expect(missing.status).toBe(401);
    expect(missing.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(wrong.status).toBe(401);
    expect(missingWorkspaceToken.status).toBe(401);
    expect(sent).toEqual([]);
  });

  test("rejects oversized bodies, text, and chunk counts before sending", async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "atlas-wa-outbound-srv-"));
    homedirSpy = spyOn(os, "homedir").mockReturnValue(tempHome);
    await writePrivateTextFile(
      getWhatsAppConfigPath("org_finance"),
      [
        "profile_id=default",
        "phone_number=6281111111111",
        "paired_jid=6281111111111@s.whatsapp.net",
        "access_mode=pairing",
        "outbound_port=0",
        "",
      ].join("\n"),
      { ensureDir: getWhatsAppConfigDir("org_finance") }
    );

    const sent: string[] = [];
    const server = await startWhatsAppOutboundServer({
      authorizationToken: AUTH_TOKEN,
      getSendHandle: () => ({
        invalidate: () => true,
        sendMessage: async (_jid, content) => {
          sent.push(content.text);
        },
      }),
      maxBodyBytes: 1024,
      maxChunks: 1,
      maxTextChars: 500,
      orgId: "org_finance",
    });
    stop = server.stop;

    const send = async (text: string) =>
      fetch(`http://127.0.0.1:${server.port}/send`, {
        body: JSON.stringify({ text }),
        headers: await authorizedHeaders("org_finance"),
        method: "POST",
      });

    const oversizedBody = await send("x".repeat(1500));
    const oversizedText = await send("x".repeat(501));
    const tooManyChunks = await send("x".repeat(401));

    expect(oversizedBody.status).toBe(413);
    await expect(oversizedBody.json()).resolves.toEqual({
      error: "Request body is too large.",
    });
    expect(oversizedText.status).toBe(413);
    await expect(oversizedText.json()).resolves.toEqual({
      error: "WhatsApp message text is too long.",
    });
    expect(tooManyChunks.status).toBe(413);
    await expect(tooManyChunks.json()).resolves.toEqual({
      error: "WhatsApp message has too many chunks.",
    });
    expect(sent).toEqual([]);
  });

  test("times out a stalled send without retrying or repeating completed chunks", async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "atlas-wa-outbound-srv-"));
    homedirSpy = spyOn(os, "homedir").mockReturnValue(tempHome);
    await writePairedWorkspaceConfig("org_finance");

    const sent: string[] = [];
    const stalled = createDeferred();
    const server = await startWhatsAppOutboundServer({
      authorizationToken: AUTH_TOKEN,
      getSendHandle: () => ({
        invalidate: () => false,
        sendMessage: async (_jid, content) => {
          sent.push(content.text);
          if (sent.length === 2) {
            await stalled.promise;
          }
        },
      }),
      maxConcurrentSends: 1,
      maxQueuedSends: 0,
      orgId: "org_finance",
      sendTimeoutMs: 20,
    });
    stop = server.stop;

    const response = await fetch(`http://127.0.0.1:${server.port}/send`, {
      body: JSON.stringify({ text: "x".repeat(401) }),
      headers: await authorizedHeaders("org_finance"),
      method: "POST",
    });
    const body = (await response.json()) as {
      error?: string;
      sentChunks?: number;
      totalChunks?: number;
    };

    expect(response.status).toBe(504);
    expect(body.error).toContain("delivery status is unknown");
    expect(body.sentChunks).toBe(1);
    expect(body.totalChunks).toBe(2);
    const whileOutcomeUnknown = await fetch(
      `http://127.0.0.1:${server.port}/send`,
      {
        body: JSON.stringify({ text: "must stay bounded" }),
        headers: await authorizedHeaders("org_finance"),
        method: "POST",
      }
    );
    expect(whileOutcomeUnknown.status).toBe(503);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(sent.map((chunk) => chunk.length)).toEqual([400, 1]);
    stalled.resolve();
    const afterLateSettlement = await fetch(
      `http://127.0.0.1:${server.port}/send`,
      {
        body: JSON.stringify({ text: "capacity recovered" }),
        headers: await authorizedHeaders("org_finance"),
        method: "POST",
      }
    );
    expect(afterLateSettlement.status).toBe(200);
    expect(sent).toHaveLength(3);
  });

  test("recovers capacity after four permanent sends invalidate their socket generation", async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "atlas-wa-outbound-srv-"));
    homedirSpy = spyOn(os, "homedir").mockReturnValue(tempHome);
    await writePairedWorkspaceConfig("org_finance");

    let generation = 0;
    let invalidations = 0;
    let permanentSendCalls = 0;
    const delivered: string[] = [];
    const staleHandle = {
      invalidate: () => {
        generation = 1;
        invalidations += 1;
        return true;
      },
      sendMessage: async () => {
        permanentSendCalls += 1;
        await new Promise<void>(() => undefined);
      },
    };
    const server = await startWhatsAppOutboundServer({
      authorizationToken: AUTH_TOKEN,
      getSendHandle: () =>
        generation === 0
          ? staleHandle
          : {
              invalidate: () => true,
              sendMessage: async (_jid, content) => {
                delivered.push(content.text);
              },
            },
      maxConcurrentSends: 4,
      maxQueuedSends: 0,
      orgId: "org_finance",
      sendTimeoutMs: 100,
    });
    stop = server.stop;

    const stalledResponses = await Promise.all(
      Array.from({ length: 4 }, async (_, index) =>
        fetch(`http://127.0.0.1:${server.port}/send`, {
          body: JSON.stringify({ text: `stalled-${index}` }),
          headers: await authorizedHeaders("org_finance"),
          method: "POST",
        })
      )
    );
    const recovered = await fetch(`http://127.0.0.1:${server.port}/send`, {
      body: JSON.stringify({ text: "capacity recovered" }),
      headers: await authorizedHeaders("org_finance"),
      method: "POST",
    });

    expect(stalledResponses.map((response) => response.status)).toEqual([
      504, 504, 504, 504,
    ]);
    expect(permanentSendCalls).toBe(4);
    expect(invalidations).toBe(4);
    expect(recovered.status).toBe(200);
    expect(delivered).toEqual(["capacity recovered"]);
  });

  test("fails fast when all send slots are saturated and queuing is disabled", async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "atlas-wa-outbound-srv-"));
    homedirSpy = spyOn(os, "homedir").mockReturnValue(tempHome);
    await writePairedWorkspaceConfig("org_finance");

    const started = createDeferred();
    const release = createDeferred();
    let sendCalls = 0;
    const server = await startWhatsAppOutboundServer({
      authorizationToken: AUTH_TOKEN,
      getSendHandle: () => ({
        invalidate: () => false,
        sendMessage: async () => {
          sendCalls += 1;
          started.resolve();
          await release.promise;
        },
      }),
      maxConcurrentSends: 1,
      maxQueuedSends: 0,
      orgId: "org_finance",
      sendTimeoutMs: 1000,
    });
    stop = server.stop;

    const firstResponse = fetch(`http://127.0.0.1:${server.port}/send`, {
      body: JSON.stringify({ text: "first" }),
      headers: await authorizedHeaders("org_finance"),
      method: "POST",
    });
    await started.promise;
    const saturated = await fetch(`http://127.0.0.1:${server.port}/send`, {
      body: JSON.stringify({ text: "second" }),
      headers: await authorizedHeaders("org_finance"),
      method: "POST",
    });
    release.resolve();

    expect(saturated.status).toBe(503);
    expect(saturated.headers.get("Retry-After")).toBe("1");
    await expect(saturated.json()).resolves.toEqual({
      error: "WhatsApp outbound queue is full.",
    });
    expect((await firstResponse).status).toBe(200);
    expect(sendCalls).toBe(1);
  });

  test("times out a bounded queued send before invoking the socket", async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "atlas-wa-outbound-srv-"));
    homedirSpy = spyOn(os, "homedir").mockReturnValue(tempHome);
    await writePairedWorkspaceConfig("org_finance");

    const started = createDeferred();
    const release = createDeferred();
    let sendCalls = 0;
    const server = await startWhatsAppOutboundServer({
      authorizationToken: AUTH_TOKEN,
      getSendHandle: () => ({
        invalidate: () => false,
        sendMessage: async () => {
          sendCalls += 1;
          started.resolve();
          await release.promise;
        },
      }),
      maxConcurrentSends: 1,
      maxQueuedSends: 1,
      orgId: "org_finance",
      queueTimeoutMs: 20,
      sendTimeoutMs: 1000,
    });
    stop = server.stop;

    const firstResponse = fetch(`http://127.0.0.1:${server.port}/send`, {
      body: JSON.stringify({ text: "first" }),
      headers: await authorizedHeaders("org_finance"),
      method: "POST",
    });
    await started.promise;
    const queued = await fetch(`http://127.0.0.1:${server.port}/send`, {
      body: JSON.stringify({ text: "queued" }),
      headers: await authorizedHeaders("org_finance"),
      method: "POST",
    });
    release.resolve();

    expect(queued.status).toBe(503);
    expect(queued.headers.get("Retry-After")).toBe("1");
    await expect(queued.json()).resolves.toEqual({
      error: "WhatsApp outbound queue wait timed out.",
    });
    expect((await firstResponse).status).toBe(200);
    expect(sendCalls).toBe(1);
  });
});
