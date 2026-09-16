# Live harness eval

Drives the real Atlas agent loop:

`createAgentHarness.createChatSession.send` → `buildChatSystemPrompt` + `generateReply` + `executeToolCall`

against OpenCode Go. This is the yardstick for harness iterations. Iteration 1–2
scored 12/12 on `kimi-k2.7-code` before *and* after because work-rules and
native tool schemas already constrained a strong model. Use the ablation flags
and weaker models below when you need a discriminating signal.

## Run

```bash
export PATH="$HOME/.bun/bin:$PATH"
source "$HOME/.opencode-go.env"   # OPENCODE_GO_API_KEY + OPENCODE_GO_BASE_URL
bun run atlas:harness-eval
bun run atlas:harness-eval -- --help
```

Do not print or commit the API key.

## Ablation flags

Defaults match the iteration-2 product path (all on). Each switch is independent.

| Flag | Env | Default | Effect |
|---|---|---|---|
| `--work-rules` / `--no-work-rules` | `HARNESS_EVAL_WORK_RULES=0\|1` | on | `appendRuntimeProfileRules` / `DEFAULT_AGENT_WORK_RULES` ("do not invent tools") |
| `--allowlist` / `--no-allowlist` | `HARNESS_EVAL_ALLOWLIST=0\|1` | on | `# Assigned tools` roster in `buildChatSystemPrompt` |
| `--model <id>` | `HARNESS_EVAL_MODEL` | `kimi-k2.7-code` | OpenCode Go model id |
| `--native-schemas` / `--no-native-schemas` | `HARNESS_EVAL_NATIVE_SCHEMAS=0\|1` | on | Whether `generateChat`/`streamChat` receive native tool schemas |

Other flags: `--scenario <id>` (repeatable), `--prompt-only`, `--out <path>`,
`--matrix`, `--strong-model`, `--weak-model`, `--out-dir`.

CLI overrides env. Last duplicate flag wins.

### Native schemas

`--no-native-schemas` is an **eval-only** provider wrapper (`omitNativeToolSchemas`).
It does not change `packages/agent` production code. Atlas only executes
provider-emitted `toolCalls`, so stripping schemas typically prevents any tool
use. Keep schemas **on** for product-path measurements. A first-class
session option to omit schemas would require threading a new flag through
`sendMessage` / `runConversation` / `generateReply`; that is a larger refactor
than this eval wrap.

## Scoring

Each scenario still has binary `passed` (all checks true) and `score` (fraction
of checks — partial credit). Reports also include:

- `toolPrecision` / `toolRecall` from the scenario's `expectedTools` vs unique calls
- `gradedScore` = mean of check-fraction, precision, and recall

Avoidance scenarios have empty `expectedTools`: no calls → precision 1, recall 1;
any call → precision 0.

## Discriminating scenarios

Original ids are unchanged. Added:

| Id | What it separates |
|---|---|
| `tool_select_near_duplicate` | `lookup_ticket` vs `lookup_ticket_by_title` |
| `multi_step_three_hop` | lookup → `search_kb` with ticket `escalationKey` → `write_note` in order |
| `memory_long_context_needle` | recall `SILVER-ORCHID-77` from a 90-bin MEMORY.md distractor list |
| `tool_avoid_wording_trap` | user says `lookup_ticket_live`; real tool is `lookup_ticket` |
| `tool_avoid_no_fit_lure` | `generate_image` / `send_email` requested; neither is assigned |

## Matrix

```bash
bun run atlas:harness-eval -- --matrix --out-dir docs/harness/eval-results
```

Runs `{allowlist off, on} × {work-rules off, on} × {strong, weak}` with native
schemas on. Writes per-cell JSON, `ablation-matrix.json`, and
`ablation-summary.md`. Default models: `kimi-k2.7-code` and `deepseek-flash`.
