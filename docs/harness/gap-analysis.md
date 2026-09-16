# Atlas agent harness — gap analysis (iteration 1)

This document compares the Atlas agent loop to three reference harnesses:

- **Hermes Agent** (NousResearch): learning loop, skill self-improvement, FTS5 memory + LLM summarization
- **OpenClaw**: multi-channel gateway, policy/sandbox, skills ecosystem
- **Nakama** (upstream of this fork): soul system, skill post-turn review + consolidation, channel-aware prompts

Citations are to current Atlas files and functions. Rankings are about **response quality**, not product surface area: tool-hallucination rate, multi-step reasoning, context-awareness, long-session behavior.

## What Atlas already has (do not rebuild)

| Area | Atlas location | Notes |
|---|---|---|
| Chat structure + channel prompts | `packages/agent/src/chat-prompt.ts` `buildChatSystemPrompt` | Presence rules, untrusted-document guidance, WhatsApp/Telegram/Discord format rules |
| Soul identity | `packages/core/src/soul/compose.ts` `composeSoulSystemPrompt` | SOUL / STYLE / INSTRUCTIONS / MEMORY.md |
| Skills catalog + match | `packages/core/src/skills/compose.ts` | Catalog, matched body, agent-browser capability |
| Tool loop | `packages/agent/src/tool-loop.ts` `executeToolCall`; parallel batching in `packages/agent/src/chat.ts` | Unknown tools return `{ error: "Unknown tool: …" }`; `parallelSafe` tools may batch |
| Compaction | `packages/agent/src/history-compaction.ts` `compactHistory` | Structured Markdown summary; ChatGPT subscription owns native compaction via `managesContext` |
| Post-turn skill review | `packages/agent/src/skill-post-turn-review.ts`; `apps/server/src/services/skill-post-turn-review-service.ts` | Opt-in; org default is **off** (`skills_post_turn_review` default 0) |
| Skill consolidation | `packages/agent/src/skill-curator-consolidation.ts`; `apps/server/src/services/skill-curator-service.ts` | LLM merge of overlapping SKILL.md |
| `/learn` | `packages/agent/src/learn-prompt.ts`; `skill_manage` guidance in `buildChatSystemPrompt` | Distill sources into a profile skill; untrusted-source rules |
| DB memory | `apps/server/src/tools/memory-tools.ts` | `memory_write` uses `strategy: "preserve"` (exact reuse, not semantic upsert) |
| Conversation retrieval | `packages/db/src/conversation-keyword-search.ts` | Weighted lexical scan; `matchMode: "keywords"` |
| Skill FTS5 | `packages/db/src/skill-rank-fts5.ts` | In-memory FTS5 for **skill ranking only**, not memory |
| Runtime work rules | `packages/db/src/constants.ts` `DEFAULT_AGENT_WORK_RULES` | Includes “do not invent tools”; appended in `AgentService`, not in `buildChatSystemPrompt` |
| OpenCode Go provider | `apps/server/src/providers/opencode-go/` | Catalog + chat/messages/responses routing; live eval channel |

---

## Ranked gaps

Impact columns: **H** = tool-hallucination, **R** = multi-step reasoning, **C** = context-awareness, **L** = long-session behavior. Score 1–5.

### P0. OpenCode Go live path is unusable (missing `x-opencode-session`)

**Iteration 1 implements this.**

The gateway is OpenAI-compatible but **requires** `x-opencode-session` on chat/completions (HTTP 400 `MissingSessionID` otherwise). `createOpenCodeGoProvider` (`apps/server/src/providers/opencode-go/index.ts`) routes through:

- `createOpenAICompatibleProvider` (`apps/server/src/providers/openai-compatible/index.ts`) — `User-Agent` only
- `createAnthropicProvider` (`apps/server/src/providers/anthropic/index.ts`) — no session header
- `generateOpenAIResponsesChat` (`apps/server/src/providers/openai/responses.ts`) — `Authorization` + `User-Agent` only

`GenerateChatInput.conversationId` is already threaded from `generateReply` (`packages/agent/src/chat.ts`) via `toolContext.sessionId`, but OpenCode Go never maps it onto the HTTP header.

| H | R | C | L | Why first |
|---|---|---|---|---|
| 5 | 5 | 5 | 5 | Every live-eval dimension is zero until the real agent path can complete a turn |

Without this, Atlas cannot measure itself against Hermes/OpenClaw/Nakama on the chosen live channel.

### P0. Assigned-tool allowlist is not in the chat prompt

`buildChatSystemPrompt` names **some** tools when they are present (browser, spreadsheet, `skill_manage`, …) but never emits an explicit allowlist of this session’s tool names. Native function-calling schemas are the only complete catalog.

`DEFAULT_AGENT_WORK_RULES` says “Do not invent tools”, but that string is applied in `AgentService.resolveProfileSystemPrompt` → `appendRuntimeProfileRules`, not in the core prompt builder. A harness that calls `createAgentChatSession` without those rules (CLI, eval, tests) does not get the instruction.

Unknown-tool recovery exists (`executeToolCall` in `tool-loop.ts`) but the model still spends a turn, and there is no prompt-level “only these names exist” constraint.

| H | R | C | L |
|---|---|---|---|
| 5 | 3 | 2 | 2 |

**Next iteration candidate:** inject a short assigned-tool roster into `buildChatSystemPrompt` when `enableToolLoop` is true; keep schemas on the provider `tools` field.

### P1. Memory is file-injection + exact-match DB, not Hermes FTS5 + summarization

Hermes: FTS5 over memories with LLM summarization / consolidation as the learning substrate.

Atlas:

- `MEMORY.md` is dumped wholesale by `composeSoulSystemPrompt` (no budget, no summary, no retrieval)
- `memory_write` exact-reuses identical trimmed content (`MemoryService.writeMemory(..., { strategy: "preserve" })`) — not a semantic merge
- `search_chats` keyword ranking (`ConversationKeywordSearch`) scans authorized history in process; **no FTS5 virtual table for memories or transcripts**
- Skill FTS5 (`skill-rank-fts5.ts`) does not cover memory
- Database memory and `MEMORY.md` **do not sync**

| H | R | C | L |
|---|---|---|---|
| 1 | 3 | 5 | 5 |

**Next:** bounded MEMORY.md (summarize + archive), FTS5 (or equivalent) for `memory_search` / `search_chats`, optional LLM memory distill after long sessions.

### P1. Learning loop is opt-in and turn-local, not continuous

Hermes: always-on learning from traces into skills.

Atlas:

- `/learn` + `skill_manage` are strong (Nakama-grade) **when the user invokes them**
- Post-turn review (`generateSkillPostTurnReview`) is **off by default** (`resolveSkillPostTurnReviewEnabled` → org default false)
- Review output is create/patch/noop JSON; it does not write into model history (good) but also does not accumulate a learning curriculum
- No automatic “this tool-call pattern failed, update the skill” loop from `Unknown tool` / stalled `no_progress` stops (`SendStreamOptions.onToolLoopStop`)

| H | R | C | L |
|---|---|---|---|
| 3 | 4 | 3 | 3 |

**Next:** enable post-turn review for eval profiles; feed mechanical stops (`no_progress`, unknown-tool) into the curator.

### P1. Long-session compaction is structured but not retrieval-backed

`compactHistory` produces a fixed Markdown template (Goal / Constraints / Progress / …). That is better than naive truncation. Gaps vs Hermes:

- Compacted archives are not FTS-indexed for later `search_chats`
- Compaction is token-window triggered, not “learning distill”
- Native ChatGPT path bypasses Atlas compaction (`ProviderClient.managesContext`); other providers including OpenCode Go do not

| H | R | C | L |
|---|---|---|---|
| 1 | 3 | 4 | 5 |

### P2. Channel awareness: format rules exist; private/group kind does not reach the session

Nakama-style channel prompts are in `MESSAGING_CHANNEL_PROMPT` / `appendMessagingChannelPrompt`. `createAgentChatSession` (`packages/agent/src/chat.ts`) passes `channel` but **never `chatKind`**, so group vs private lines in `buildChatSystemPrompt` rarely fire. `AgentService` chat sessions similarly omit `chatKind`.

WhatsApp guest KB policy is real (`channel-guest-knowledge-base-policy.ts`) and stronger than OpenClaw’s generic gateway in that slice. The quality gap is **prompt fidelity** (group visibility, compact replies) not missing workers.

| H | R | C | L |
|---|---|---|---|
| 1 | 2 | 4 | 2 |

### P2. OpenClaw policy/sandbox vs Atlas process sandbox

Atlas: Landlock (`linux-landlock-abi3-v2`), `ATLAS_PROCESS_NETWORK`, profile `workspaceRoot` via `buildToolExecutionContext`. OpenClaw’s gateway policy language (per-channel allow/deny, skill trust tiers) is broader. This is mostly **safety**, but it also reduces tool hallucination when the model is told a tool is unavailable vs calling it and getting a sandbox error.

| H | R | C | L |
|---|---|---|---|
| 3 | 2 | 2 | 1 |

### P2. Skills ecosystem breadth

Atlas: bundled skills, profile SKILL.md, Composio, `skill_manage`, curator. OpenClaw’s public skill registry is larger. Quality impact is tool **selection** when the catalog is huge (`tool_search` exists but is optional).

| H | R | C | L |
|---|---|---|---|
| 3 | 3 | 2 | 2 |

### P3. Soul system (Nakama) — keep, don’t replace

`composeSoulSystemPrompt` + USER.md in `buildChatSystemPrompt` already match Nakama’s identity model. Guests skip MEMORY.md (`resolveProfileSystemPrompt`). Iteration work should **preserve** this and measure it, not rewrite it.

---

## Iteration 1 choice

**Ship:** send `x-opencode-session` on every OpenCode Go HTTP call (chat, messages, responses; prefer Atlas `conversationId` when present).

This is not a prompt tweak. It is the blocker for live evaluation of every other gap on the agreed channel (OpenCode Go). After it lands, iteration 2 should attack **assigned-tool allowlist + unknown-tool learning** (highest remaining H), then **memory retrieval/summarization** (highest remaining C/L).

## Eval coverage this iteration

`scripts/harness-eval/run.ts` drives `createAgentHarness` → `createChatSession` → `send()` (real `buildChatSystemPrompt` + `generateReply` + `executeToolCall` loop) with `createOpenCodeGoProvider`.

Scenarios: session transport, tool selection, tool avoidance (arithmetic + hallucinated name), multi-step tools, MEMORY.md recall, WhatsApp channel prompt + reply shape, two-turn context.

Honest limit: this path does **not** boot `AgentService` (no org middleware, no `appendRuntimeProfileRules` unless the eval injects them, no post-turn review, no DB memory_write). Soul is composed in-process. See the eval summary JSON `path` field.
