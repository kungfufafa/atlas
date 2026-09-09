import { expect, test } from "bun:test";
import { TokenRouterSmokeRunner } from "./tokenrouter-smoke-runner";

test("provider inference without an explicitly configured credential is blocked", async () => {
  const priorEnabled = process.env.ATLAS_RUN_PROVIDER_SMOKE;
  const priorKey = process.env.TOKENROUTER_API_KEY;
  process.env.ATLAS_RUN_PROVIDER_SMOKE = "1";
  delete process.env.TOKENROUTER_API_KEY;
  try {
    const result = await new TokenRouterSmokeRunner().run();
    expect(result.status).toBe("BLOCKED");
    expect(result.checks[0]?.status).toBe("fail");
    expect(result.providerCheckReports).toEqual([]);
  } finally {
    if (priorEnabled === undefined) {
      delete process.env.ATLAS_RUN_PROVIDER_SMOKE;
    } else {
      process.env.ATLAS_RUN_PROVIDER_SMOKE = priorEnabled;
    }
    if (priorKey === undefined) {
      delete process.env.TOKENROUTER_API_KEY;
    } else {
      process.env.TOKENROUTER_API_KEY = priorKey;
    }
  }
});
