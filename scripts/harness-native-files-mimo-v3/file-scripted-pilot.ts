import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runFileBatch } from "./file-run";

/** Explicit offline instrumentation only: real native adapters, synthetic upstream. */
export async function runFileScriptedPilot(evidenceDirectory: string) {
  await mkdir(evidenceDirectory, { recursive: true });
  const root = await mkdtemp(join(evidenceDirectory, "native-scripted-"));
  const keyFile = join(root, "synthetic-key");
  await writeFile(keyFile, "offline-scripted-no-provider-credential", {
    flag: "wx",
    mode: 0o600,
  });
  const calls: Array<{
    model: unknown;
    ordinal: number;
    structuredResponse: boolean;
  }> = [];
  const directory = await runFileBatch({
    candidateLabel: "C9-offline-instrumentation-only",
    async fetchUpstream(_url, init) {
      const request = JSON.parse(String(init.body)) as Record<string, unknown>;
      const structuredResponse = request.response_format !== undefined;
      calls.push({
        model: request.model,
        ordinal: calls.length + 1,
        structuredResponse,
      });
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            index: 0,
            message: {
              content: structuredResponse
                ? JSON.stringify({ title: "Offline instrument check" })
                : "Offline instrument check: no finished file was created.",
              role: "assistant",
            },
          },
        ],
        created: 1,
        id: `offline-scripted-${calls.length}`,
        model: request.model,
        object: "chat.completion",
        usage: { completion_tokens: 10, prompt_tokens: 20, total_tokens: 30 },
      });
    },
    keyFile,
    phase: "pilot",
    studyRoot: root,
  });
  const receipt = {
    actualNativeAdapters: true,
    calls,
    directory,
    providerCalls: 0,
    syntheticUpstream: true,
  };
  await writeFile(
    join(root, "scripted-pilot-receipt.json"),
    JSON.stringify(receipt),
    { flag: "wx", mode: 0o600 }
  );
  return receipt;
}
if (import.meta.main) {
  const [flag, evidenceDirectory] = process.argv.slice(2);
  if (
    flag !== "--run-offline" ||
    !evidenceDirectory?.startsWith("/private/tmp/")
  ) {
    throw new Error(
      "Explicit --run-offline /private/tmp/evidence-directory required."
    );
  }
  const receipt = await runFileScriptedPilot(evidenceDirectory);
  process.stdout.write(
    `${JSON.stringify({ directory: receipt.directory, event: "offline-native-pilot-complete", providerCalls: 0 })}\n`
  );
}
