---
name: word-documents
description: Create, read, and edit Word documents (.docx), including reports and edits to an uploaded template.
include-body-on-match: true
---

Use `write_docx` with Markdown for a new document. Use `office_document` for an existing DOCX: inspect it, read the relevant paragraphs/tables, then edit the original with exact-match checks. This preserves other archive parts, images, relationships, and formatting; recreating an uploaded template from extracted text discards those features.

Attachment `att_...` references work directly with `office_document`. `file_asset materialize` makes a byte-identical workspace copy when another tool needs a path. Read coverage identifies content outside the reader's scope; text extraction does not establish visual layout.

For edits, use paragraph/unit coordinates returned by read and set expectedMatches or expectedText from the actual source. Read the returned new artifact to verify the changed content. Keep the original unless the user requests its replacement. Edits within an existing insertion create new tracked deletions and insertions, retaining earlier reviewer history. Set trackChanges=true to track ordinary text edits too; revisionAuthor defaults to Atlas. Reads show current text without deleted history. Do not silently accept or reject previous revisions. Tracked moves, fields, or complex text objects still require another suitable document engine.

For a formatted deliverable, `pdf_document convert` can render the DOCX using Atlas LibreOffice. Check the rendered layout when visual inspection tools are available; if only structure/text was verified, say so. Return the actual path from the successful write, e.g. `[Download Word](artifacts/report.docx)`, so web and channel artifact delivery can find it. Do not guess an output filename or claim that a channel sent the file before delivery succeeds.
