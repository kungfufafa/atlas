---
name: save-artifact
description: Save an artifact for live preview — HTML, SVG, Mermaid, React/JSX, Markdown, code, and office files (.docx, .xlsx, .pptx) under artifacts/. Use when producing dashboards, diagrams, reports, slides, or files the user would reopen.
include-body-on-match: true
---

Use this skill to save **durable deliverables** the user may reopen in the live preview panel.

- Use `artifacts/{filename}` paths relative to the profile workspace (e.g. `artifacts/report.md`).
- Do **not** save soul files (`SOUL.md`, `STYLE.md`, `INSTRUCTIONS.md`), `MEMORY.md`, or knowledge-base uploads here — those have their own locations and workflows.
- Prefer a file plus a short chat summary over pasting the full output in chat.

## When to use

Write under `artifacts/` whenever you produce something the user can open, preview, or download:

- Interactive or visual: `.html`, `.jsx`/`.tsx`, `.svg`, `.mmd`/`.mermaid`, substantial `.md`
- Source they would copy or rerun
- Office files via `write_docx`, `write_pptx`, or `spreadsheet` (also under `artifacts/`)
- Reports, summaries, logs, or structured notes they may revisit

Do not wait for the user to say "save" or "artifact". If it is the product of the request, it belongs under `artifacts/`.

This workflow is **text-only** for `write_file`. Images, PDFs, and other binary files need their dedicated tools (or download from a generated HTML/Word file).

## Metadata sidecar

After writing the artifact file, write a JSON sidecar at `artifacts/{filename}.atlas-meta.json` so the dashboard shows the correct MIME type and timestamp.

Example for `artifacts/report.md`:

```json
{
  "mimeType": "text/markdown",
  "savedAt": "2026-07-12T05:13:00.000Z",
  "sizeBytes": 1234
}
```

- `mimeType`: choose an accurate type (`text/markdown`, `text/plain`, `application/json`, `text/html`, etc.)
- `savedAt`: current time in ISO 8601 UTC
- `sizeBytes`: UTF-8 byte length of the artifact file content (not the sidecar)

## Workflow

1. Choose a short, descriptive filename under `artifacts/` (use subdirectories when grouping related files, e.g. `artifacts/weekly/report.md`).
2. `write_file` the artifact content with `deliverable: true` to `artifacts/{filename}`. If that name already exists, a date suffix is added automatically (e.g. `report-2026-07-14.md`). For Word / slides / Excel, use `write_docx` / `write_pptx` / `spreadsheet` instead of `write_file`.
3. For `write_file` outputs, also `write_file` the metadata sidecar with `deliverable: false` to `artifacts/{filename}.atlas-meta.json` using the same base filename from step 2.
Intermediate and support files use `deliverable: false` (or omit it). Editing a completed text deliverable with `edit_file` also requires `deliverable: true`.

4. Confirm the path in a short reply. On web chat, saved artifacts appear as chips with a live preview in addition to the profile **Artifacts** tab.

## MIME type guidance

| Content | mimeType |
|---------|----------|
| Markdown | `text/markdown` |
| Plain text / logs | `text/plain` |
| JSON | `application/json` |
| HTML | `text/html` |
| SVG | `image/svg+xml` |
| Source code | `text/plain` or a specific `text/x-*` when obvious |
