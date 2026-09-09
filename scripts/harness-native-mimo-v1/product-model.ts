import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MemoryRunRequest } from "./memory-types";
import profile from "./product-model-profile.json";
import { comparisonModel, upstreamEndpoint } from "./product-proxy-broker";

export const modelProfile = profile;

/** The completed compatibility-only probe is evidence, not a model-capacity catalog. */
export async function verifyModelEvidence(): Promise<void> {
  if (
    profile.model !== comparisonModel ||
    profile.endpoint !== upstreamEndpoint ||
    profile.userAgent !==
      "Atlas-Hermes-Compatibility-Probe/1.0 (nonstreaming)" ||
    profile.contextCapacity !== null ||
    profile.outputCapacity !== null
  ) {
    throw new Error("Fixed MiMo model/header profile mismatch.");
  }
  const values: Record<string, unknown> = {};
  for (const [name, evidence] of Object.entries(profile.evidenceFiles)) {
    const bytes = await readFile(join(import.meta.dir, name));
    if (createHash("sha256").update(bytes).digest("hex") !== evidence.sha256) {
      throw new Error("Compatibility probe receipt changed.");
    }
    values[name] = JSON.parse(bytes.toString());
  }
  const completed = values["product-model-probe-completed.json"] as {
    selectedModel: string;
    probeComplete: boolean;
    sourceUnchanged: boolean;
    finishedAt: string;
    selectionOrder: string[];
    modelResults: Array<{
      eligible: boolean;
      requestsAttempted: number;
      allMandatoryUsageKnown: boolean;
      outcomes: Array<{ pass: boolean; httpStatus: number }>;
    }>;
  };
  const receipt = values["product-model-probe-tool-response.json"] as {
    status: number;
    receivedAt: string;
    raw: string;
    transportError: unknown;
  };
  const response = JSON.parse(receipt.raw);
  if (
    completed.selectedModel !== comparisonModel ||
    !completed.probeComplete ||
    !completed.sourceUnchanged ||
    completed.finishedAt !== profile.selectionCompletedAt ||
    completed.selectionOrder.join(",") !== "mimo-v2.5,glm-5.3-flash" ||
    completed.modelResults.length !== 2 ||
    completed.modelResults.some(
      (result) =>
        !result.eligible ||
        result.requestsAttempted !== 5 ||
        !result.allMandatoryUsageKnown ||
        result.outcomes.length !== 5 ||
        result.outcomes.some(
          (outcome) => !outcome.pass || outcome.httpStatus !== 200
        )
    ) ||
    receipt.status !== 200 ||
    receipt.transportError !== null ||
    receipt.receivedAt !== profile.observedAt ||
    response.model !== comparisonModel ||
    response.choices?.[0]?.finish_reason !== "tool_calls" ||
    response.choices?.[0]?.message?.tool_calls?.[0]?.function?.name !==
      "echo_value"
  ) {
    throw new Error("Completed fixed-order compatibility evidence is invalid.");
  }
}

export function modelMetadata(): NonNullable<
  MemoryRunRequest["modelMetadata"]
> {
  return {
    entry: {
      capabilities: {
        "chat.tool-use": {
          source: "runtime-probe",
          status: "supported",
          verified: true,
          verifiedAt: profile.observedAt,
        },
      },
      id: comparisonModel,
    },
    evidence: {
      endpoint: upstreamEndpoint,
      model: comparisonModel,
      observedAt: profile.observedAt,
      source: `Completed fixed-order compatibility-only probe selected MiMo with exact header profile ${profile.userAgent}; receipt SHA256 ${profile.evidenceFiles["product-model-probe-tool-response.json"].sha256}. Context and output capacity remain unknown. Model and header differ from the historical DeepSeek stratum; no model-only causal claim.`,
    },
  };
}
