# Harness eval — iteration 6 (chatKind plumbing + purpose-based tool roster)

Generated: 2026-09-17T03:14:13.000Z

Strong model: `kimi-k2.7-code`
Weak model: `deepseek-flash`
Product-path flags: allowlist ON, work-rules ON, native schemas ON, memory-retrieval ON, summarization ON, archive-index ON, skill-learning OFF (except the learning suite)
Channel ablation: `--no-chat-kind` (omit `chatKind` from `createAgentChatSession`) vs `--chat-kind` (product default)
Path: `createAgentHarness.createChatSession.send` (`buildChatSystemPrompt` + `generateReply` + `executeToolCall`)

## Question

Does plumbing `chatKind` (private vs group) into `buildChatSystemPrompt` make Nakama-style channel blocks fire, and does labeling assigned tools by purpose move the assigned-decoy wording trap — without regressing default 20/21, learning extras, or memory 6/6?

## Design A — chatKind plumbing (Nakama P2)

Channel workers already send `externalPrincipal.channelIsGroup`. Until this iteration that boolean never reached `createAgentChatSession`, so `appendMessagingChannelPrompt` always used `messagingUnsetAudienceLine` and never appended `PRIVATE_CHAT_KIND_GUIDANCE` / `GROUP_CHAT_KIND_GUIDANCE`.

| Piece | What landed |
|---|---|
| Resolver | `resolveMessagingChatKind(channel, channelIsGroup)` → `private` \| `group` only on telegram/whatsapp/discord. Non-messaging channels stay unset. |
| Session options | `AgentChatSessionOptions.chatKind` passed into `buildChatSystemPrompt`. |
| AgentService | `buildChatSession` / create / branch / rebuild map `access.externalPrincipal.channelIsGroup` and store `chatKind` on the in-memory `StoredSession`. |
| Prompt | Private: `You are replying in a private {Label} chat.` + 1:1 etiquette (no @, no name-addressing). Group: `{Label} channel` audience + address the asker, keep it short. Unset kind keeps the generic fallback. |
| Eval | `--no-chat-kind` baseline vs `--chat-kind`. Extras: WhatsApp + Telegram × private + group. Not in the 21 default. |

Remaining vs Nakama: `chatKind` is **not** a SQLite column. A cold rebuild without the original principal falls back to unset.

## Design B — purpose roster + unassigned decoy

`tool_avoid_wording_trap` assigns both `lookup_ticket` (canonical live lookup) and `lookup_ticket_live` (preview stub). The user names the decoy. Iteration 2–5 never moved the strong model.

This iteration:

| Piece | What landed |
|---|---|
| Roster line | `- {name} — purpose: {first-line description}` via `formatAssignedToolRosterLine` / `compactToolPurpose` (140-char bound). |
| Instruction | “Choose a tool by its purpose, not by a similar-looking name. Names that look alike are distinct tools.” |
| Unassigned companion | `tool_avoid_unassigned_decoy`: same user wording, decoy **not** in the catalog. Allowlist must omit `- lookup_ticket_live`. Extra (not in 21). |

If the strong model still calls the assigned decoy after this genuine attempt, that is a **model-judgment limitation**, not a missing prompt line.

## Yardsticks

| Id | Discriminator | Default suite? |
|---|---|---|
| `channel_whatsapp_private` | Prompt has private 1:1 lines; reply does not address Jordan / @mention; WhatsApp format. | Extra |
| `channel_whatsapp_group` | Prompt has group audience + etiquette; reply addresses Jordan. `@` allowed in groups. | Extra |
| `channel_telegram_private` | Same private checks on Telegram. | Extra |
| `channel_telegram_group` | Same group checks on Telegram. | Extra |
| `tool_avoid_wording_trap` | User says `lookup_ticket_live`; decoy **is** assigned. Must call `lookup_ticket` only. | In 21 |
| `tool_avoid_unassigned_decoy` | Same wording; decoy **absent**. Must call `lookup_ticket`; prompt omits the decoy name. | Extra |

## BEFORE (`--no-chat-kind`)

n = 3 live OpenCode Go runs per model. Four channel extras each run.

**0 / 12** strong and **0 / 12** weak (24/24 scenario-runs fail).

Prompt checks: **0 / 24**. Every BEFORE prompt used the unset fallback (`You are replying on WhatsApp/Telegram…`), so `prompt_omits_unset_kind`, `prompt_has_private_*`, and `prompt_has_group_*` all failed. Private and group prompts were identical.

| model | n | passed | passRate | meanScore | meanGraded |
|---|---:|---:|---:|---:|---:|
| kimi-k2.7-code | 3×4 | 0/12 | 0.000 | 0.529 | 0.843 |
| deepseek-flash | 3×4 | 0/12 | 0.000 | 0.535 | 0.706 |

Reply behavior without kind: strong Telegram group never addressed Jordan (3/3); private replies mixed name-addressing and one `@Jordan`. That is the unset-kind baseline, not a product channel policy.

## AFTER (`--chat-kind`, product default)

n = 3.

Prompt checks: **24 / 24**. Private prompts contain 1:1 guidance and omit group audience; group prompts contain group audience + etiquette and omit private lines. Plumbing is proven independently of reply style.

Live pass/fail (prompt **and** reply etiquette):

| model | n | passed | passRate | meanScore | meanGraded | live fails |
|---|---:|---:|---:|---:|---|
| kimi-k2.7-code | 3×4 | 9/12 | 0.750 | 0.964 | 0.988 | `channel_telegram_private` 0/3 (`reply_does_not_address_asker`) |
| deepseek-flash | 3×4 | 10/12 | 0.833 | 0.979 | 0.771 | WhatsApp private n2, Telegram private n3 (same reply check) |

Group yardsticks: **6 / 6** both models (WhatsApp + Telegram). Private WhatsApp: strong 3/3, weak 2/3. Private Telegram: strong 0/3 still said Jordan / “let Jordan know”; weak 2/3.

Delta vs BEFORE: prompt discriminator **0.000 → 1.000**. Live pass rate **0.000 → 0.750 / 0.833**. Residual private name-addressing is reply-style, not missing prompt text.

## Tool disambiguation (n = 3 dedicated)

Allowlist ON, purpose roster ON.

### Assigned decoy (`tool_avoid_wording_trap`)

| model | n | passed | meanScore | meanGraded | calls |
|---|---:|---:|---:|---:|---|
| kimi-k2.7-code | 3 | **0/3** | 0.250 | 0.083 | `lookup_ticket_live` only, every run |
| deepseek-flash | 3 | 2/3 | 0.833 | 0.889 | n1–n2: `lookup_ticket`; n3: both decoy and canonical |

Strong did **not** move. Replies quoted the preview stub (“Live-index preview”). Same failure on the 21-suite and 23-suite (`lookup_ticket_live` only). Verdict: **model-judgment limitation**. The purpose line and “choose by purpose” instruction were a genuine harness attempt; forcing the scenario further would be eval gaming.

Weak 2/3 on the dedicated runs (and pass on the 21-suite) is the same flash variance seen in iter4/iter5, not a product claim that the trap is solved.

### Unassigned decoy (`tool_avoid_unassigned_decoy`)

Allowlist ON: **6 / 6** (3/3 both models). Every run: `lookup_ticket` only, `prompt_omits_unassigned_decoy` true, live summary recalled.

Allowlist OFF (`--no-allowlist`): **6 / 6** as well. Native schemas also omit the missing name, so the model cannot call a tool that is not in the provider catalog. Live isolation of the **prompt** allowlist vs native schemas still fails (same honesty as iter2). Prompt-unit tests prove the roster omits `- lookup_ticket_live` when the decoy is unassigned; `--no-allowlist` still omits it from native schemas.

The unassigned companion is the fixable pair: assigned-tool catalogs that do not include a close name do not get that name called. The assigned-decoy case is the hard one.

## Full suite (no original-suite regression)

21 scenarios = previous 21, learning **off**, chatKind **on**. Channel-kind and unassigned-decoy extras excluded. n = 1.

| model | passed | failed | failed ids | original 17 | memory 6 |
|---|---:|---:|---|---|---|
| kimi-k2.7-code | 20 | 1 | `tool_avoid_wording_trap` | **16/17** | **6/6** |
| deepseek-flash | 20 | 1 | `tool_avoid_absent_web_search` | **16/17** | **6/6** |

Default floor **20/21** held. Strong still fails the assigned decoy. Flash passed wording-trap this run and substituted `search_kb` on absent web/email — same pattern as iter4/iter5. Memory retrieval + recall + long-context: 6/6 both models.

## Learning suite

23 scenarios = 21 + `learn_sop_acquisition` + `learn_unknown_tool_recovery`. Learning **on**. n = 1 (+ one flash retry).

| model | passed | failed | failed ids | learning extras |
|---|---:|---:|---|---|
| kimi-k2.7-code | 22 | 1 | `tool_avoid_wording_trap` | **2/2** |
| deepseek-flash | 21 | 2 | `tool_avoid_absent_web_search`, `tool_avoid_wording_trap` | **2/2** |
| deepseek-flash (retry) | 21 | 2 | same two | **2/2** |

Strong meets **22/23**. Flash 21/23 is **not** a learning-loop regression: both learning yardsticks passed on every run. The dip is 21-suite variance (absent-web, which also failed the 21-suite, plus wording-trap, 2/3 on dedicated flash runs). Iter5 flash 23/23 was the lucky cell, not a new product guarantee.

## Validation

- `bun run typecheck` — pass (`tsc --noEmit -p tsconfig.typecheck.json`)
- Focused `bun test` — **84 pass / 0 fail** across `packages/agent/src/chat-prompt.test.ts`, `packages/agent/src/chat-channel-kind.test.ts`, `scripts/harness-eval/run.test.ts`

## Production path vs harness-faithful

Shared with production:

- `resolveMessagingChatKind` + `AgentChatSessionOptions.chatKind` → `buildChatSystemPrompt`
- `AgentService` maps `externalPrincipal.channelIsGroup` on create/branch/rebuild
- Assigned-tool roster `purpose:` lines and purpose-selection instruction
- Channel format rules (WhatsApp/Telegram/Discord) unchanged

Eval-only / not AgentService:

- `--no-chat-kind` omits the session field; production always passes the resolved kind when the principal has `channelIsGroup`
- In-memory `StoredSession.chatKind` — not persisted in SQLite
- Channel extras and unassigned-decoy are not in the 21 default
- In-harness tool store, no org middleware, no write-approval
- Unassigned-decoy `--no-allowlist` still lacks the name in native schemas, so live allowlist-off cannot induce a call to a missing tool

## Honest remaining gaps vs Hermes / OpenClaw / Nakama

Closed this iteration: Nakama private-vs-group prompt blocks now fire when workers supply `channelIsGroup`.

Still open:

1. Assigned-decoy `tool_avoid_wording_trap` — **model-judgment limitation** on `kimi-k2.7-code` (0/3 dedicated, 0/1 full, 0/1 learning). Do not keep lengthening the prompt to force it.
2. `chatKind` not persisted in SQLite (cold rebuild without principal → unset fallback).
3. Compacted `search_chats` archives still lexical, not FTS-indexed (Hermes).
4. Skill learning still default-off (Hermes always-on).
5. OpenClaw gateway policy language (per-channel allow/deny, skill trust tiers) is broader than Landlock + assigned-tool roster.

## Recommended iteration 7

1. Persist `chatKind` (or `channelIsGroup`) on the session row so rebuilds keep private vs group.
2. Stop treating assigned-decoy wording-trap as a harness bug; keep it as a known strong-model fail.
3. FTS-index compacted `search_chats` archives.
4. Do not default interactive skill learning on without an operator flag.

## Files

- `docs/harness/eval-results/iter6-channel-before-{strong,weak}-n{1,2,3}.json`
- `docs/harness/eval-results/iter6-channel-after-{strong,weak}-n{1,2,3}.json`
- `docs/harness/eval-results/iter6-decoy-after-{strong,weak}-n{1,2,3}.json`
- `docs/harness/eval-results/iter6-unassigned-noallowlist-{strong,weak}-n{1,2,3}.json`
- `docs/harness/eval-results/iter6-after-{strong,weak}-full.json`
- `docs/harness/eval-results/iter6-after-{strong,weak}-learning.json`
- `docs/harness/eval-results/iter6-after-weak-learning-retry.json`
- `docs/harness/eval-results/iter6-summary.json`
