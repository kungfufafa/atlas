import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SaveInboundDocument } from "@atlas/core/attachments/inbound-document";
import { saveInboundWorkspaceDocument } from "@atlas/core/inbound-document";
import { MAX_DOCUMENT_BYTES } from "@atlas/core/message-content";
import { withIsolatedAtlasHome } from "@atlas/core/testing/atlas-home";
import type { Context } from "grammy";
import { buildDiscordAttachmentInput } from "../../discord/src/attachments";
import { sendDiscordArtifactAttachment } from "../../discord/src/send-artifact-attachment";
import { buildWhatsAppMediaInput } from "../../whatsapp/src/attachments";
import { sendWhatsAppArtifact } from "../../whatsapp/src/send-artifact-media";
import { buildTelegramDocumentInput } from "./attachments";
import { sendTelegramArtifact } from "./send-artifact-document";

type WAMessage = Parameters<typeof buildWhatsAppMediaInput>[0];
type WASocket = Parameters<typeof sendWhatsAppArtifact>[0];
type Message = Parameters<typeof buildDiscordAttachmentInput>[0];
type TextBasedChannel = Parameters<typeof sendDiscordArtifactAttachment>[0];

const formats = [
  ["pdf", "application/pdf"],
  [
    "docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  [
    "pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
  ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ["csv", "text/csv"],
  ["tsv", "text/tab-separated-values"],
  ["json", "application/json"],
  ["jsonl", "application/x-ndjson"],
] as const;
const caption = "Inspect this source and return the requested revision.";

describe("channel document source and returned file continuity", () => {
  let fetchSpy: ReturnType<typeof spyOn> | undefined;
  afterEach(() => fetchSpy?.mockRestore());

  for (const channel of ["Telegram", "Discord", "WhatsApp"] as const) {
    test(`${channel} preserves original bytes and filename for every daily document format`, async () => {
      await withIsolatedAtlasHome(
        "atlas-channel-document-",
        async (homeDir) => {
          const bytes = Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 32);
          bytes.write("original source");
          fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
            Object.assign(async () => new Response(bytes), { preconnect() {} })
          );
          for (const [extension, mediaType] of formats) {
            const filename = `source ${channel}.${extension}`;
            const savedPaths: string[] = [];
            const saveInboundDocument: SaveInboundDocument = async (input) => {
              expect(input.filename).toBe(filename);
              expect(input.mediaType).toBe(mediaType);
              const saved = await saveInboundWorkspaceDocument({
                ...input,
                orgId: "org-documents",
                profileId: "profile-documents",
              });
              savedPaths.push(saved.relativePath);
              return saved;
            };
            const result = await buildChannelDocument(channel, {
              bytes,
              filename,
              mediaType,
              saveInboundDocument,
            });
            expect(result?.kind).toBe("input");
            if (result?.kind !== "input") {
              throw new Error("Document was rejected");
            }
            expect(result.input.documents).toBeUndefined();
            expect(result.input.message).toContain(caption);
            expect(result.input.message).toContain(filename);
            expect(savedPaths).toHaveLength(1);
            expect(result.input.message).toContain(savedPaths[0]!);
            const sourcePath = path.join(
              homeDir,
              ".atlas/orgs/org-documents/profiles/profile-documents",
              savedPaths[0]!
            );
            expect(await readFile(sourcePath)).toEqual(bytes);

            const output = {
              bytes: Buffer.from(bytes),
              filename: `result.${extension}`,
              mimeType: mediaType,
            };
            const sent: unknown[][] = [];
            const send = async (...args: unknown[]) => {
              sent.push(args);
              return { message_id: 123 };
            };
            const delivered =
              channel === "Telegram"
                ? await sendTelegramArtifact(
                    {
                      api: { sendDocument: send },
                      chat: { id: 42 },
                    } as unknown as Context,
                    output
                  )
                : channel === "Discord"
                  ? await sendDiscordArtifactAttachment(
                      { send } as unknown as TextBasedChannel,
                      output
                    )
                  : await sendWhatsAppArtifact(
                      { sendMessage: send } as unknown as WASocket,
                      "paired-user",
                      output
                    );
            expect(delivered.ok).toBe(true);
            expect(sent).toHaveLength(1);
            if (channel === "Telegram") {
              const file = sent[0]![1] as {
                filename: string;
                fileData: Uint8Array;
              };
              expect(file.filename).toBe(output.filename);
              expect(Buffer.from(file.fileData)).toEqual(output.bytes);
            } else if (channel === "Discord") {
              const file = (
                sent[0]![0] as {
                  files: Array<{ name: string; attachment: Buffer }>;
                }
              ).files[0]!;
              expect(file.name).toBe(output.filename);
              expect(file.attachment).toEqual(output.bytes);
            } else {
              expect(sent[0]![1]).toEqual({
                document: output.bytes,
                fileName: output.filename,
                mimetype: mediaType,
              });
            }
            expect(await readFile(sourcePath)).toEqual(bytes);
          }
        }
      );
    });
  }
});

function buildChannelDocument(
  channel: "Telegram" | "Discord" | "WhatsApp",
  input: {
    bytes: Buffer;
    filename: string;
    mediaType: string;
    saveInboundDocument: SaveInboundDocument;
  }
) {
  const { bytes, filename, mediaType, saveInboundDocument } = input;
  if (channel === "Telegram") {
    return buildTelegramDocumentInput(
      {
        api: {
          getFile: async () => ({
            file_path: "document",
            file_size: bytes.length,
          }),
          token: "test-token",
        },
        message: {
          caption,
          document: {
            file_id: "document",
            file_name: filename,
            file_size: bytes.length,
            mime_type: mediaType,
          },
        },
      } as unknown as Context,
      { saveInboundDocument }
    );
  }
  if (channel === "Discord") {
    return buildDiscordAttachmentInput(
      {
        attachments: new Map([
          [
            "document",
            {
              contentType: mediaType,
              name: filename,
              size: bytes.length,
              url: "https://invalid.example/document",
            },
          ],
        ]),
        content: caption,
      } as unknown as Message,
      { saveInboundDocument }
    );
  }
  return buildWhatsAppMediaInput(
    {
      key: { id: "document" },
      message: {
        documentMessage: {
          caption,
          fileLength: bytes.length,
          fileName: filename,
          mimetype: mediaType,
        },
      },
    } as WAMessage,
    async () => bytes,
    { saveInboundDocument }
  );
}
