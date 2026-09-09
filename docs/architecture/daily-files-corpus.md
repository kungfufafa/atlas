# Predeclared daily-files challenge corpus

Follow-up: [file gap remediation](gap-remediation.md) records the subsequent
21/21 structural/content result and its separate visual limits. The prior
attempts and unsupported classifications below are retained as history.

Declared 2026-09-06 before generating or running these fixtures. This corpus
challenges the structured file tools with independent producers and readers;
the earlier native smoke and hand-built fixtures are not counted here.

Every case remains in the result ledger. A refusal is **unsupported**, not a
successful requested operation. A produced result with missing or altered
required content is **failure**, even when a warning names that loss. A case is
**supported** only when its requested operation and its preservation assertions
pass the independent oracle. Fixes get new attempts; earlier results remain.

Producers/oracles: python-docx, python-pptx, openpyxl, Python csv, reportlab,
pypdf, ZIP/XML comparison, and LibreOffice rendering where available. Atlas's
TypeScript implementation is the system under test, not its own truth oracle.
Fixtures contain synthetic information only. Source SHA-256 hashes are checked
after every case, including failures. Rendered visual evidence is tracked
separately from structural/content checks.

| ID | Held-out source and requested operation | Required result and preservation |
| --- | --- | --- |
| D01 | Multilingual DOCX; replace a phrase split across three differently styled runs | Exact new Unicode text; preserve run styles, hyperlink, image, headers/footer, numbering and unrelated ZIP parts |
| D02 | DOCX with nested tables; update one inner cell | Exact inner-cell value; outer cells, nested structure, dimensions and unrelated parts unchanged |
| D03 | DOCX paragraph inside tracked insertion; replace text | Requested visible change with coherent revision structure; refusal is unsupported |
| D04 | Two-section DOCX; update only the second section's distinct header | Correct header updated; body, first header, sections/page setup preserved |
| P01 | PPTX with native chart/embedded workbook; edit the slide caption | Exact caption; chart, embedded data, notes, layout/master and unrelated parts unchanged |
| P02 | PPTX grouped text shapes; edit one group member | Correct text member changed; group coordinates, other shapes and image untouched |
| P03 | PPTX merged table cell; replace the visible cell content | New visible value and same merge geometry; refusal is unsupported |
| P04 | Multilingual PPTX with RTL paragraph and notes; replace one phrase | Exact Unicode content and RTL/style metadata; other slides/notes preserved |
| X01 | Multi-sheet XLSX with dates, text IDs, hidden sheet, comments, validation and formats; edit one input | Value changes; dates/types/leading zeroes/styles/comment/validation/sheets survive |
| X02 | Multi-sheet XLSX formulas using SUMIFS, IF and dates; change an input and recalculate | Independent expected numeric/date results; correct formulas/sheet names and untouched inputs |
| X03 | XLSX with a chart; edit its source cell | Updated cell plus retained chart/series/data relationship; refusal is unsupported |
| X04 | XLSX named table with totals/structured formula and conditional formatting; edit an input | Table/filters/totals/conditional formatting retained; calculated result correct |
| C01 | UTF-8 BOM semicolon CSV with Unicode, quoted newlines and long/zero-prefixed IDs; import and literal export | Same parsed records and text types; no precision or delimiter/quote loss |
| C02 | Semicolon CSV with comma decimals; import requested numeric columns | Correct decimal numbers and original identifiers; refusal is unsupported |
| C03 | Tab-delimited .csv with empty trailing cells, tabs/newlines inside quotes and formula-like text; roundtrip | Same parsed records, formula-like fields stay strings, literal export preserves content |
| F01 | Three-page PDF with rotated page, vector table and Unicode text; extract selected pages | Correct selected text and page coverage; source unchanged |
| F02 | Filled AcroForm PDF; read the field names and values | Both names and entered values exposed; omitted values/refusal are unsupported |
| F03 | Image-only scanned PDF; read its visible text | Accurate text from scan; OCR gap/refusal is unsupported |
| F04 | PDF with outline, attachment and internal navigation; merge with an appendix | Page content, outline, embedded attachment and internal destination preserved; produced loss is failure |
| F05 | Create PDF containing Latin accents, Arabic and CJK using an explicitly supplied covering font | Correct multilingual text and readable rendering; unsupported glyph/font path is unsupported |
| W01 | Mixed file workflow: CSV records → XLSX formula summary → existing DOCX/PPTX update → report PDF plus appendix | Independently correct totals and text at each stage, output links point to real artifacts, all inputs intact |

## Execution ledger

Executed all 21 cases in seven attempts. The final attempt uses the actual
`executeProtectedTool` boundary. Its independent structural/content result is
**16 supported operations, 5 unsupported, 0 observed failures**. The five
unsupported requests were not fulfilled. Visual QA is separate: 24 returned
Office/PDF references rendered into 30 inspected pages with explicitly configured
fonts. Source spreadsheet print-layout limits remain. This result does not establish universal
document fidelity or full product readiness.

Reproduction: [scripts and dependencies](../../scripts/daily-files-corpus/README.md).
Evidence: [source manifest](validation/daily-files-corpus/manifest.json),
[all attempt/oracle records](validation/daily-files-corpus/attempts.jsonl),
[final protected execution](validation/daily-files-corpus/protected-import-layout-20260906/execution.json),
[final independent oracle](validation/daily-files-corpus/protected-import-layout-20260906/verified.oracle-v5.json).

| Attempt | Boundary / change under challenge | Supported | Unsupported | Failure |
| --- | --- | ---: | ---: | ---: |
| initial-20260906, corrected oracle v2 | Direct tool calls, untouched implementation | 10 | 7 | 4 |
| compat-driver-20260906, oracle v2 | OPC target compatibility; explicit numeric CSV import in W01 | 11 | 7 | 3 |
| preservation-20260906, oracle v2 | Preserve plain comments/authors and validation XML | 12 | 7 | 2 |
| protected-pdfjs-20260906, stronger oracle v3 | Protected boundary, PDF.js extraction, complex PDF copy refusal | 12 | 8 | 1 |
| protected-fidelity-20260906, oracle v4 | Preserve color-scale definitions across recalculation | 13 | 8 | 0 |
| protected-forms-locale-20260906, oracle v5 | Explicit comma decimals, typed form values, merged PowerPoint anchor text | 16 | 5 | 0 |
| protected-import-layout-20260906, oracle v5 | New CSV workbooks receive bounded widths, wrapping and row heights | 16 | 5 | 0 |

Initial failures were ordinary comment/table XLSX files crashing ExcelJS, PDF
merge losing bookmarks/attachments/internal navigation, and the mixed workflow
failing to extract a LibreOffice PDF that independently contained real text.
The initial W01 driver also omitted numeric CSV column types and calculated
zero; that driver mistake and its generated outputs remain recorded.

The first crash fix exposed further X01 loss: ExcelJS dropped plain comment
text/author and duplicated a validation rectangle. The next fix restored those
unchanged XML structures. A stronger X04 check then found LibreOffice rewriting
color-scale XML; unchanged color-scale rules are now restored after calculation.
This preservation is limited to color scales without differential-style IDs;
it is not a claim that every conditional-format extension is supported.

Oracle corrections are explicit. Revision v1 misclassified the merged-cell/OCR
refusal strings, failed while examining an orphan PDF destination (`None`), and
did not check W01 partial outputs after its final extraction error. Revision v2
corrected those issues and checked partial results. Revision v3 added non-text
OOXML structure checks and exact color-scale/table-style checks. Revision v4
kept exact color-scale checks and compared table flags using their effective
boolean values: an absent optional false flag and an explicit false flag are
the same style. Every earlier interpretation is retained, including v3's
overly strict table-flag mismatch. No declared case was removed.

The supported structural/content cases are D01, D02, D04, P01, P02, P03, P04,
X01, X02, X04, C01, C02, C03, F01, F02 and W01. The additional fixes were
bounded: comma decimals require an explicit CSV number-column setting and
`decimalSeparator`; stored form values are typed and paginated without running
PDF scripts; a PowerPoint merged anchor can change its text while retaining its
span, and continuation cells remain guarded. Oracle v5 checks exact named form
values and the imported identifiers' string types, not string presence alone.

The remaining cases are explicit gaps:

- D03: edit inside tracked revisions. Safely changing revision history needs an explicit accept/reject/new-revision contract; plain text replacement would misrepresent the existing reviewer history.
- X03: chart-workbook cell edit while preserving the chart. ExcelJS drops unsupported drawing structures; preserving the chart, embedded workbook and relationships needs a separate OOXML editing path or a capable spreadsheet engine.
- F03: OCR of a scanned PDF; empty text now reports incomplete coverage. Text extraction cannot recover image pixels; an assigned OCR/vision engine and its language/layout evidence are still required.
- F04: merging while preserving document navigation and embedded attachments;
  the tool now refuses before publishing a lossy result. Correct copying needs explicit destination remapping and catalog merging, beyond page-tree copying.
- F05: the supplied covering font exceeds the supported 10 MiB font limit. Raising that guard alone would not prove bidirectional shaping or resource safety for large font parsing; multilingual PDF layout and bounded font preparation remain separate work.

Source SHA-256 hashes were unchanged in every recorded attempt. The corpus used
python-docx 1.2.0, python-pptx 1.0.2, openpyxl 3.1.5, pypdf 6.17.0, reportlab
5.0.1 and Pillow 12.3.0. LibreOffice was explicitly injected from the Codex test
runtime; host installation and production packaging are separate checks.

## Interpretation limits

These 21 cases sample common workflows and do not establish universal Office
format fidelity. Independent library roundtrips are structural evidence;
layout, reading order, bidirectional text and visible overflow require rendering
inspection. An unavailable rendering or OCR dependency is a recorded gap.

The [bundled worker check](validation/daily-files-corpus/bundled-pdf-worker.json)
compiles the full server and runs protected extraction from a separate bundled
entry under the server package. It reads the actual LibreOffice text fixture and
reports the scan as incomplete. This proves installed-package resolution and
worker execution; it is not an HTTP or model invocation. Reproduce with
`bun scripts/daily-files-corpus/check-built-pdf.ts`.

Visual review found real clipping in the newly imported C01/C03 workbooks,
despite their correct stored values. New CSV-to-XLSX creation now estimates
bounded column widths and multiline row heights and wraps text. This applies
only to newly created workbooks; ordinary edits retain existing widths/heights.
The final C01/C03 render review confirmed readable identifiers, headers and
multiline fields after the new-import layout correction. The complete visual
ledger and retained before/after images are in [visual validation](daily-files-visual.md).
An apparent X02 header-clipping
regression was retracted after the supplied before/after PNGs proved byte-identical;
the [correction evidence](validation/daily-files-corpus/x02-visual-correction.json)
also records the inherited `###` date-width limit. No recalculation layout change
was made in response to that false alarm.
