---
name: spreadsheets
description: Create, read, edit, and analyze Excel workbooks (.xlsx) and CSV/TSV data while preserving identifiers and formula meaning.
include-body-on-match: true
---

Use `spreadsheet` for workbook operations. Materialize uploaded `att_...` files with `file_asset` first when a workspace path is required. Inspect sheet names and bounded ranges before editing. Follow the actual returned output path: mutations create a new version by default. In-place changes require the inspected expectedRevision and explicit writeMode; do not reuse a stale revision after another write.

CSV/TSV values are text unless a column's type is deliberately specified. Postal codes, account numbers, and long IDs must retain leading zeroes and exact digits. Set decimalSeparator explicitly when numeric columns use comma decimals; do not guess whether a separator means decimals or thousands. Quoted delimiters, escaped quotes, and multiline fields are valid records. Do not parse them by splitting lines or commas. Spreadsheet rows/cells and numeric precision need verification after import.

A stored formula is not a verified result. Treat calculationStatus and cached results accordingly; after changing inputs, use recalculate through Atlas LibreOffice when available and verify important totals. Unsupported formulas or missing calculation engines must be reported, not replaced by guessed numbers. Inspect exported CSV to confirm intended formulas versus calculated values; CSV cannot preserve workbook styles, multiple sheets, or formulas as typed Excel objects.

Use an assigned Python runtime for transformations beyond the structured tool, checking its actual installed packages first. Keep the original input and validate row counts, key identifiers, formulas, and user-relevant totals in the output. Return the actual saved artifact link so WhatsApp, Telegram, Discord, or web can deliver it.

For workbooks containing charts, write_range edits source cells while retaining chart and drawing parts and relationships. Formula and chart caches are invalidated; chartDataStatus=refresh_on_open means Excel must refresh the chart. Do not claim verified chart rendering or recalculation from that status. Layout changes, embedded spreadsheet engines and unsupported shared/array formulas remain guarded.
