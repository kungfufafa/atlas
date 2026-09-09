# Existing harness inventory (Atlas + pinned Hermes)

Recorded 2026-09-09 before scored runs. No new eval framework invented here.

## Atlas

| Path | Entry | Live LLM | Comparison use |
|---|---|---|---|
| `scripts/channel-loop-harness/` | `bun run atlas:channel-loop` / `bun test` (`test:smoke`) | No (mock) | Skip — channel plumbing |
| `scripts/live-human-e2e/run.ts` | `bun run atlas:live-human-e2e` | Yes | Task texts scored |
| `scripts/live-human-e2e/run-opencode-go-deepseek.ts` | `bun run scripts/live-human-e2e/run-opencode-go-deepseek.ts` | Yes | Prompts reused; 55‑min soak not scored |
| `scripts/live-human-e2e/hour-opencode-go.ts` | `bun run scripts/live-human-e2e/hour-opencode-go.ts` | Yes | `write_file` + `coding_agent` prompts reused; 1h loop not scored |
| `scripts/production-readiness/` | `bun run atlas:production-readiness` | No (simulated) | Skip |
| `scripts/release-gate/` | `bun run atlas:release-gate` | Mock; optional TokenRouter | Skip |
| `scripts/e2e-critical-paths.test.ts` | `bun test scripts/e2e-critical-paths.test.ts` | No | Skip |
| `scripts/e2e-product-journeys.ts` + `e2e-phase*.ts` | `bun test` / `bun run` | Yes (Playwright UI) | Skip scored matrix (Atlas UI + hardcoded login) |
| `apps/server/src/testing/llm-msw-cassette.ts` + `*.llm.test.ts` | `bun test` / `LLM_VCR_MODE` | Replay default | Skip — not live |
| Coding-agent OpenCode path | Super Agent `bash` + `coding-agent` skill | Yes if CLI present | Scored as `coding_agent` |

Cassette files (replay, not live scored):

- `apps/server/src/tools/todo-tools.llm.test.ts`
- `apps/server/src/tools/ask-user-question-tool.llm.test.ts`
- `apps/server/src/tools/super-agent-create-profile.llm.test.ts`
- `apps/server/src/tools/super-agent-create-automation.llm.test.ts`
- `apps/server/src/services/image-generation.llm.test.ts`
- `apps/server/src/services/image-vision-fallback.llm.test.ts`
- `apps/server/src/services/audio-transcription.llm.test.ts`
- `apps/server/src/providers/capabilities/executors/media-providers.llm.test.ts`

## Hermes (`v2026.9.7` / `2237be355906fbe6065ce1815711eee52b2d646e`)

| Path | What it is | Comparison use |
|---|---|---|
| `evals/` | Wire/unit probes (gateway, compaction, browser_use, memory, …) | Skip as scored OpenCode Go cells |
| `scripts/tool_search_livetest*.py` + `LIVETEST_README.md` | Live OpenRouter/Haiku tool-search | Skip — wrong provider |
| `run_agent.py` `AIAgent` | One-shot conversation runner (`base_url`, `api_key`, `model`) | Hermes agent for registered tasks |
| `cli-config.yaml.example` | `provider: custom` + `base_url` for OpenAI-compatible | Isolation config pattern |

Hermes is not in this repo. Checkout lives outside the Atlas tree
(`/tmp/atlas-eval/hermes-agent`) so it is not committed.
