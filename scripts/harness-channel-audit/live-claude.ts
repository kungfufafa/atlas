import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolCall, ToolDefinition } from "@atlas/core";
import { ClaudeSubscriptionRuntime } from "../../apps/server/src/providers/subscription/claude/runtime";
import {
  clearSubscriptionSession,
  readSubscriptionSession,
} from "../../apps/server/src/providers/subscription/session-store";
import {
  readFileTool,
  writeFileTool,
} from "../../packages/core/src/tools/builtin";
import { buildToolExecutionContext } from "../../packages/core/src/tools/context";
import { executeProtectedTool } from "../../packages/core/src/tools/execution";
import {
  getUserConfigDir,
  runWithUserConfigDir,
} from "../../packages/core/src/user-config";

// Explicit live gate. Uses only the Atlas-owned Claude OAuth session; never
// copies credentials or falls back to API keys, mocks, or another model.
const atlasConfigDir = getUserConfigDir();
process.env.ATLAS_CONFIG_DIR = atlasConfigDir;
process.env.CLAUDE_CONFIG_DIR = path.join(
  atlasConfigDir,
  "subscription-auth",
  "claude"
);
assert.ok(
  path.isAbsolute(process.env.CLAUDE_CONFIG_DIR),
  "CLAUDE_CONFIG_DIR must be an absolute path."
);
const runtime = new ClaudeSubscriptionRuntime({ turnTimeoutMs: 120_000 });
const auth = await runtime.getAuthState();
const requestedModel = process.env.ATLAS_LIVE_CLAUDE_MODEL?.trim();
const probeEvidence = {
  apiKeyFallback: false,
  authDirectory: process.env.CLAUDE_CONFIG_DIR,
  authStatus: auth.status,
  observedAt: new Date().toISOString(),
  provider: "claude",
  runtimeVersion: auth.runtimeVersion,
};
if (auth.authenticated) {
  const root = await mkdtemp(path.join(tmpdir(), "atlas-live-claude-"));
  const workspaceRoot = path.join(root, "profile");
  await mkdir(workspaceRoot);
  const token = `atlas-live-${crypto.randomUUID()}`;
  const calls: Array<{ call: ToolCall; data?: unknown; success: boolean }> = [];
  const tools: ToolDefinition[] = [writeFileTool, readFileTool];
  try {
    const evidence = await runWithUserConfigDir(
      path.join(root, "state"),
      async () => {
        const advertisedModels = await runtime.listModels({
          requireRuntimeMetadata: true,
        });
        const model = requestedModel ?? advertisedModels[0]?.id;
        assert.ok(
          model && advertisedModels.some((candidate) => candidate.id === model),
          "The requested model was not advertised by this Claude runtime."
        );
        const conversationId = crypto.randomUUID();
        try {
          const result = await runtime.generateChat(
            {
              conversationId,
              executeToolCall: async (call, signal) => {
                const tool = tools.find(
                  (candidate) => candidate.name === call.name
                );
                if (!tool) {
                  return { content: "Unknown test tool", success: false };
                }
                const executed = await executeProtectedTool(
                  tool,
                  call.arguments,
                  buildToolExecutionContext({
                    orgId: "live_claude_test",
                    orgRole: "member",
                    profileId: "profile",
                    signal,
                    userId: "live_claude_user",
                    workspaceRoot,
                  }),
                  { retryPolicy: { maxRetries: 0 } }
                );
                calls.push({
                  call: structuredClone(call),
                  data: executed.data,
                  success: executed.success,
                });
                return {
                  content: JSON.stringify(executed.data ?? executed.error),
                  success: executed.success,
                };
              },
              messages: [
                {
                  content: `Use write_file to create artifacts/live-claude.txt with exactly ${token}. Then use read_file on the exact path returned by write_file. Finish by returning the file's content.`,
                  role: "user",
                },
              ],
              signal: AbortSignal.timeout(150_000),
              system:
                "You are verifying two Atlas file tools against a disposable synthetic workspace. Execute the two dependent operations and report their actual result.",
              tools: tools.map((tool) => {
                assert.ok(tool.parameters, "A live test tool has no schema.");
                return {
                  description: tool.description,
                  name: tool.name,
                  parameters: tool.parameters,
                };
              }),
            },
            model
          );
          const writeIndex = calls.findIndex(
            (entry) => entry.call.name === "write_file" && entry.success
          );
          const written = calls[writeIndex];
          assert.ok(
            written &&
              written.data &&
              typeof written.data === "object" &&
              "path" in written.data
          );
          const outputPath = String(written.data.path);
          const read = calls.find(
            (entry, index) =>
              index > writeIndex &&
              entry.call.name === "read_file" &&
              entry.success &&
              entry.call.arguments.path === outputPath
          );
          assert.ok(
            read,
            "Live model did not read the exact returned artifact path."
          );
          assert.ok(
            read.data && typeof read.data === "object" && "content" in read.data
          );
          assert.equal(
            read.data.content,
            token,
            "Protected read_file did not return the written bytes."
          );
          assert.ok("truncated" in read.data && read.data.truncated === false);
          const resolved = path.resolve(workspaceRoot, outputPath);
          const relative = path.relative(workspaceRoot, resolved);
          assert.ok(
            relative &&
              !relative.startsWith(`..${path.sep}`) &&
              relative !== ".." &&
              !path.isAbsolute(relative),
            "Returned artifact escaped the synthetic workspace."
          );
          const bytes = await readFile(resolved);
          assert.equal(bytes.toString(), token);
          assert.ok(
            result.content.includes(token),
            "Live response did not contain the verified file content."
          );
          return {
            ...probeEvidence,
            advertisedModelIds: advertisedModels.map((entry) => entry.id),
            calls: calls.map((entry) => ({
              name: entry.call.name,
              success: entry.success,
            })),
            evidenceClass:
              "live Claude inference, native MCP and actual protected file tools",
            fileSha256: createHash("sha256").update(bytes).digest("hex"),
            liveMessengers: "NOT_RUN",
            model,
            modelSource: "native supportedModels metadata",
            principal: "synthetic member in a disposable workspace",
            status: "passed",
          };
        } finally {
          const binding = await readSubscriptionSession(
            "claude",
            conversationId
          );
          if (binding) {
            await runtime.deleteConversationSession(binding.runtimeSessionId);
            await clearSubscriptionSession("claude", conversationId);
          }
        }
      }
    );
    console.log(JSON.stringify(evidence));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
} else {
  console.log(
    JSON.stringify({
      ...probeEvidence,
      evidenceClass: "actual Claude runtime authentication probe",
      inference: "NOT_RUN",
      liveMessengers: "NOT_RUN",
      loginCommand: auth.loginCommand,
      reason:
        "Log in through Atlas's configured Claude runtime before retrying.",
      status: "BLOCKED",
    })
  );
  process.exitCode = 2;
}
