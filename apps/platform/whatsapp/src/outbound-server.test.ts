import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { writePrivateTextFile } from "@atlas/core/fs";
import {
  getWhatsAppConfigDir,
  getWhatsAppConfigPath,
} from "@atlas/core/whatsapp-config";
import { startWhatsAppOutboundServer } from "./outbound-server";

describe("WhatsApp outbound server destination send", () => {
  let tempHome = "";
  let homedirSpy: ReturnType<typeof spyOn<typeof os, "homedir">> | null = null;
  let stop: (() => void) | undefined;

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
      getSendHandle: () => ({
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
      headers: { "Content-Type": "application/json" },
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
      getSendHandle: () => ({
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
      headers: { "Content-Type": "application/json" },
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
      getSendHandle: () => ({
        sendMessage: async () => undefined,
      }),
      orgId: "org_alpha",
    });
    stop = first.stop;
    const second = await startWhatsAppOutboundServer({
      getSendHandle: () => ({
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
});
