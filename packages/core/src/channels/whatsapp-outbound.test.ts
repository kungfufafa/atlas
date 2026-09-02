import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { writePrivateTextFile } from "../fs";
import {
  getWhatsAppConfigDir,
  getWhatsAppConfigPath,
} from "../whatsapp-config";
import {
  formatWhatsAppOutboundAuthorization,
  loadOrCreateWhatsAppOutboundAuthToken,
} from "../whatsapp-outbound-auth";
import {
  createWhatsAppOutboundAdapter,
  resolveWhatsAppOutboundListenPort,
  resolveWhatsAppOutboundPort,
  WHATSAPP_OUTBOUND_TOKEN_HEADER,
} from "./whatsapp-outbound";

describe("WhatsApp outbound port resolution", () => {
  test("listens on an ephemeral port when unset or zero, and keeps 4312 as the client fallback", () => {
    expect(resolveWhatsAppOutboundListenPort(null)).toBe(0);
    expect(resolveWhatsAppOutboundListenPort({ outboundPort: "0" })).toBe(0);
    expect(resolveWhatsAppOutboundListenPort({ outboundPort: "-1" })).toBe(0);
    expect(resolveWhatsAppOutboundListenPort({ outboundPort: "5551" })).toBe(
      5551
    );
    expect(resolveWhatsAppOutboundPort(null)).toBe(4312);
    expect(resolveWhatsAppOutboundPort({ outboundPort: "0" })).toBe(4312);
    expect(resolveWhatsAppOutboundPort({ outboundPort: "5551" })).toBe(5551);
  });
});

describe("createWhatsAppOutboundAdapter multi-workspace isolation", () => {
  let tempHome = "";
  let homedirSpy: ReturnType<typeof spyOn<typeof os, "homedir">> | null = null;

  afterEach(async () => {
    homedirSpy?.mockRestore();
    homedirSpy = null;

    if (tempHome) {
      await rm(tempHome, { force: true, recursive: true });
      tempHome = "";
    }
  });

  async function useTempHome(run: () => Promise<void>): Promise<void> {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "atlas-wa-outbound-"));
    homedirSpy = spyOn(os, "homedir").mockReturnValue(tempHome);
    await run();
  }

  test("routes outbound requests to the workspace-specific port and fails when unconfigured", async () => {
    await useTempHome(async () => {
      await writePrivateTextFile(
        getWhatsAppConfigPath("workspace-a"),
        [
          "profile_id=default",
          "phone_number=6281111111111",
          "paired_jid=6281111111111@s.whatsapp.net",
          "access_mode=allowlist",
          "allowed_numbers=6289500000001",
          "outbound_port=5551",
          "outbound_token=alpha-secret",
          "",
        ].join("\n"),
        { ensureDir: getWhatsAppConfigDir("workspace-a") }
      );
      await writePrivateTextFile(
        getWhatsAppConfigPath("workspace-b"),
        "profile_id=default\nphone_number=+628222\npaired_jid=222@s.whatsapp.net\noutbound_port=5552\noutbound_token=beta-secret\n",
        { ensureDir: getWhatsAppConfigDir("workspace-b") }
      );

      const calls: Array<{
        authorization: string | null;
        body: Record<string, unknown>;
        headers: Headers;
        signal: AbortSignal | null;
        url: string;
      }> = [];
      const adapter = createWhatsAppOutboundAdapter({
        fetchImpl: async (input, init) => {
          const headers = new Headers(init?.headers);
          calls.push({
            authorization: headers.get("Authorization"),
            body: JSON.parse(String(init?.body)),
            headers: new Headers(init?.headers),
            signal: init?.signal ?? null,
            url: String(input),
          });
          return new Response("ok", { status: 200 });
        },
      });

      const resA = await adapter.send({
        orgId: "workspace-a",
        text: "hello from A",
      });
      expect(resA.ok).toBe(true);
      expect(calls[0]?.url).toBe("http://127.0.0.1:5551/send");
      expect(calls[0]?.body).toEqual({
        text: "hello from A",
        to: "6281111111111@s.whatsapp.net",
      });
      expect(calls[0]?.headers.get(WHATSAPP_OUTBOUND_TOKEN_HEADER)).toBe(
        "alpha-secret"
      );
      expect(calls[0]?.authorization).toBe(
        formatWhatsAppOutboundAuthorization(
          await loadOrCreateWhatsAppOutboundAuthToken("workspace-a")
        )
      );
      expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);

      const resToNumber = await adapter.send({
        orgId: "workspace-a",
        text: "ping Apri",
        to: "6281111111111",
      });
      expect(resToNumber.ok).toBe(true);
      expect(calls[1]?.body).toEqual({
        text: "ping Apri",
        to: "6281111111111@s.whatsapp.net",
      });

      const resAllowlisted = await adapter.send({
        orgId: "workspace-a",
        text: "ping allowlisted",
        to: "6289500000001",
      });
      expect(resAllowlisted.ok).toBe(true);
      expect(calls[2]?.body).toEqual({
        text: "ping allowlisted",
        to: "6289500000001@s.whatsapp.net",
      });

      const resForeign = await adapter.send({
        orgId: "workspace-a",
        text: "ping stranger",
        to: "6289600000001",
      });
      expect(resForeign.ok).toBe(false);
      expect(resForeign.error).toContain("allowlist");

      const resB = await adapter.send({
        orgId: "workspace-b",
        text: "hello from B",
      });
      expect(resB.ok).toBe(true);
      expect(calls[3]?.url).toBe("http://127.0.0.1:5552/send");
      expect(calls[3]?.body).toEqual({
        text: "hello from B",
        to: "222@s.whatsapp.net",
      });
      expect(calls[3]?.headers.get(WHATSAPP_OUTBOUND_TOKEN_HEADER)).toBe(
        "beta-secret"
      );
      expect(calls[3]?.authorization).toBe(
        formatWhatsAppOutboundAuthorization(
          await loadOrCreateWhatsAppOutboundAuthToken("workspace-b")
        )
      );

      const resUnconfigured = await adapter.send({
        orgId: "workspace-c",
        text: "hello from C",
      });
      expect(resUnconfigured.ok).toBe(false);
      expect(resUnconfigured.error).toBe("WhatsApp is not paired.");
    });
  });

  test("aborts a stalled worker request after the configured timeout", async () => {
    await useTempHome(async () => {
      await writePrivateTextFile(
        getWhatsAppConfigPath("workspace-a"),
        "profile_id=default\nphone_number=+628111\npaired_jid=111@s.whatsapp.net\noutbound_port=5551\n",
        { ensureDir: getWhatsAppConfigDir("workspace-a") }
      );

      let capturedSignal: AbortSignal | null = null;
      const adapter = createWhatsAppOutboundAdapter({
        fetchImpl: (_input, init) => {
          capturedSignal = init?.signal ?? null;
          return new Promise((_resolve, reject) => {
            capturedSignal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true }
            );
          });
        },
        timeoutMs: 5,
      });

      const result = await adapter.send({
        orgId: "workspace-a",
        text: "hello",
      });

      expect(capturedSignal?.aborted).toBe(true);
      expect(result).toEqual({
        error: "WhatsApp worker request timed out after 5ms.",
        ok: false,
      });
    });
  });
});
