import { describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type RemoteChatSession } from "@atlas/client";
import type { ChatMessage } from "@atlas/core/contract";
import {
  deliverWhatsAppTurnArtifactShares,
  isExplicitWhatsAppShareIntent,
  isPureWhatsAppAttachIntent,
} from "./channel-artifact-flow";
import { SessionStore } from "./session-store";

describe("WhatsApp artifact intent", () => {
  test("short-circuits only pure attachment requests", () => {
    expect(isPureWhatsAppAttachIntent("/attach")).toBe(true);
    expect(isPureWhatsAppAttachIntent("send me the file")).toBe(true);
    expect(isPureWhatsAppAttachIntent("edit the file and send it")).toBe(false);
    expect(isPureWhatsAppAttachIntent("/attach after editing the report")).toBe(
      false
    );
  });

  test("recognizes explicit public share-link requests", () => {
    expect(isExplicitWhatsAppShareIntent("send me a public link")).toBe(true);
    expect(isExplicitWhatsAppShareIntent("send me the file")).toBe(false);
  });
});

test.each([false, true])(
  "delivers only the final workbook after chained spreadsheet edits (failed retry: %s)",
  async (failedRetry) => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-wa-final-workbook-"));
    try {
      const paths = [
        "artifacts/template-management-domain.xlsx",
        "artifacts/template-management-domain-v2.xlsx",
        "artifacts/template-management-domain-v2-v2.xlsx",
      ];
      const messages: ChatMessage[] = [
        { content: "Create and format a domain workbook", role: "user" },
      ];
      const steps = [
        {
          input: { action: "create", path: paths[0] },
          result: { path: paths[0], status: "created" },
        },
        {
          input: { action: "add_sheet", path: paths[0], sheetName: "Domains" },
          result: {
            path: paths[1],
            sourcePath: paths[0],
            status: "sheet_added",
          },
        },
        {
          input: { action: "format_range", range: "A1:D1" },
          result: { error: "Missing path", status: "error" },
        },
        {
          input: { action: "format_range", path: paths[1], range: "A1:D1" },
          result: {
            path: paths[2],
            sourcePath: paths[1],
            status: "formatted",
          },
        },
      ];
      for (const [index, step] of steps.entries()) {
        if (!failedRetry && "error" in step.result) {
          continue;
        }
        const id = `spreadsheet_${index}`;
        messages.push(
          {
            content: "",
            role: "assistant",
            toolCalls: [{ arguments: step.input, id, name: "spreadsheet" }],
          },
          {
            content: JSON.stringify(step.result),
            name: "spreadsheet",
            role: "tool",
            toolCallId: id,
          }
        );
      }
      const client = createClient({ baseUrl: "http://localhost:4310" });
      const bytes = new Uint8Array([80, 75, 3, 4]);
      const readArtifact = mock(async () => ({
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        data: bytes.buffer,
      }));
      const publishShare = mock(() => {
        throw new Error("Unexpected artifact share publication");
      });
      client.readProfileArtifactContent = readArtifact;
      client.publishProfileArtifactShare = publishShare;
      const socket = { sendMessage: mock(async () => {}) };
      const sendText = mock(async () => {});
      const beforeDelivery = mock(async () => {});
      const jid = "6281111111111@s.whatsapp.net";
      const store = new SessionStore(join(directory, "sessions.json"));
      store.set(jid, {
        profileId: "profile_test",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });

      await deliverWhatsAppTurnArtifactShares({
        beforeDelivery,
        client,
        conversationKey: jid,
        getSocket: () => socket as never,
        jid,
        profileId: "profile_test",
        sendText,
        session: {
          getMessages: async () => messages,
          id: "session_test",
        } as unknown as RemoteChatSession,
        sessionStore: store,
        streamedArtifacts: paths.map((path) => ({
          filename: path.slice("artifacts/".length),
          mimeType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          path: path.slice("artifacts/".length),
          savedAt: "2026-09-10T00:00:00.000Z",
          sizeBytes: bytes.byteLength,
        })),
      });

      expect(readArtifact).toHaveBeenCalledTimes(1);
      expect(readArtifact).toHaveBeenCalledWith(
        "profile_test",
        "template-management-domain-v2-v2.xlsx",
        { sessionId: "session_test" }
      );
      expect(socket.sendMessage).toHaveBeenCalledTimes(1);
      expect(socket.sendMessage).toHaveBeenCalledWith(jid, {
        document: Buffer.from(bytes),
        fileName: "template-management-domain-v2-v2.xlsx",
        mimetype:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      expect(
        store.getDeliverableArtifacts(jid).map((artifact) => artifact.path)
      ).toEqual(["template-management-domain-v2-v2.xlsx"]);
      expect(beforeDelivery).toHaveBeenCalled();
      expect(publishShare).not.toHaveBeenCalled();
      expect(sendText).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }
);
