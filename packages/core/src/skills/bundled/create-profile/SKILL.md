---
name: create-profile
description: Create, design, or set up a new agent profile with soul files and appropriate tool assignments. Use when the user asks for a new profile, support agent, assistant, persona, or specialized agent.
include-body-on-match: true
---

When the user asks to create a profile, run a confirm-first factory — never call `create_profile` until they explicitly confirm the draft.

## 1. Clarify only when needed

Ask follow-ups only when purpose, audience, or permissions are materially unclear. Otherwise interpret the request concisely and move to the draft.

## 2. Draft in chat first

Post a reviewable draft before any tool call:

- Proposed **name** (the server generates the profile id from the name)
- Full proposed `SOUL.md` (who it is, values, help scope, boundaries)
- Full proposed `STYLE.md` (voice, tone, formatting)
- Full proposed `INSTRUCTIONS.md` (operating rules, tool posture, when to ask the user)
- `MEMORY.md` must be **empty**. Do not invent continuity facts, preferences, or history.

Write soul files for a **capable specialist**, not a junior or limited copy of Super Agent. `INSTRUCTIONS.md` must tell the agent to finish work in the turn with assigned tools (search, research, files, documents, slides, sheets, python) and to save durable deliverables under `artifacts/`. Super Agent remains the only orchestrator — do not invent profile/tool-authoring or bash capabilities.

Also include a **tool plan**:

- Server auto-assigns the Default Agent work toolkit on create when available: `web_search`, `web_fetch`, `deep_research`, `knowledge_base_search`, `browser`, file tools, `write_docx`, `write_pptx`, `spreadsheet`, `python_execute`, `tool_search`, plus default bundled skills (including `update-profile-memory`).
- Super Agent extras stay off unless the user asked: `bash`, `generate_image`, and profile/tool authoring.
- Recommend extra MCP, skills, or powerful tools from the available-tools context only when they clearly match the requested purpose.
- If a needed capability is missing after create, say so and ask the user to add a tool, skill, or MCP. Never invent a missing integration.

Never set `isSuper: true` unless the user explicitly asked for a super profile. Prefer refusing agent-initiated super creation and directing them to the dashboard.

Do not pass `systemPrompt` — identity lives in the soul files.

## 3. Wait for explicit confirmation

Always wait for a clear OK (for example “yes, create it”) even when the request looked complete.

If the user edits the draft, revise the draft in chat and wait for confirmation again. Do not call `create_profile` on edit-only messages.

## 4. Create only after OK

After confirmation, call `create_profile` with `name` and `soulFiles` for `SOUL.md`, `STYLE.md`, `INSTRUCTIONS.md`, and empty `MEMORY.md`. Do not pass `id` — the server assigns one from the name.

Then summarize:

- Profile id and name
- How to open it in the dashboard (Profiles → select the new profile)
- That the Default Agent work toolkit was auto-assigned, and any Super Agent extras still waiting on an explicit assign ask
