---
name: presentations
description: Create, read, and edit PowerPoint presentations (.pptx), including decks uploaded in chat.
include-body-on-match: true
---

Use `write_pptx` for a new deck. For an existing deck, `office_document inspect/read/edit` works directly on the source PPTX and preserves unrelated slides, masters, media, and relationships. Slide units follow presentation order, which may differ from archive filenames. Read the relevant unit before choosing paragraph or table coordinates and expected text.

Use original `att_...` references or workspace paths. `file_asset materialize` is available when a compute tool needs the exact source file. Text and tables are readable; diagrams, charts, and images require visual inspection for their meaning. Continue paginated reads before making claims about the entire deck.

After editing, read the resulting new artifact and verify the targeted content and slide count. `pdf_document convert` uses Atlas LibreOffice for a rendered PDF when available; review slide layout for overflow, clipped text, and missing images with a visual tool. Text-only checks are not visual verification. Return a link using the tool's actual PPTX output path for channel delivery, preserving the original file.
