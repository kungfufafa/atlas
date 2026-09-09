# Completed candidate 3 memory request overhead audit

This audit found a larger Atlas prompt, **not a demonstrated accidental double injection**. It does not establish that prompt size caused any failure or that a smaller prompt would improve task completion.

The census covers all **96 scheduled arms and 855 recorded effective model requests** in the completed batch `development-2026-09-06T17-27-51-437Z-645527a9`. It reads request envelopes and finalized usage ledgers, never response bodies, hidden response reasoning, evaluator answers, holdout tasks, or live candidate 5 observations. This is an exploratory development audit conducted after candidate 3 outcomes were already available; it is not a preregistered performance endpoint.

## Symmetric counts and reported usage

| Measure | Atlas | Hermes |
| --- | ---: | ---: |
| Scheduled arms | 48 | 48 |
| Recorded main requests | 346 | 315 |
| Recorded auxiliary requests, all session titles | 95 | 99 |
| Total recorded requests | 441 | 414 |
| Known prompt tokens, main subtotal | 2,916,322 | 1,445,392 |
| Known prompt tokens, title subtotal | 22,037 | 28,116 |
| Total known prompt tokens | 2,938,359 | 1,473,508 |
| Requests missing prompt usage | 1 title | 3 titles |
| Known cached prompt token subtotal | 2,077,696 | 984,960 |
| Known generated token subtotal | 132,185 | 44,626 |

All 661 main requests have reported prompt usage. The four missing title observations are recorded as transport errors without a provider status, not observed upstream HTTP 502 responses. All other observations have status 200. No missing consumption is imputed. These counts do not include a request that the broker refused before recording/forwarding a request body. They do not replace the frozen attempt ledger or turn-completion results. Totals are recorded subtotals, **not complete billing or dollar-cost comparisons**.

The audit classifies titles by their exact source-bound title-system prefix, main requests by their exact agent-system prefix, and raises an error for any other request type. It does not classify a request merely because it lacks tools. Main and title counts include later requests and failures, without selecting successful arms.

## Opening prompt comparison

The first recognized main request in **each arm**, irrespective of warm/cold/identity stratum or eventual outcome, gives 48 openings per harness:

| Measure | Atlas | Hermes |
| --- | ---: | ---: |
| Mean reported prompt tokens | 7,457.83 | 3,724.85 |
| Median reported prompt tokens | 7,747 | 3,723.5 |
| Prompt token range | 6,718–8,157 | 3,695–3,768 |
| Mean raw system-text UTF-8 bytes | 16,530.38 | 8,969 |
| Tool-schema compact JSON bytes | 11,135 | 5,707 |
| Tool definitions | 19 | 4 |

The separate opening-shape census—main requests containing one user message and no assistant/tool history—finds 96 per harness, with mean prompt tokens 7,499.04 versus 3,756.52. It is a request-shape measure, not an inferred training/recall phase. `aggregate.json` retains the first-arm opening results separately for warm (32), cold (8), and identity (8) arms on both sides. This avoids selecting only the favorable stratum or conflating Hermes title requests with its first main request.

The body comparison uses only each envelope's `effective` request. All 855 original/effective `messages` and `tools` values are identical; the log's two views are **not two copies sent to the model**. The frozen broker records both views but passes only `JSON.stringify(effective)` upstream; `control-bindings.json` binds that code to the frozen archive. JSON byte sizes are reconstructed with compact UTF-8 serialization; they are not literal HTTP framing bytes or token estimates. System text, messages, and whole-body metrics overlap and must not be summed. Message-size accounting includes all serialized fields in requests, including replayed `reasoning_content` where present, without inspecting its content or making reasoning-quality judgments.

## What is actually repeated

Every main request has one system message and unique tool names. Atlas has one occurrence each of the known identity, style, operating-instructions, continuity, skill-catalog, work-quality, and presence section markers. Its same 665-byte skill catalog is carried on all 346 main requests. Re-sending system instructions and available schemas on subsequent stateless API requests is not itself duplicate injection, and known cached token counts show that raw repeated bytes cannot be treated as uncached billing.

Atlas's two bundled file-memory skills explicitly set `include-body-on-match: true`. The audit compares the **entire archived skill body**, not just its title, against each transmitted system prompt:

| Archived skill | Main requests carrying body | Copies when carried | Full active section size |
| --- | ---: | ---: | ---: |
| `update-profile-memory` | 265 / 346 | 1 | about 3,389–3,390 bytes |
| `archive-profile-memory` | 146 / 346 | 1 | about 2,595–2,596 bytes |

Each skill's description appears once in the catalog and once more in its active section when matched. This is the composition contract in `composeMatchedSkillsPrompt`, not evidence that its complete workflow was accidentally loaded twice. The only exact blank-line-delimited paragraph of at least 80 UTF-8 bytes repeated inside a main system prompt is the 130-byte instruction:

> When `edit_file` reports a missing, duplicate, or overlapping match, `read_file` again and issue a corrected edit with exact text.

It appears twice in 141 Atlas main requests because both self-contained skills contain it. Hermes has no repeated paragraph under that same detection rule. Removing one copy would remove 130 system-text bytes in affected requests; this audit does not establish a performance gain, nor justify stripping one independently usable skill of its recovery instruction. There is no demonstrated repeated whole active-skill body, duplicated tool definition, or repeated whole known injected section. This is a bounded exact-text audit, not proof that no semantic redundancy exists in every possible prompt configuration.

The 19 Atlas definitions cover file operations, conversation retrieval, database memory, todo/question, and organization-memory tools. Hermes's four definitions are `memory`, `tool_search`, `tool_describe`, and `tool_call`. Its pinned `tools/tool_search.py` implements progressive disclosure: bridge tools retain access to other tools through discovery/description/call. Four exposed schemas therefore does **not** mean Hermes only has four capabilities. This is an architectural difference that prevents interpreting the byte difference as duplicate instructions or an equivalent-tool deletion opportunity.

## Development recommendation

No narrow prompt-deduplication bug fix is supported by these data. The useful development hypothesis is a **general tool-discovery layer**, where Atlas advertises compact capabilities and loads an authorized tool's complete schema when needed, preserving all currently assigned functions, exact argument validation, permissions, tenant/owner boundaries, mutation approvals, and error behavior. Core memory operations needed immediately could remain directly exposed. Tool descriptions and user-facing capability names must still let a lightweight model discover the correct operation without knowing internal IDs.

A candidate would need behavior checks for discovery, unknown/missing tools, profile changes, malicious names/arguments, exact routing, and concurrent/session isolation before live trials. Prospective paired evaluation should retain both easy direct-memory tasks and tasks requiring discovery, measuring final correctness, discovery failure, additional requests, latency, reported/unknown usage, and overall completion. Tool names and all tools needed by the original tasks must remain reachable. Do not select the new tool catalog from held-out task answers, drop safety rules or tools to fit this benchmark, or reuse a favorable prompt-size result as evidence of task parity.

Matched-skill retrieval could be studied separately if it preserves discoverability and reliable execution of each complete workflow. These two skills are already conditionally included, and their full bodies occur only once, so converting them to on-demand retrieval would be a new behavior/cost tradeoff, not a correction to proven double-loading. The present evidence does not establish that either architectural change should precede the already demonstrated memory-owner/retrieval fixes.

## Historical/current source binding and reproduction

Historical Atlas candidate 3 source hash is `538c98b4f872e57e6c47d08fde1cd45cb3e591aa8462abde93fb3ec57e38bc74`; the batch archive SHA-256 is `cf790ef6c185c965b1be2a663b4c7da2be2907bf5da1ac0ca797273b4b145e3e`. Current candidate 5 source hash is `1b44dd862ed3dac305c1ebe86dabda28c0de085c6a1d9fc1f6f1eb5eaa7dca2d`.

`source-bindings.json` verifies selected historic archive members against the frozen candidate map and selected current files against candidate 5's map. `chat-prompt.ts`, `session-title.ts`, skill composition/service, both bundled skill files, soul composition, and default constants are byte-identical. `agent-service.ts` changed, but the compared `resolveProfileSystemPrompt` and matched-skill append blocks are byte-identical. `chat.ts`, memory tools and conversation tools changed in candidate 5; **candidate 3's exact payload/schema sizes must not be reported as candidate 5 measurements**. The three inspected Hermes files match the pinned archive and current source checkout exactly. No product source was modified by this audit.

Run `python3 /private/tmp/atlas-prompt-overhead-audit/audit.py` to reproduce the census from the existing completed batch. It checks the full 96-arm schedule, finalized/no-inflight usage ledgers, one-to-one request/usage indices, recognized request classes, unique tool names, one system message, and archived/current selected source hashes. It writes only this audit directory and performs no API requests.

`requests.json` lists each request's path, SHA-256, byte/count metrics, kind, arm, and matching finalized usage index. `arms.json` retains all 96 arm aggregates and ledger hashes. `sections.json` retains full exact repeated-paragraph references and per-marker interval statistics; interval bytes are a descriptive partition, not source-level token attribution. `aggregate.json` contains the complete numeric summaries and missing-usage references. `reference.json` binds the machine outputs and script; `report-reference.json` separately binds this narrative and its evidence. Raw response content is not copied into these artifacts.
