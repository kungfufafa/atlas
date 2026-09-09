# OpenCode Go compatibility probe v1

Prepared on 2026-09-06; not executed. The parent investigator must finish the current controlled study, obtain independent review of this exact plan and runner, then supply the one-execution admission. No API key is embedded or read during preparation.

This probe answers a narrow question: whether the documented `mimo-v2.5` and `glm-5.3-flash` endpoints accept the pinned Hermes title JSON schema, return a structured tool call and its followup, report mandatory token usage, and identify the exact requested model. It contains neutral synthetic messages only. It does not score Atlas or Hermes, inspect benchmark/holdout tasks, measure native lifecycle behavior, or rank response quality. Existing DeepSeek outcomes remain unchanged.

## Fixed schedule and controls

For each stage, call **mimo-v2.5 first, then glm-5.3-flash**: title 1; tool initiation; title 2; dependent tool followup; title 3. This gives ten immutable scheduled slots, at most five actual requests per model. Both models are tested even if the first passes. A failed initial tool response makes that model ineligible and skips only its dependent followup; all independent title slots remain scheduled. No evaluator retries, alternate endpoints, fallback response formats, or replacement models are allowed.

Every request uses the exact documented Chat Completions endpoint, temperature 0.2, output cap 4096, nonstreaming, and no explicit reasoning control. The endpoint is `https://opencode.ai/zen/go/v1/chat/completions`. Authentication remains a bearer token read only from the supplied regular key file. Content type remains JSON. One independent opaque `x-opencode-session` value is stable per model. No headers or secrets are logged.

The fixed User-Agent is `Atlas-Hermes-Compatibility-Probe/1.0 (nonstreaming)` for both models. This is an explicit model-neutral amendment from the historical DeepSeek transport tag. Any later alternate-model native stratum must use this same documented User-Agent. Requested and returned model fields, never the User-Agent, establish model identity.

Each HTTP request including response drain has a 90-second deadline; the whole probe has a 960-second deadline. There are at most ten sends and 40,960 requested generated tokens in total. These caps do not prove provider compliance, represent model capacity, or guarantee account cost. Tokenization and exact Go allowance consumption are not assumed.

## Exact native title payload and tool check

`title-native-snapshot.json` contains the pinned Hermes source path/hash and AST-literal extraction of `_TITLE_PROMPT_TEMPLATE`, `_LANGUAGE_RULE_MATCH_USER`, `_TITLE_RESPONSE_FORMAT`, and `_MAX_TITLE_WORDS`. No Hermes module or SDK is imported to obtain these constants. The title prompt substitutes the native language rule exactly, and each short synthetic message passes through unchanged. The schema is native strict `session_title`, requiring only a string `title` and no extra properties. Native helper defaults 64 output tokens / temperature 0.3 are normalized to 4096 / 0.2 as in the shared live broker.

The pure `echo_value` function accepts exactly `{"value":"COMPAT_READY"}` and returns that object. The initial request exposes the function schema with default automatic tool choice. Exactly one valid function call with a nonempty ID is required. No malformed, partial, failed, or truncated call executes. The actual successful assistant message, including any `reasoning_content`, and its real call ID are retained for the followup. The final response must trim to `COMPAT_READY`. There is no filesystem, network, shell, or other side effect.

The checks are deliberately explicit schema/protocol compatibility checks. Unlike Hermes's permissive cleanup and prose fallback, a title must parse as the exact schema object with a nonempty title of at most 12 whitespace-separated words. No semantic or stylistic title quality is judged. A passed probe does not establish support for all native auxiliary traffic or promise whole-study success. Because the User-Agent is also amended, it certifies only the tested model/endpoint/header/payload profile, not that a model change alone causally resolves historical DeepSeek schema failures.

## Eligibility, accounting, and immutable evidence

A model is eligible only if all three titles and both tool roundtrip responses pass the frozen predicates, every actual request returns HTTP 200 with the exact selected model, and every response reports nonnegative safe integer prompt/completion counts with completion at most 4096. A reported total must equal prompt plus completion; reported reasoning tokens must fit inside completion and are never added twice. Missing cached-input usage remains separately unknown and does not invalidate known mandatory counts. All raw reported usage is retained, including failed responses.

HTTP errors, transport errors, malformed/partial outputs, unexpected finish reasons, model substitutions, and unknown/invalid mandatory usage all make the model ineligible. A timeout may leave upstream work and usage unknown; it is never retried or converted into zero usage. Reported token totals are explicitly observed subtotals, not a certified total when any response is unknown. After all ten slots resolve, select the first eligible model in the fixed order. If neither qualifies, select none. No interim early stop or task-performance criterion enters this decision.

Execution requires a separately reviewed admission bound to the exact plan, runner, and readiness hashes and to the single fixed output directory. The runner creates an exclusive durable `execution-claim.json` before reading the key or sending requests. A second launch, restart, or alternative output path is rejected. A crash after an uncertain send consumes admission; do not delete/recreate the claim or issue a second admission for the same probe. Any newly justified investigation must use a separately declared protocol/version and retain this attempt.

The reviewed plan, runner, readiness, documentation, native snapshot and pinned title source bytes are archived before the first request. Their hashes are rechecked before selection; any change preserves the results but forbids selection. The whole-probe elapsed time and observed total generated counts are certified before selection; known exhaustion prevents further sends and marks remaining slots as skipped. An observed overrun forbids selection. The complete schedule is persisted before the first request. Each slot has durable start, exact request body/hash, send-attempt marker, sanitized raw response/hash, and end evidence; dependent/deadline skips are explicit. A send-attempt marker is not proof that the provider received a request. After a process crash, the last recorded schedule exposes all unfinished slots; absence of their end files means unresolved, not success, and no completed selection is valid. Authorization headers, API keys, and arbitrary top-level error text are not printed. The known key is redacted from response/error bodies before persistence.

## Source and launch status

The official documentation and retrieval date are recorded in `docs-source.json`: https://opencode.ai/docs/go/. Lower listed input/output rates justify a bounded compatibility attempt, not a universally cheaper claim or an account billing estimate. Documentation verifies advertised IDs and endpoints only. The exact title source hash and all plan/support file hashes are bound in `readiness.json`. This private directory is outside all locked production/control files.

Launch command after review and parent authorization:

```sh
bun /private/tmp/atlas-go-compatibility-probe-v1/runner.ts --execute --key-file /ABSOLUTE/KEY_FILE --admission-file /ABSOLUTE/REVIEWED_ADMISSION.json
```

No launch has occurred during preparation. The runner must never be used as a reason to replace, discard, or rescore earlier DeepSeek evidence. An eligible model permits only a separately frozen native stratum after its own integration gate.
