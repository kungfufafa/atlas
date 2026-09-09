# Daily files and harness validation

Date: 2026-09-06. **Production maturity and platform parity are not established.**
The deeper audit found defects beyond the earlier selected tests. See the
[complete validation ledger](deep-validation-run.md), [21-case independent
corpus](daily-files-corpus.md), and [harness/channel audit](harness-channel-deep-audit.md).
Python still has host filesystem access; this blocks a tenant-isolated deployment
claim. Refused operations, mock transport and missing authentication are not
successful daily workflows.

## Implemented operation matrix

| Pack | Implemented operations | Verification and limits |
| --- | --- | --- |
| Word DOCX | Create from Markdown, inspect/read existing files, replace text across runs, edit simple table cells | Real images and links; existing unrelated ZIP parts preserved byte-for-byte. Indexed body/header/footer units. Unsupported tracked changes, fields, complex merged cells, or package features are refused for affected edits. |
| PowerPoint PPTX | Create decks, inspect/read in presentation order, edit text, tables, speaker notes | Preserve masters/media/relationships and untouched slides. Read results identify text-only coverage; charts, diagrams, animations and layout changes are not general editing operations. |
| PDF | Create text PDFs, convert Office to PDF, inspect, merge, split page groups, extract text and ordinary stored form values | Bounded PDF.js worker reads real LibreOffice text. Page and field coverage are independent and paginated. No OCR; unsupported form types/XFA remain incomplete. Page copying refuses forms/signatures, bookmarks, embedded attachments and internal navigation; document metadata is not preserved. |
| Excel XLSX | Create, inspect, read/write ranges, style, sheets, import/export, recalculate | Versioned output by default. Formula descriptors distinguish pending calculation, unverified caches and verified LibreOffice results, including formula errors. Detected unsupported workbook features restrict the tool to metadata inspection; see the guard details below. |
| CSV | Lossless parsing, explicit column conversion, workbook import, create/edit/export | Leading zeroes, long IDs, quotes and multiline fields survive. Formula-like text is escaped for spreadsheet opening by default; explicit literal export is available and the escaped cell count is reported. Comma, semicolon and tab delimiters are supported; the spreadsheet tool currently requires a `.csv` extension for delimited files. |
| General data | TXT/Markdown/JSON/JSONL/TSV attachments and assigned Python analysis | Model excerpts are bounded. Exact original bytes remain available through references and workspace materialization. Python package presence is an actual runtime property. |

XLSX guards detect charts, pivot tables, slicers/timelines, external data
connections, embedded objects/controls, custom XML or nonempty custom properties,
threaded comments, data models, macro sheets, drawing shapes and extended worksheet
features. `inspect` can report sheet metadata and the unsupported features;
`read_range`, edits, export and recalculation refuse these workbooks before an
ExcelJS roundtrip can discard their contents. This guard is conservative and does
not prove preservation of every possible Excel feature. The empty custom-properties
part emitted by ordinary LibreOffice recalculation is allowed.

Recalculation rejects external data relationships and external-data formulas,
including defined names. It uses an isolated LibreOffice profile with macros and
link refresh disabled, a timeout and cancellation. Edited inputs invalidate formula
caches; cached values from an unrelated or externally modified workbook remain
explicitly unverified. CSV value export requires verified recalculation.

## One execution lifecycle

The file engines are ordinary registered `ToolDefinition`s. API tool calls and
structured SDK callbacks use the same schema validation, permissions, approval,
execution, cancellation, tool history, checkpoint and artifact boundary. File
operations do not select a model provider or enable a provider's native tools.

`office_document`, `pdf_document`, and `file_asset` join the existing builtin
registry and protected IDs. New default profiles receive them; existing custom
profile tool choices are preserved. Four bundled skills explain how to use the
engines and verify results. A skill cannot supply an absent runtime.

Codex registers the actual Atlas JSON schemas using dynamic tools. Claude now
registers the same catalog through a dedicated in-process SDK MCP server. Native
host tools/settings remain explicitly scoped. `native` continues to mean
upstream evidence; assignment and per-action permission remain separate.
See [ADR 0004](../adr/0004-structured-runtime-tool-bridge.md).

## File continuity and delivery

- Inline files keep scoped `att_...` references. Provider rehydration now exposes
  the reference alongside the content. Compaction retains a deterministic file
  manifest independently of the model's summary wording.
- `file_asset materialize` writes byte-identical inputs to `.sources/`, outside
  automatic artifact delivery. Document tools can consume references directly.
- New results are published atomically under `artifacts/` without overwriting
  existing files. Result artifacts carry names, MIME types, sizes and session IDs.
- WhatsApp, Telegram and Discord use one inbound document helper. Inline files
  remain limited to 5 MiB; authorized medium inputs are saved intact up to the
  ingest limit. Guests without storage authority receive bounded excerpts with
  explicit incomplete-coverage notices.
- Atlas ingest limit is 25 MiB; hosted Telegram downloads are limited to 20 MiB.
  Telegram/WhatsApp outgoing documents now allow 25 MiB. Discord retains Atlas's
  conservative 8 MiB upload policy. Upload failures preserve the artifact path
  and available link instead of claiming delivery.
- Web attachment pickers share the server format catalog. Existing account/org
  controls and per-profile tool assignments still apply on every channel.

Versioned publication uses an exclusive filesystem operation: another process
cannot replace an existing output while selecting a version name. Spreadsheet
`writeMode: "inplace"` instead requires `expectedRevision` from a prior read and
serializes changes to the path within one Atlas process. Its final hash check and
atomic rename are not a cross-process compare-and-swap: an unrelated writer can
change the source between them. Use versioned output when other processes may edit
the same workbook, and follow the returned path for subsequent operations.

## Runtime and dependency ownership

Core file engines use Atlas dependencies (`docx`, `pptxgenjs`, `exceljs`, bounded
OOXML handling with `fflate`/`xmldom`, and `pdf-lib`). They do not require the user
to buy a particular model subscription.

Office rendering and spreadsheet recalculation require LibreOffice. The Dockerfile
installs Writer/Calc/Impress and defines a Python venv with pinned pandas, openpyxl,
python-docx, python-pptx, pypdf and reportlab.
`ATLAS_PYTHON_PATH` explicitly selects the runtime; an invalid selection fails
rather than silently falling back. Outside Docker, `scripts/setup-file-runtime.sh`
installs the same analysis packages in an isolated directory. These are pinned
direct packages, not a complete cross-platform transitive dependency lock.

`scripts/file-runtime/verify.py` exercises real read/create/edit and merge/split
workflows. It was also run through Atlas's actual `python_execute` boundary with
a fresh temporary Python 3.14 venv, preserving CSV IDs and producing correctly
typed Office and PDF artifacts. All six pinned direct packages declare Python
3.11 compatibility; the end-to-end validation used 3.14. The full Docker image
has not been rebuilt because the Docker daemon was unavailable
(`docker info` could not connect to `/var/run/docker.sock`).

## Evidence

The latest full target passed **5119 tests / 636 files / 15640 assertions**. The
complete scripts target separately passed 42 tests; those counts overlap and
must not be added as unique tests. Full build, root/web/mobile type checks and
documentation build passed under the environments recorded in the
[deep-validation ledger](deep-validation-run.md). These checks coexist with
the failed Python isolation requirement and five unsupported corpus requests.

- The **earlier selected** regression run passed 1002 tests across 79 files with 3781
  assertions and no failures. It covers the conversation loop, both subscription
  adapters, approval/persistence, file engines, tenant attachments and all three
  channel handlers, including the final archive, PDF form-coverage and SDK deadline
  corrections. Full TypeScript checking, Ultracite checks on 98 changed files and
  the web production build also passed.
- Actual Codex 0.150.1 inference using its advertised `gpt-5.6-sol` model completed
  24 structured callbacks across four dependent daily-file tasks. Persisted tool
  results matched the calls. Independent checks verified DOCX text/table edits,
  PPTX text/notes, XLSX recalculation to 20, PDF merge/text, and unchanged sources.
  [Sanitized trace](../adr/validation/0004-daily-files-native-trace.json).
- Claude 0.3.247 registration passed 46 protocol/runtime tests with 149 assertions
  across five files, using the actual
  installed SDK and an in-memory MCP transport: exact raw schemas, dependent callbacks, errors,
  duplicate IDs, approval failure, cancellation, continuation, and catalog changes.
  Deterministic SDK/MCP tests verify that host callbacks pause the cumulative
  inference budget while caller cancellation remains active.
  This is not a live Claude subscription inference test. A direct Atlas runtime
  status check found Claude Code `2.1.247` with `authenticated: false` and
  `status: "not_authenticated"` in Atlas's isolated configuration. No login was
  initiated and no host credentials were copied for that check.
- Channel tests send fixture bytes through mocked outbound adapters; no live
  WhatsApp, Telegram or Discord messages were sent.
- Actual Office fixture renders and visual QA passed for text, tables, embedded
  images, headers/footers and slides. Conversion/recalculation used an explicitly
  configured test LibreOffice runtime; this does not prove dependency availability
  on another host or inside an unbuilt Docker image.
- All four bundled file skills parsed successfully with Atlas's skill parser.
- Live web QA used the real local Atlas server and a localhost mock model. PPTX,
  TSV, JSON and JSONL passed upload, removal/re-addition, submission, persisted
  attachment IDs and byte-identical downloads. Reloading the chat twice retained
  all four attachments and the response, with no browser errors. This also caught
  and fixed filename/remove-button overlap and StrictMode resume cancellation.
  The [read-only browser regression](../../apps/web/scripts/check-document-reopen.ts)
  repeats the reopen and original-download checks against a prepared local session.
- API and SDK-mode harness tests materialize an original attachment, split its
  PDF, extract the result, and expose only the requested deliverable to channels.

## Remaining limits

0. Python and Bash execute with the server account's access. Working directories,
   virtual environments, approvals and protected-skill rollback are not an OS
   tenant sandbox. See the [actual Python boundary probes](python-execution-boundary-audit.md).

1. No universal OCR/layout-understanding operation. Scanned PDFs require a
   verified OCR/vision backend; the current text extractor reports the gap.
2. No universal preservation of every Excel, Word or PowerPoint feature. Macro,
   signature, encrypted, field/revision, chart and other complex cases need
   explicit support and roundtrip evidence before claiming safe edits.
3. Existing raw-document forwarding still uses a provider-type MIME transport
   table. It is not per-instance/model capability evidence and needs migration;
   local file operations already work independently of it.
4. Original-file materialization and bounded page/range reads are available, but
   arbitrarily large datasets, streaming analysis, locale/encoding inference and retention
   policies need further work. File/page/row/response limits remain enforced.
5. This does not add exactly-once effects across a process crash, persistent SDK
   RPC reattachment, or a comparative reasoning/channel benchmark against other
   products. Approval/persistence guarantees are described in ADR 0004.

## Baseline failures addressed

The initial audit reproduced lost CSV zeroes/digits/quotes/multiline records,
formula strings and stale caches, `[object Object]` formula exports, corrupt-file
replacement on import, missing DOCX images/links, rejected common attachments,
and fake text files named `.pdf`. Each now has a guarded implementation or an
explicit unsupported result and a behavioral regression check. Passing a preview
alone is never treated as proof that these operations are correct.
