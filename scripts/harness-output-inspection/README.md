# Captured DOCX/PDF inspection

`inspect_output.py` produces bound originals, a text/object inventory, full-page PNGs, and process evidence for a previously captured document. It supports `docx_report` and `pdf_create`. It does not grade a document or certify source completeness.

The caller supplies an artifact that the host has already captured after native cleanup. A missing file at this boundary is an unavailable measurement; it does not establish that the native task produced no artifact.

## Runtime requirements

Rendering requires macOS, `/usr/bin/sandbox-exec`, and the supported bundled LibreOffice/Poppler layout. There is no unrestricted-process or alternate-renderer fallback. Python needs `lxml`, `pypdf`, and Pillow; the synthetic fixtures also need `python-docx` and ReportLab. The bundled Codex Python runtime supplies these dependencies.

`ATLAS_INSPECTION_BIN` selects the host-configured `dependencies/bin/override` directory. Its default is `~/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override`. The inspector resolves these native executables relative to that layout:

```text
dependencies/
  bin/override/{soffice,pdfinfo,pdftoppm}
  native/libreoffice-headless/libreoffice/LibreOfficeDev.app/Contents/MacOS/soffice
  native/poppler/bin/{pdfinfo,pdftoppm}
  native/poppler/poppler/bin/{pdfinfo,pdftoppm}
  native/poppler/poppler/{lib,fonts,etc/fonts/conf.d}/
```

Wrapper files are recorded but never executed as shell scripts. An unsupported command, missing dependency, redirected runtime root, or runtime symlink escaping its package prevents renderer admission. The sole external font-link exception is a member of `/Library/Fonts` resolving to a regular file inside `/System/Library/Fonts`; its target is bound too.

## Request and CLI

Use absolute paths. `outputRoot` must be a new directory; existing output is refused. Supply the actual SHA-256 and byte length of the artifact. The optional `sourceContext` is a separately bound JSON file preserved unchanged, not a source-completeness certificate.

```json
{
  "schemaVersion": 1,
  "inspectionId": "synthetic-example",
  "family": "pdf_create",
  "artifact": {
    "path": "/private/tmp/captured/document.pdf",
    "sha256": "<actual SHA-256 of document.pdf>",
    "bytes": 1234
  },
  "outputRoot": "/private/tmp/inspection-example"
}
```

Add `"sourceContext": {"path": "/absolute/context.json", "sha256": "<actual SHA-256>", "bytes": 567}` when context is available. The example hashes and lengths are placeholders, not valid bindings.

From the repository root, with a Python interpreter containing the required dependencies:

```sh
python3 -B scripts/harness-output-inspection/inspect_output.py \
  --request /private/tmp/inspection-request.json \
  --output /private/tmp/inspection-example/receipt.json
```

The Python entry point is `inspect(request) -> dict`. The CLI writes the same result to `outputRoot/receipt.json`; a distinct `--output` path is created exclusively as an additional copy. A completed CLI invocation can report unavailable inspection. Read the receipt rather than treating exit zero as acceptance.

## Evidence and review

The receipt binds the captured original, optional source context, extracted parts, objects with native anchors, retained page images, parser diagnostics, and per-stage process logs. Runtime manifests, policy inputs, generated Fontconfig configuration, and before/after bindings are retained with the render. Failed and partial output is preserved.

Inspect `artifactState`, `inspectionMeasurementAvailable`, each `coverage` entry, and `outcomes` together. Binding failures and measurement limits remain unavailable. Objective invalid-container evidence can report `malformed`; a parser/environment exception alone does not infer malformed output.

`coverage.visual.state = "complete"` means that every independently counted page has a readable image. It does **not** verify glyph fidelity, complete visual content, or correctness. `coversExtractionInvisibleText` remains `null`, `reviewerInspectionPerformed` remains `false`, `allSourcesCertified` remains `false`, and `semanticPass` remains `null`.

Human or designated reviewers must inspect every full-page image and compare it with the required source/context evidence. Check missing text, substituted fonts, clipping, image text, headers/footers, page order, and visual associations. A parser can succeed while the raster loses text. The synthetic PDF regression checks one known text region; it is not a general glyph or semantic validator. Page citations include image paths, page numbers, and pixel dimensions; they are not a complete semantic packet or physical-coordinate conversion.

Raw receipts contain local paths and runtime details. A blinded review pipeline must apply its own custody and metadata-projection rules before release. This tool does not qualify a reviewer, calibrate a method, authorize a study phase, or establish Atlas/Hermes parity.

## Filesystem and process boundary

Each renderer runs under `deny default`, with content reads for the captured input, recorded runtime, system resources, and fonts; writes are confined to the private render directory plus `/dev/null`. Network access is denied. The exact runtime-parent directory receives a literal read grant needed for native startup, not a grant for its entire subtree. Filesystem metadata/existence queries are allowed.

The imported, hash-bound macOS `dyld-support.sb` profile adds platform prerequisites, including Cryptex roots and exact ancestor-directory reads. The explicit root list is therefore not exhaustive, and the evidence does not claim an immutable snapshot of the entire OS. `/Library/Fonts` and runtime members are recorded separately.

Poppler uses a private generated Fontconfig file with explicit bundled/system font directories, the bound bundled `conf.d` aliases, and a private cache directory. These paths fit the existing policy. `HOME`, `USER`, and `LOGNAME`, when present, retain their host values; they do not grant access to those locations. Temporary files and XDG configuration/cache paths use the private render root.

Each stage has a 60-second process wait budget. Timeout sends `SIGKILL` to the process group and waits for the direct process; it does not prove descendant quiescence. Runtime/input checks before and after execution detect observed changes, but are not atomic pins against a hostile host. Input/decoded-size checks are not hard OS memory or disk quotas.

| Measurement limit | Bound |
| --- | --- |
| Input file | 20 MiB |
| Expanded content | 128 MiB |
| XML member | 16 MiB |
| Archive entries | 4,096 |
| Retained text | 2,000,000 characters |
| Inventory objects | 100,000 |
| Rendered pages | 32 |

These measurement bounds do not relax any task-specific page or output limits. Non-embedded fonts can use available substitutes. Compatibility and confinement evidence applies to the recorded macOS runtime and exercised cases, not arbitrary platforms or documents.

## Synthetic regression tests

Every run requires its own fresh absolute evidence directory whose parent already exists. Tests leave fixtures, original hashes, registration, logs, partial results, and failure records in that directory. Do not reuse or erase a failed run to obtain a passing one.

```sh
ATLAS_INSPECTION_TEST_ROOT=/private/tmp/inspection-portable-001 \
  python3 -B scripts/harness-output-inspection/test_inspection.py
```

Default fixtures are generated by `synthetic_fixtures.py` inside the run directory. The external-image fixture links only to an owned red canary outside its capture directory. Generated bytes and dependency/source versions are bound in registration. Fixed-input generation is deterministic within a dependency environment; the external DOCX embeds its run-specific absolute canary URI.

To run a single case:

```sh
ATLAS_INSPECTION_TEST_ROOT=/private/tmp/inspection-one-case-001 \
  python3 -B scripts/harness-output-inspection/test_inspection.py \
  InspectionTests.test_complete_pdf
```

`ATLAS_INSPECTION_LEGACY_FIXTURES=1` runs the same document cases against the retained historical synthetic fixtures named in `test_inspection.py`. Those `/private/tmp/atlas-v4-output-inspection-*` paths must exist. This mode preserves the exact original external-link regression; portable mode does not need them.

```sh
ATLAS_POLICY_TEST_ROOT=/private/tmp/inspection-policy-001 \
  python3 -B scripts/harness-output-inspection/test_renderer_policy.py
```

The policy suite exercises trusted shell builtins under each exact renderer sandbox prefix and tests root/symlink admission with owned fixtures. It checks allowed capture reads/private writes and denied sibling/outside content reads and writes without broadening grants.

```sh
ATLAS_FAILURE_TEST_ROOT=/private/tmp/inspection-failure-001 \
  python3 -B scripts/harness-output-inspection/test_renderer_failures.py
```

The failure suite retains a real timeout, an actual first-page-only raster that must remain unavailable, a denied loopback bind without traffic, and rejection before starting an unregistered command. It does not establish descendant cleanup.

`ATLAS_INSPECTION_RUNTIME_MANIFEST`, if set for the document tests, adds a reference to an existing manifest in test registration only. It does not configure or authorize the inspector runtime; `ATLAS_INSPECTION_BIN` is the runtime-layout setting. If an outer environment prevents installing the required macOS sandbox, the native test cannot establish rendering success there. Keep that failure and run only where the same inner policy can be enforced; do not remove the policy to make a test pass.
