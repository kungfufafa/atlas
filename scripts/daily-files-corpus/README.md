# Reproduce the held-out daily-files corpus

The case list was declared in `docs/architecture/daily-files-corpus.md` before
execution. These scripts retain every case; an unsupported operation is never
reported as a successful requested operation.

Use Python 3.11+ and install the independent fixture/oracle libraries into a
temporary virtual environment:

```sh
python3 -m venv /tmp/atlas-file-oracle
/tmp/atlas-file-oracle/bin/pip install python-docx==1.2.0 python-pptx==1.0.2 openpyxl==3.1.5 pypdf==6.17.0 reportlab==5.0.1 Pillow==12.3.0
/tmp/atlas-file-oracle/bin/python scripts/daily-files-corpus/generate.py /tmp/atlas-corpus --font /absolute/path/to/covering.ttf
ATLAS_OFFICE_CONVERTER_PATH=/absolute/path/to/soffice bun scripts/daily-files-corpus/run.ts /tmp/atlas-corpus attempt-001
/tmp/atlas-file-oracle/bin/python scripts/daily-files-corpus/verify.py /tmp/atlas-corpus /tmp/atlas-corpus/attempts/attempt-001/execution.json --revision v6
```

The font must cover the fixture's Latin, Arabic and CJK text. Its bytes/hash and
file size affect F05; the recorded run used macOS Arial Unicode MS. Font files
are not redistributed. The original run injected Codex's bundled LibreOffice
explicitly as a **test dependency**. This is not evidence of a production host
LibreOffice installation.

`run.ts` exercises `executeProtectedTool`: JSON-schema validation, workspace
paths, execution, output serialization and artifact detection. It is not a
model invocation, channel delivery, UI test or remote provider test. The first
three recorded attempts used direct `ToolDefinition.run`; the four later
attempts use the protected boundary and name it in their execution JSON.

The runner refuses to reuse an attempt directory. The verifier appends to
`attempts.jsonl` and refuses an existing attempt/oracle-revision pair. Oracle
corrections require a new revision; previous interpretations stay in the ledger.
Generated Office ZIP timestamps may differ between regenerations; the manifest
records each generation's hashes, and source preservation compares against
that exact generation.

The independent verifier checks source hashes on failures as well as successful
operations. DOCX/PPTX mutations additionally compare every unrelated ZIP part
and the non-text structure of the changed XML parts. XLSX verification uses
openpyxl, CSV uses Python's parser, and PDF uses pypdf. Visual fidelity is a
separate review: parser success does not prove layout, reading order or RTL
rendering.

The recorded evidence and every failed attempt are under
`docs/architecture/validation/daily-files-corpus/`. Reproduction runs the current
implementation; those preserved historical traces document failures before the
fixes, rather than claiming current code will reproduce a removed bug.

Oracle v6 adds semantic tracked-revision checks for D03: accepting Atlas's new
changes yields the requested text, while rejecting only those changes restores
the original document tree and reviewer identities. Revision structure must
change to retain the old text honestly. It also compares X03 chart definitions
(apart from invalidated caches), untouched source cells and unrelated ZIP parts.
Earlier attempts and oracle versions remain in the ledger.

The historical D03 generator wraps an entire paragraph in a body-level insertion;
LibreOffice omits that paragraph in both source and output. Keep this fixture
for structural continuity, and use `generate-tracked-inline.py` to produce an
additional inline-run insertion for visual review. The latter is a separate
regression, not a replacement for the declared corpus case.
