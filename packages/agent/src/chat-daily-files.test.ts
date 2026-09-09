import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type {
  ChatCompletionResult,
  GenerateChatInput,
  ProviderClient,
  ToolCall,
} from "@atlas/core";
import { extractTurnDeliverableArtifacts } from "../../core/src/channel-artifacts";
import { createTextPdf, loadPdf } from "../../core/src/files/pdf";
import { fileAssetTool } from "../../core/src/tools/file-asset";
import { pdfDocumentTool } from "../../core/src/tools/pdf-document";
import { createAgentHarness } from "./index";

function nextCall(step: number, previous: string): ToolCall | undefined {
  if (step === 0) {
    return {
      arguments: { documentRef: "att_original", operation: "materialize" },
      id: "materialize",
      name: "file_asset",
    };
  }
  const value = JSON.parse(previous) as {
    path: string;
    artifacts: { path: string }[];
  };
  if (step === 1) {
    return {
      arguments: {
        documentRef: value.path,
        groups: [[2]],
        operation: "split",
        outputFilename: "selected.pdf",
      },
      id: "split",
      name: "pdf_document",
    };
  }
  if (step === 2) {
    return {
      arguments: {
        documentRef: value.artifacts[0]!.path,
        operation: "extract",
      },
      id: "verify",
      name: "pdf_document",
    };
  }
}

test.each(["api", "sdk"] as const)(
  "%s tool loop uses original attachment bytes and emits a verified channel deliverable",
  async (mode) => {
    const root = await mkdtemp("/tmp/atlas-daily-harness-");
    try {
      const original = await createTextPdf(
        { pages: ["First source page", "Selected source page"] },
        { workspaceRoot: root }
      );
      const source = Buffer.from(original.bytes);
      let checkpoints = 0;
      const generate = async (
        input: GenerateChatInput
      ): Promise<ChatCompletionResult> => {
        if (mode === "sdk") {
          let previous = "";
          for (let step = 0; step < 3; step++) {
            const call = nextCall(step, previous)!;
            const result = await input.executeToolCall!(call);
            expect(result.success).toBe(true);
            expect(checkpoints).toBe(step + 1);
            previous = result.content;
          }
          expect(JSON.parse(previous).pages[0].text).toContain(
            "Selected source page"
          );
        } else {
          const results = input.messages.filter(
            (message) => message.role === "tool"
          );
          const call = nextCall(results.length, results.at(-1)?.content ?? "");
          if (call) {
            return {
              assistantMessage: {
                content: "",
                role: "assistant",
                toolCalls: [call],
              },
              content: "",
              toolCalls: [call],
            };
          }
          expect(JSON.parse(results.at(-1)!.content).pages[0].text).toContain(
            "Selected source page"
          );
        }
        return {
          assistantMessage: {
            content: "Verified selected page.",
            role: "assistant",
          },
          content: "Verified selected page.",
          toolCalls: [],
        };
      };
      const provider: ProviderClient = {
        generateChat: generate,
        async generateText() {
          return { content: "unused" };
        },
        name: mode === "sdk" ? "chatgpt" : "openai",
        async streamChat(input, handlers) {
          const result = await generate(input);
          if (result.content) {
            handlers.onChunk(result.content);
          }
          return result;
        },
      };
      const session = createAgentHarness({
        provider,
        tools: [fileAssetTool, pdfDocumentTool],
      }).createChatSession({
        toolContext: {
          loadAttachment: async (id) =>
            id === "att_original"
              ? {
                  bytes: source,
                  filename: "original.pdf",
                  mediaType: "application/pdf",
                }
              : null,
          orgId: "org_fixture",
          profileId: "profile_fixture",
          sessionId: "session_fixture",
          workspaceRoot: root,
        },
      });
      await session.sendStream(
        "Extract page two from att_original and return its PDF.",
        { onChunk() {} },
        {
          onToolCheckpoint: async () => {
            checkpoints++;
          },
        }
      );
      const history = [...session.getHistory()];
      expect(history.filter((message) => message.role === "tool")).toHaveLength(
        3
      );
      const artifacts = extractTurnDeliverableArtifacts(history);
      expect(artifacts.map((artifact) => artifact.path)).toEqual([
        "selected-1.pdf",
      ]);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]!.mimeType).toBe("application/pdf");
      const delivered = await loadPdf(`artifacts/${artifacts[0]!.path}`, {
        workspaceRoot: root,
      });
      expect(delivered.document.getPageCount()).toBe(1);
      expect(await readFile(path.join(root, ".sources/original.pdf"))).toEqual(
        source
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }
);
