import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "../harness-compare/provenance";
import { comparisonModel } from "../harness-compare-v2-transport/proxy";
import { object } from "./accounting";
import { type Harness, jsonFile } from "./provenance";

export interface RuntimeIdentity {
  attemptId: string;
  createdAt: string;
  harness: Harness;
  nativeStateRoot: string;
  repetition: number;
  schemaVersion: 1;
  taskId: string;
  transportId: string;
  workspaceRoot: string;
}

export interface IdentityAttribution {
  harness: string;
  id: string;
  identitySha256?: string;
  phase?: string;
  repetition: number;
  taskId: string;
  transportId?: string;
}

const opaqueId =
  /^transport-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const neutralRoot =
  /^\/private\/tmp\/atlas-harness-runtime-[a-zA-Z0-9]+\/run-[a-zA-Z0-9]+$/;

export async function createRuntimeIdentity(
  directory: string,
  parent: string,
  input: {
    attemptId: string;
    harness: Harness;
    taskId: string;
    repetition: number;
  }
): Promise<{ identity: RuntimeIdentity; identitySha256: string }> {
  const nativeStateRoot = await mkdtemp(join(parent, "run-"));
  const identity: RuntimeIdentity = {
    ...input,
    createdAt: new Date().toISOString(),
    nativeStateRoot,
    schemaVersion: 1,
    transportId: `transport-${randomUUID()}`,
    workspaceRoot: join(nativeStateRoot, "workspace"),
  };
  await jsonFile(join(directory, "runtime-identity.json"), identity);
  return {
    identity,
    identitySha256: sha256(
      await readFile(join(directory, "runtime-identity.json"))
    ),
  };
}

/** Private evidence verification: never execute archived code or require native state to remain on disk. */
export async function verifyRuntimeIdentity(
  directory: string,
  record: IdentityAttribution,
  seen: { transports: Set<string>; roots: Set<string> }
): Promise<RuntimeIdentity> {
  const raw = await readFile(join(directory, "runtime-identity.json"));
  const identity = JSON.parse(raw.toString()) as RuntimeIdentity;
  if (
    record.identitySha256 !== sha256(raw) ||
    identity.schemaVersion !== 1 ||
    identity.attemptId !== record.id ||
    identity.transportId !== record.transportId ||
    !opaqueId.test(identity.transportId) ||
    identity.harness !== record.harness ||
    identity.taskId !== record.taskId ||
    identity.repetition !== record.repetition ||
    !neutralRoot.test(identity.nativeStateRoot) ||
    identity.workspaceRoot !== join(identity.nativeStateRoot, "workspace") ||
    !Number.isFinite(Date.parse(identity.createdAt))
  ) {
    throw new Error(
      "Private runtime identity hash/attribution/neutral paths mismatch."
    );
  }
  if (
    seen.transports.has(identity.transportId) ||
    seen.roots.has(identity.nativeStateRoot)
  ) {
    throw new Error(
      "Runtime transport identifier or native state root reused across attempts."
    );
  }
  seen.transports.add(identity.transportId);
  seen.roots.add(identity.nativeStateRoot);
  const input = object(
    JSON.parse(await readFile(join(directory, "runner-input.json"), "utf8"))
  );
  const output = object(
    JSON.parse(await readFile(join(directory, "runner-stdout.json"), "utf8"))
  );
  if (input.model !== comparisonModel || output.model !== comparisonModel) {
    throw new Error("Runtime model identity mismatch.");
  }
  if (identity.harness === "atlas") {
    if (
      input.runId !== identity.transportId ||
      output.runId !== identity.transportId ||
      output.framework !== "atlas" ||
      typeof output.isolatedConfigDir !== "string" ||
      !output.isolatedConfigDir.startsWith(
        `${identity.nativeStateRoot}/atlas-harness-compare-`
      )
    ) {
      throw new Error("Atlas runner identity differs from private mapping.");
    }
  } else if (
    input.run_id !== identity.transportId ||
    output.run_id !== identity.transportId ||
    output.harness !== "hermes" ||
    input.workspace !== identity.workspaceRoot ||
    output.workspace !== identity.workspaceRoot ||
    input.hermes_home !== join(identity.nativeStateRoot, "hermes-home") ||
    new URL(String(input.base_url)).pathname !==
      `/runs/${identity.transportId}/v1` ||
    new URL(String(input.tool_base_url)).pathname !==
      `/runs/${identity.transportId}`
  ) {
    throw new Error(
      "Hermes runner paths/identity differ from private mapping."
    );
  }
  for (const name of await readdir(join(directory, "wire"))) {
    if (!/^\d+-request\.json$/.test(name)) {
      continue;
    }
    const wire = object(
      JSON.parse(await readFile(join(directory, "wire", name), "utf8"))
    );
    const payload = JSON.stringify(wire.effective);
    if (
      [identity.attemptId, identity.taskId, directory].some((privateValue) =>
        payload.includes(privateValue)
      )
    ) {
      throw new Error(
        "Private orchestration identity leaked into model-visible wire payload."
      );
    }
  }
  return identity;
}

export interface IdentityManifestEntry {
  attemptId: string;
  identitySha256: string;
}
export async function writeIdentityManifest(directory: string) {
  const records = (await readFile(join(directory, "attempts.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => object(JSON.parse(line)));
  const entries = records
    .filter((record) => record.event === "start")
    .map((record) => ({
      attemptId: record.id,
      identitySha256: record.identitySha256,
    }));
  await jsonFile(join(directory, "runtime-identities.json"), {
    entries,
    schemaVersion: 1,
  });
  return sha256(await readFile(join(directory, "runtime-identities.json")));
}
