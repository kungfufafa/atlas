# Native memory V1 provider/transport error audit

Batch: `development-2026-09-06T14-20-07-841Z-e58d2c9c`. Read-only review of all 96 completed development arms; original scores and evidence unchanged.

| Origin | Count | Role | Mandatory usage | Queue fix alone |
|---|---:|---|---|---|
| Upstream response-format HTTP400 | 86 requests / 46 Hermes arms | Session title | Missing in all 86 | Does not address |
| Local concurrency HTTP400 | 6 failed foreground turns / 4 arms; 12 rejected forwards inferred | Foreground while title remains active | No upstream call for rejected request | Addresses this race; no success guarantee |
| Local finalization transport HTTP502 | 2 requests / 2 arms | Pending title fallback | Unknown | Not guaranteed |

Hermes retained 401 HTTP200 responses, 86 upstream HTTP400 responses, and 2 local transport failures; Atlas retained 434 HTTP200 responses. Whole-trajectory mandatory usage is known in 2/48 Hermes arms and 48/48 Atlas arms.

The same session_title JSON schema also succeeded 11 times. Thus the endpoint exhibited inconsistent handling; the evidence does not establish global lack of support. All 86 format failures were auxiliary title requests. No provider-origin HTTP502 response was observed.

The pinned Hermes code offers no native configuration found that omits only title JSON schema on this same endpoint while retaining auxiliaries. The title generator always supplies its schema; its caller fields overwrite configured auxiliary extra_body. Its native fallback retries once without format after rejection, leaving the initial unknown-usage failure. Turning titles off or selecting another route changes the comparison and was not done.

All affected attempt IDs, request indices, successful same-schema receipts, queue timing correlations and evidence hashes are in report.json. Local failed foreground turns are counted once per session/turn; repeated copies of the same error in observation/final/nativeResult are not counted again. The 12 local forwards are inferred from queue/upstream timing because the frozen local guard did not retain numbered rejection receipts.

## Local race-affected arms

- `development-2026-09-06T14-20-07-841Z-e58d2c9c-memory-v1-development-distractor_recall-2953-explicit-memory-warm-same-owner-r0-hermes` (1 failed foreground turn(s); 2 inferred rejected forwards).
- `development-2026-09-06T14-20-07-841Z-e58d2c9c-memory-v1-development-durable_fact-1907-explicit-memory-identity-different-user-r0-hermes` (2 failed foreground turn(s); 4 inferred rejected forwards).
- `development-2026-09-06T14-20-07-841Z-e58d2c9c-memory-v1-development-episodic_decision-1907-native-default-warm-same-owner-r0-hermes` (1 failed foreground turn(s); 2 inferred rejected forwards).
- `development-2026-09-06T14-20-07-841Z-e58d2c9c-memory-v1-development-implicit_preference-2953-explicit-memory-warm-same-owner-r0-hermes` (2 failed foreground turn(s); 4 inferred rejected forwards).

The queue fix does not resolve the 86 provider schema errors. These accounting-driven failures cannot establish parity or superiority; retain every fixed score and qualify the native comparison. No selective exclusions, rescoring, extra paid calls, provider probes, or frozen-control changes were performed.
