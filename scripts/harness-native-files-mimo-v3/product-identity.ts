import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ProductRuntimeIdentity {
  attemptId: string;
  createdAt: string;
  harness: "atlas" | "hermes";
  nativeStateRoot: string;
  pairId: string;
  repetition: number;
  schemaVersion: 1;
  taskId: string | null;
  transportId: string;
}

export async function finalizeProductRuntimeIdentities(
  directory: string
): Promise<string> {
  const events = (await readFile(join(directory, "attempts.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const entries = events
    .filter((event) => event.event === "start")
    .map((event) => ({
      attemptId: event.id,
      identitySha256: event.identitySha256,
    }));
  const bytes = JSON.stringify({ entries, schemaVersion: 1 }, null, 2);
  await writeFile(join(directory, "runtime-identities.json"), bytes, {
    flag: "wx",
    mode: 0o600,
  });
  return createHash("sha256").update(bytes).digest("hex");
}

/** Private evaluator evidence. This file is never placed in native state. */
export async function createProductRuntimeIdentity(options: {
  attemptId: string;
  harness: "atlas" | "hermes";
  nativeParent: string;
  pairId: string;
  repetition: number;
  taskId?: string;
  trialDirectory: string;
}): Promise<{ identity: ProductRuntimeIdentity; identitySha256: string }> {
  await mkdir(options.trialDirectory, { recursive: true });
  const identity: ProductRuntimeIdentity = {
    attemptId: options.attemptId,
    createdAt: new Date().toISOString(),
    harness: options.harness,
    nativeStateRoot: await mkdtemp(join(options.nativeParent, "state-")),
    pairId: options.pairId,
    repetition: options.repetition,
    schemaVersion: 1,
    taskId: options.taskId ?? null,
    transportId: `transport-${randomUUID()}`,
  };
  const bytes = JSON.stringify(identity, null, 2);
  await writeFile(
    join(options.trialDirectory, "runtime-identity.json"),
    bytes,
    {
      flag: "wx",
      mode: 0o600,
    }
  );
  return {
    identity,
    identitySha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
