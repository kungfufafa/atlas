import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { writePrivateTextFile } from "../fs";
import {
  getWhatsAppConfigDir,
  getWhatsAppConfigPath,
} from "../whatsapp-config";
import { createWhatsAppOutboundAdapter } from "./whatsapp-outbound";

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
        "profile_id=default\nphone_number=+628111\npaired_jid=111@s.whatsapp.net\noutbound_port=5551\n",
        { ensureDir: getWhatsAppConfigDir("workspace-a") }
      );
      await writePrivateTextFile(
        getWhatsAppConfigPath("workspace-b"),
        "profile_id=default\nphone_number=+628222\npaired_jid=222@s.whatsapp.net\noutbound_port=5552\n",
        { ensureDir: getWhatsAppConfigDir("workspace-b") }
      );

      const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
      const adapter = createWhatsAppOutboundAdapter({
        fetchImpl: async (input, init) => {
          calls.push({
            body: JSON.parse(String(init?.body)),
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
      expect(calls[0]?.body).toEqual({ text: "hello from A" });

      const resB = await adapter.send({
        orgId: "workspace-b",
        text: "hello from B",
      });
      expect(resB.ok).toBe(true);
      expect(calls[1]?.url).toBe("http://127.0.0.1:5552/send");
      expect(calls[1]?.body).toEqual({ text: "hello from B" });

      const resUnconfigured = await adapter.send({
        orgId: "workspace-c",
        text: "hello from C",
      });
      expect(resUnconfigured.ok).toBe(false);
      expect(resUnconfigured.error).toBe("WhatsApp is not paired.");
    });
  });
});
