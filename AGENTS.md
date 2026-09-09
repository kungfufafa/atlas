# atlas — Agent Context

Agent platform built to work with your team — not replace them. Multi-tenant monorepo; orgs are flat tenants, each profile has a **soul** (identity, style, instructions, memory).

> **Fork Notice**: Atlas is a rebranded fork of [Nakama](https://github.com/ahmadrosid/nakama) by [ahmadrosid](https://github.com/ahmadrosid).

## Dev

- Bun 1.3+: `bun install`, `bun run`, `bun test`
- Servers: `bun run dev:server` | `dev:web` | `dev:cli` | `dev:mobile`
- Layout: `apps/{server,web,cli,mobile}`, channel workers in `apps/platform/{telegram,whatsapp,discord,automation}`
- Writing Tests: assert behavior, not prompt/description/error copy.

## Mobile (`apps/mobile`)

Expo SDK 57 in the Bun workspace. Metro and native builds already use Expo
Autolinking (`autolinkingModuleResolution`; iOS `use_expo_modules!`).
`expo-modules-autolinking verify` warns about nested `expo-constants`
(`57.0.16` at the workspace root vs `57.0.15` under `expo-asset` and
`expo-linking`). Do **not** hide that with LogBox, Metro `blockList` /
`disableHierarchicalLookup`, a one-off `overrides` entry, or deleting
`bun.lock`. It is not a broken autolink; clearing it needs a
workspace-wide Bun linker migration and TypeScript alignment (mobile
declares `typescript ~6.0.3`; root typecheck uses `5.9.3` and excludes
`apps/mobile`). See `docs/adr/0003-mobile-stack.md`.

## LLM cassette tests (MSW)

For live provider tests: record one real HTTP call, commit the cassette, replay offline thereafter. Helper: `apps/server/src/testing/llm-msw-cassette.ts` (`withMswCassette`). Cassettes live in `apps/server/src/testing/cassettes/`. Name live tests `*.llm.test.ts`.

```bash
bun test path/to/foo.llm.test.ts                 # replay (default when cassette exists)
LLM_VCR_MODE=record bun test path/to/foo.llm.test.ts  # re-record (needs provider API key)
```

## GitHub

Use `gh` for issues, PRs, checks, reviews, releases, and any GitHub URL. Run the gh cli command outside the sandbox so that the auth can works.

## Browser automation & QA Verification

Mandatory QA step for UI / web changes:
1. Use `agent-browser` (or browser subagent) to verify the live UI against real user flows.
2. Verify interactive form states, dropdowns, modal dialogs, and save flows to catch race conditions, spinner lockups, and caching bugs that unit tests cannot detect.
3. Take screenshots of before/after UI states to confirm visual correctness.
4. Run against local dev server (`http://localhost:3000` or `http://localhost:4310`).

## Documentation (`docs/website`)

User-facing docs live in `docs/website/content/docs/` (MDX). **Audience is people who use Atlas** — org admins, operators, and chat users — not contributors implementing the product.

When writing or updating docs, prioritize:

1. **Why** — what problem the feature solves and when someone should care
2. **Value** — what gets better (safety, consistency, less repeat work, team control)
3. **How to use it** — UI paths, steps, roles, and screenshots for flows; plain language over jargon

Keep contributor detail out of user docs unless it directly helps usage (e.g. env vars for self-hosting). Prefer dashboard navigation names (**System → Organization**) over route paths; put schema, service names, file paths, and HTTP API tables in `AGENTS.md` or code comments, not in product docs unless the page is explicitly for integrators.

Match existing pages: task-oriented headings, tables for roles/options, screenshots under `docs/website/public/screenshots/` (`![alt](/screenshots/foo.png)`), capture scripts in `docs/website/scripts/capture-*.sh`. Cross-link related concepts (e.g. skills ↔ org memory) instead of duplicating internals.


One container: API + web + platform workers. Data at `/atlas/data` (`ATLAS_CONFIG_DIR`). Dashboard: http://localhost:4310

```bash
# Prebuilt
docker pull ghcr.io/kungfufafa/atlas:latest
docker run -d -p 4310:4310 -v atlas-data:/atlas/data --name atlas ghcr.io/kungfufafa/atlas:latest

# Build from source and run (uses buildx; default linux/amd64 -t atlas)
./scripts/docker-build-run.sh

# Fresh start (removes container, volume, image)
./scripts/docker-destroy.sh
./scripts/docker-build-run.sh
```

## Multi-tenancy

Orgs isolate profiles, sessions, automations, tasks, tools, MCP, skills, usage (`org_id` — see `packages/db/sql/schema.sql`, `migrateTenantOrgScope`).

| Role | Can |
|---|---|
| Platform admin | Create/manage orgs (`/v1/platform/orgs`); after switching, same in-workspace admin as org admin; host export/install/public URL |
| Org admin | Full admin of that workspace: members, Super Agent, profiles, tools/MCP/skills, providers, channels |
| Org member | Chat, agents, automations/tasks |
| Org viewer | Read chat only — no agent invoke / mutations |

**Org context:** every authed call except `/v1/auth/*` and `/v1/platform/*` needs `X-Org-Id` (`@atlas/client`) or `active_org_id` cookie (`POST /v1/auth/active-org`). Middleware: `org-middleware.ts`; guards: `org-guards.ts`.

**Onboard:** setup → `POST /v1/auth/setup`; more orgs → platform admin; invite → `/v1/orgs/{orgId}/invites` + `POST /v1/auth/accept-invite`; switch → `OrgSwitcher.tsx` / `client.setActiveOrg()`.

| Change | Where |
|---|---|
| Org CRUD / invites / members | `apps/server/src/services/org-service.ts` |
| Platform org routes | `apps/server/src/http/routes/platform-orgs.ts` |
| Member routes | `…/routes/org-members.ts` |
| Auth / active-org | `…/routes/auth.ts` |
| DB types / SQLite | `packages/db/src/{types.ts,adapters/sqlite.ts}` |
| Contracts | `packages/core/src/contract.ts` |
| Client `X-Org-Id` | `packages/client/src/client.ts` |
| Web auth / switcher | `apps/web/src/context/auth-context.tsx`, `OrgSwitcher.tsx` |

## Subscription providers (ChatGPT / Claude)

Model metadata is scoped to the exact provider instance, endpoint, and model ID. Discovery/configuration must preserve context/output limits, native effort values/defaults, explicit `false`, and empty effort lists. Missing fields mean unknown; do not infer capabilities from names, copy another provider's catalog, or supply generic 128k/8k limits. OpenAI API's ID-only model list is enriched only on its official endpoint using exact, documented entries in `providers/openai/model-metadata.ts`. Anthropic/Gemini use native model APIs; compatible gateways use advertised fields; Ollama uses configured/running context rather than trained model capacity. Runtime-managed subscription context takes precedence over catalog limits and bypasses Atlas automatic compaction. Explicit manual compaction remains available when limits are unknown.

Adapter transport support does not prove model support: optional model features stay unknown without provider/configuration evidence or an exact official-endpoint documentation entry. Native ChatGPT/Claude runtimes guarantee their tool bridge separately. Connection changes invalidate prior discovered metadata. Keep selected model IDs stable; unavailable explicit selections must fail with an actionable error instead of switching models. Anthropic/Gemini input-only limits are already usable input budgets; do not subtract output capacity from them a second time.

API-key providers (`openai`, `anthropic`) stay unchanged. Subscription access is separate catalog types:

- `chatgpt` — Bundled `@openai/codex` app-server owns ChatGPT OAuth, account/plan, models, and thread/turn execution in the isolated `~/.atlas/subscription-auth/chatgpt` Codex home. Atlas never copies `~/.codex` tokens or loads host Codex tools/MCP/settings.
- `claude` — Bundled `@anthropic-ai/claude-agent-sdk` native CLI + Agent SDK. Atlas never copies `~/.claude` tokens and unsets `ANTHROPIC_API_KEY` for this path so API billing cannot silently replace the subscription.

Routes: `/v1/subscription/{chatgpt|claude}` (status, login, logout, models). Adapters: `apps/server/src/providers/subscription/`. Atlas session id maps to the runtime session in `~/.atlas/subscription-sessions.json`.

**ChatGPT context:** `thread/tokenUsage/updated` supplies the effective `modelContextWindow` and current occupancy (`last.totalTokens`). Keep this separate from token usage totals; do not subtract an output reserve again. Codex `model/list` does not advertise context limits, so context stays unknown until the runtime reports it. ChatGPT sets `ProviderClient.managesContext`: preserve it through wrappers to let Codex own automatic compaction. Explicit Atlas compaction still works and invalidates the native snapshot.

**Native usage and identity:** Successful and failed ChatGPT turns use explicit completion counters only; occupancy and cumulative snapshots never substitute for per-turn usage. Missing or partial native counters stay unknown. `providers/failure-evidence.ts` retains process-local, non-executable diagnostic snapshots through original error/cause objects. Once a native turn completes, its evidence takes precedence over stale evidence on a reused callback error. Cleanup errors retain their existing precedence. Claude `modelIdentity` uses exact reported IDs or an advertised `resolvedModel`; unresolved advertised aliases remain explicitly unverifiable. No model-name inference or silent replacement is allowed.

**Usage provenance:** Platform-global and per-model tracker stats distinguish reported, estimated, unknown and legacy/unclassified outer provider invocations. Native runtimes may make additional internal requests. Numeric token/cost fields remain recorded subtotals; provenance does not certify billing or extend to existing daily/org/optimizer reports. Persistence remains asynchronous and is not an atomic global/model transaction.

## System prompt

Merged in `agent-service` `resolveProfileSystemPrompt` → `generateReply` (`provider.generateChat` / `streamChat`):

| Change | File | Fn |
|---|---|---|
| Chat structure (USER.md, tools, timezone, channels) | `packages/agent/src/chat-prompt.ts` | `buildChatSystemPrompt` |
| Soul content | `packages/core/src/soul/compose.ts` | `composeSoulSystemPrompt` |
| Skills catalog / matched / agent-browser | `packages/core/src/skills/compose.ts` | `composeSkillsCatalog`, `composeMatchedSkillsPrompt`, `composeAgentBrowserCapabilityPrompt` |
| Per-turn context (date, etc.) | `packages/agent/src/chat.ts` | `generateReply` |

## Soul (`packages/core/src/soul/`)

Path: `~/.atlas/orgs/{orgId}/profiles/{profileId}/` (`getProfileSoulDir`). Load: `loadSoulStack()`; inject: `composeSoulSystemPrompt()`.

| File | Role |
|---|---|
| `SOUL.md` | Identity |
| `STYLE.md` | Voice |
| `INSTRUCTIONS.md` | Operating rules |
| `MEMORY.md` | Cross-session facts |

## Tools (`packages/core/src/tools/`)

| Tool / skill | Notes |
|---|---|
| `update-profile-memory` / `archive-profile-memory` | MEMORY.md ↔ memory-archive/ |
| `save-artifact` | Persist under `artifacts/` |
| `knowledge_base_search` / `web_search` / `email` | KB, web, mailbox |
| `search_files` / `ripgrep` | File/content search |
| `bash` | Profile workspace shell — assign per profile; Super Agent by default |
| `sub_agent` | Opt-in same-profile delegate (not repo coding) |
| `coding-agent` | Codex / Claude Code / OpenCode / pi / Cursor Agent (`agent`) via `bash` |
| `agent-browser` | Opt-in browser CLI; needs host install — `docs/website/agent-browser.md` |
| `create-profile` | Super Agent only, confirm-first — `apps/server/src/tools/super-agent-tools.ts` (`create_profile`, tenant-safe `update_profile`) |
| `skill_manage` | Interactive web/cli with `manage-skills` — create/patch/edit/delete profile skills + supporting-file write/remove + auto-assign (`apps/server/src/tools/skill-manage-tool.ts`). When org/profile **write approval** is enabled, mutations stage as proposals for org-admin review instead of writing immediately. When present, file tools refuse any path under `skills/*/` (`forbidProfileSkillMarkdownWrites`). Not injected for automations or Telegram/WhatsApp/Discord. Opt-in **post-turn skill review** (`skills_post_turn_review`) may suggest or stage create/patch after complex turns without writing into model history. |
| Composio | Org toolkits + per-user OAuth — `docs/website/composio.md` |

**Database memory saves:** Native `memory_write` selects `MemoryService.writeMemory(..., { strategy: "preserve" })`. It atomically reuses exact trimmed content with the same normalized subject, org, owner and scope; changed facts remain separate even under one subject. Exact reuse preserves existing metadata. Use `memory_update` by ID for corrections, withdrawals and metadata changes, and ordinary approval-gated deletion for erasure. The legacy service/LearningPlane upsert remains unchanged. Exact lookup scans the authorized bucket under a SQLite write transaction; this is not a semantic contradiction resolver or an unbounded-scale performance guarantee. Database memory and active `MEMORY.md` do not synchronize automatically.

**Native memory ownership:** New `memory_write` calls support `user` (default), `agent`, and `organization`, with owners derived from trusted execution context. New project writes or supplied `projectId` fail before persistence. Legacy project storage remains; explicit project reads/updates/deletes are limited to the current session owner. Arbitrary-owner legacy rows are neither migrated nor silently reassigned to a broader audience. Implementation: `apps/server/src/tools/memory-tools.ts`.

**Conversation retrieval:** Native `search_chats` uses the database's `matchMode: "keywords"` for weighted lexical matching across authorized history, ranking before the result limit. Existing callers retain default literal matching. Both adapters preserve original text/scalar types through archive search and transcript retrieval, including JSON-looking strings. Query and result limits do not bound total history scanning. Implementations: `packages/db/src/conversation-keyword-search.ts` and `apps/server/src/tools/conversation-tools.ts`.

**Channel work files (WhatsApp/Telegram/Discord):** `packages/core/src/attachments/inbound-document.ts` saves every authorized original through `saveInboundWorkspaceDocument`; it never substitutes inline office text or guest previews. `prepareChannelImage` also passes validated real image bytes; `prepareChannelAudio` saves accepted audio before the existing transcription call. Ingest ceilings: documents/audio 25 MiB (hosted Telegram downloads 20 MiB), images 5 MiB. Legacy XLS/XLSB use the existing managed Office converter to read/export XLSX; XLSM is read passively with VBA stripped from generated XLSX. Sources remain untouched. Persistence follows current channel authorization, not pairing. Channel sessions include standard file tools for older profiles; guest principals receive only artifact-confined spreadsheet/extract/read/write/DOCX/PPTX tools, never profile memory, arbitrary Python/Bash, MCP, or other assigned tools. Tool allowlists and current RBAC still apply. Implementation: `apps/server/src/services/channel-work-file-tools.ts` and `channel-guest-tool-policy.ts`.

**Channel artifacts:** `packages/core/src/channel-artifacts.ts`, `channel-artifact-delivery.ts`; handlers in `apps/platform/{whatsapp,telegram,discord}/src/channel-artifact-flow.ts`. Originals are input references; only completed tool outputs enter normal artifact delivery.

## Tool execution & workspace

Path bugs (tool resolves under repo instead of `~/.atlas`) → start here. Override root: `ATLAS_CONFIG_DIR`.

| Path | Purpose |
|---|---|
| `~/.atlas/orgs/{orgId}/profiles/{profileId}/` | Profile workspace — `getProfileSoulDir()` |
| `~/.atlas/tools/*.js` | Custom JS tools — `getCustomToolsDir()` |

Always build context with `buildToolExecutionContext()` (`packages/core/src/tools/context.ts`) so `workspaceRoot` = soul dir. Custom JS tools must use `context.workspaceRoot`, **not** `process.cwd()`.

**Python/Bash network policy:** the host can set `ATLAS_PROCESS_NETWORK=deny` to block all networking inside their existing required macOS process sandbox, including descendants. The default is `allow`. Tool-supplied environment values cannot override this host setting. Invalid values and `deny` on platforms without full enforcement fail closed. This setting covers arbitrary Python/Bash execution only; it does not restrict provider traffic, custom JS tools, dedicated document workers, or other server tools. Implementation: `apps/server/src/services/restricted-process.ts`.

| | Built-in | Custom JS |
|---|---|---|
| Code | `packages/core/src/tools/`, `apps/server/src/tools/` | `~/.atlas/tools/*.js` |
| Workspace | `getProfileSoulDir` inside handler | `context.workspaceRoot` |
| Loader | builtins map | `javascript-tool-loader.ts` |

| Flow | Entry |
|---|---|
| Chat | `agent-service` → `buildChatSession()` → `buildToolExecutionContext(...)` |
| Tool loop | `packages/agent/src/tool-loop.ts` → `executeToolCall()`; parallel batching in `packages/agent/src/chat.ts` when every call in the turn is `parallelSafe` |

**Parallel tool calls:** Built-in read/search/fetch tools (`read_file`, `search_files`, `knowledge_base_search`, `web_search`, `web_fetch`) set `parallelSafe: true` on `ToolDefinition`. Mutating, shell, delegation, and session-state tools stay sequential. Custom JS tools default to sequential; export `parallelSafe: true` from the module to opt in. When a turn mixes parallel-safe and sequential tools, the whole turn runs sequentially.

**Incomplete API responses:** Chat Completions `length` errors retain diagnostic fragments and reported usage in `IncompleteCompletionError`; fragments are never executable tool calls or valid conversation history. The chat loop permits one concise continuation from completed history across the whole turn, including forced finalization. It refuses recovery after visible response/tool-draft output, native runtime dispatch or context management, cancellation, transport failure, or a second truncation. `onIncompleteCompletion` on send/stream options is diagnostic only. Known failed usage is counted; missing usage is not guessed. This recovery covers the OpenAI wire adapters; Responses, subscription runtimes, Anthropic and Gemini retain their existing retry behavior.

**Mechanical task stops:** `SendStreamOptions.onToolLoopStop` reports `no_progress` or `iteration_limit` once per invocation, including a native runtime's rejected additional dispatch. Observer failures cannot replace generation/finalization errors. `AgentService.runTaskPrompt` forwards the observer; TaskRunner retains available output and marks these runs `failed` using the existing public task shape. This is not a general verifier of semantic task completion, and it adds no model generation.

| Flow | Entry |
|---|---|
| Playground | `POST /v1/tools/:toolId/run` → `runToolPlayground()` (`resolvePlaygroundProfileId`) |
| Param suggest | `POST /v1/tools/:toolId/params/suggest` |

**Debug:** (1) check path resolution in `~/.atlas/tools/`, (2) confirm `buildToolExecutionContext` + real `profileId`, (3) monorepo-root paths ⇒ missing `workspaceRoot`, (4) put test files in the assigned profile workspace. Super Agent authoring rules: `SUPER_AGENT_SYSTEM_PROMPT` in `packages/db/src/constants.ts`. Non-super work quality: `DEFAULT_AGENT_WORK_RULES` (appended at runtime). New profiles get `DEFAULT_AGENT_TOOL_IDS`, not Super Agent extras (`bash`, `generate_image`).

**Playground UI:** `/system/playground/:toolId` — `ToolPlaygroundPage.tsx`, `ToolPlaygroundPanel.tsx`; admin-only via `canUseToolPlayground()`.

## Packages & server

- `packages/core` — soul, tools, skills, contracts
- `packages/agent` — chat loop, prompts, compaction
- `packages/db` — DB
- `packages/client` — API client

Server: Hono in `apps/server/src/http/app.ts`. Middleware: auth → org → routes (`routes/*`). OpenAPI from `openapi.ts` (`/openapi.json`). Platform-admin-only: org CRUD (`/v1/platform/orgs`), data import/export, public web URL, host worker/install, Super Agent profile creation (`isSuper`). Org admin is the full in-workspace operator (profiles, tools, MCP, skills, members, channels). Viewers blocked by `requireNotViewer` on worker control and agent invoke.

## Developing 

Remember this when working on react code:

- UI descriptions: Do not add subtitles, helper text, or descriptive copy beneath headings, labels, cards, or settings by default. Prefer one concise, self-explanatory heading or label. Only add supporting copy when the user explicitly asks for it or when it is necessary to prevent misunderstanding or error, and never use it to restate the heading.


# Ultracite Code Standards

This project uses **Ultracite**, a zero-config preset that enforces strict code quality standards through automated formatting and linting.

## Quick Reference

- **Format code**: `bun x ultracite fix`
- **Check for issues**: `bun x ultracite check`
- **Diagnose setup**: `bun x ultracite doctor`

Biome (the underlying engine) provides robust linting and formatting. Most issues are automatically fixable.

---

## Core Principles

Write code that is **accessible, performant, type-safe, and maintainable**. Focus on clarity and explicit intent over brevity.

### Type Safety & Explicitness

- Use explicit types for function parameters and return values when they enhance clarity
- Prefer `unknown` over `any` when the type is genuinely unknown
- Use const assertions (`as const`) for immutable values and literal types
- Leverage TypeScript's type narrowing instead of type assertions
- Use meaningful variable names instead of magic numbers - extract constants with descriptive names

### Modern JavaScript/TypeScript

- Use arrow functions for callbacks and short functions
- Prefer `for...of` loops over `.forEach()` and indexed `for` loops
- Use optional chaining (`?.`) and nullish coalescing (`??`) for safer property access
- Prefer template literals over string concatenation
- Use destructuring for object and array assignments
- Use `const` by default, `let` only when reassignment is needed, never `var`

### Async & Promises

- Always `await` promises in async functions - don't forget to use the return value
- Use `async/await` syntax instead of promise chains for better readability
- Handle errors appropriately in async code with try-catch blocks
- Don't use async functions as Promise executors

### React & JSX

- Use function components over class components
- Call hooks at the top level only, never conditionally
- Specify all dependencies in hook dependency arrays correctly
- Use the `key` prop for elements in iterables (prefer unique IDs over array indices)
- Nest children between opening and closing tags instead of passing as props
- Don't define components inside other components
- Use semantic HTML and ARIA attributes for accessibility:
  - Provide meaningful alt text for images
  - Use proper heading hierarchy
  - Add labels for form inputs
  - Include keyboard event handlers alongside mouse events
  - Use semantic elements (`<button>`, `<nav>`, etc.) instead of divs with roles

### Error Handling & Debugging

- Remove `console.log`, `debugger`, and `alert` statements from production code
- Throw `Error` objects with descriptive messages, not strings or other values
- Use `try-catch` blocks meaningfully - don't catch errors just to rethrow them
- Prefer early returns over nested conditionals for error cases

### Code Organization

- Keep functions focused and under reasonable cognitive complexity limits
- Extract complex conditions into well-named boolean variables
- Use early returns to reduce nesting
- Prefer simple conditionals over nested ternary operators
- Group related code together and separate concerns

### Security

- Add `rel="noopener"` when using `target="_blank"` on links
- Avoid `dangerouslySetInnerHTML` unless absolutely necessary
- Don't use `eval()` or assign directly to `document.cookie`
- Validate and sanitize user input

### Performance

- Avoid spread syntax in accumulators within loops
- Use top-level regex literals instead of creating them in loops
- Prefer specific imports over namespace imports
- Avoid barrel files (index files that re-export everything)
- Use proper image components (e.g., Next.js `<Image>`) over `<img>` tags

### Framework-Specific Guidance

**Next.js:**
- Use Next.js `<Image>` component for images
- Use `next/head` or App Router metadata API for head elements
- Use Server Components for async data fetching instead of async Client Components

**React 19+:**
- Use ref as a prop instead of `React.forwardRef`

**Solid/Svelte/Vue/Qwik:**
- Use `class` and `for` attributes (not `className` or `htmlFor`)

---

## Testing

- Write assertions inside `it()` or `test()` blocks
- Avoid done callbacks in async tests - use async/await instead
- Don't use `.only` or `.skip` in committed code
- Keep test suites reasonably flat - avoid excessive `describe` nesting

## When Biome Can't Help

Biome's linter will catch most issues automatically. Focus your attention on:

1. **Business logic correctness** - Biome can't validate your algorithms
2. **Meaningful naming** - Use descriptive names for functions, variables, and types
3. **Architecture decisions** - Component structure, data flow, and API design
4. **Edge cases** - Handle boundary conditions and error states
5. **User experience** - Accessibility, performance, and usability considerations
6. **Documentation** - Add comments for complex logic, but prefer self-documenting code

---

Most formatting and common issues are automatically fixed by Biome. Run `bun x ultracite fix` before committing to ensure compliance.
