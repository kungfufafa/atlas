# Closed C9 development census and every failed arm

The unchanged reviewed census helper retained all36 scheduled arms (18 pairs), with36 starts and36 ends, no missing/duplicate lifecycle rows and no summary discrepancies. The original frozen analysis is valid with zero issues and reports Atlas14/18, Hermes14/18:12 both-pass,2 Atlas-only,2 Hermes-only and2 neither. These are exploratory development results, not a general parity or causal-improvement claim.

No model, oracle, analyzer or test was run again. Original primary results are unchanged; all8 failed primary arms are listed below.

## Original analyzer family totals

| Family | Pairs | Both pass | Atlas only | Hermes only | Neither |
|---|---:|---:|---:|---:|---:|
| code_fix | 2 | 1 | 1 | 0 | 0 |
| csv_join | 2 | 2 | 0 | 0 | 0 |
| docx_report | 2 | 0 | 0 | 0 | 2 |
| docx_revision | 2 | 2 | 0 | 0 | 0 |
| pdf_create | 2 | 2 | 0 | 0 | 0 |
| pdf_extract | 2 | 2 | 0 | 0 | 0 |
| pptx_revision | 2 | 1 | 1 | 0 | 0 |
| xlsx_reconciliation | 2 | 1 | 0 | 1 | 0 |
| xlsx_surgical_edit | 2 | 1 | 0 | 1 | 0 |

## Every original failed primary arm

### development-1788761674761-248ff763-native-files-development-xlsx_reconciliation-v0-r0-atlas

Original status: `failed`; primary: `false`; original oracle: `None`; reported requests: 10; mandatory usage known: `True`.

Native execution failed with IncompleteCompletionError (length), no public final text, exit1; parent did not time out. Response8 ended length at4096, response9 emitted another tool call, response10 ended length with716 remaining output tokens. Final reported generated total is exactly12000, across10 requests. The original budgetExceeded flag is false and remains false.

Eight actual tool events: directory discovery, input inspections, initial save failed because artifacts directory was absent, directory created, later Python save reported5451-byte reconciliation.xlsx and a native hash snapshot, then another input inspection.

The original process failure prevented artifact inspection/grading/delivery certification. A recorded save is not a certified successful deliverable. No content oracle was rerun, and no claim that a different recovery prompt or fewer calls would have passed is made.

### development-1788761674761-248ff763-native-files-development-docx_report-v0-r0-hermes

Original status: `completed`; primary: `false`; original oracle: `False`; reported requests: 9; mandatory usage known: `True`.

The six supplied facts exist in the actual DOCX. Action and due date occur only in the correct table, while the assigned task also requires all supplied facts in readable paragraphs. Original fact:action and fact:due paragraph checks fail, action_table passes.

Actual native tools created the delivered DOCX and original byte binding passed; all four retained packages were inspected by root.

Not evidence of absent/fabricated facts, unreadable output, or a contradictory oracle; root performed no rendering or regrading. All four original failures remain.

DOCX inspection attributed to [root's closed report](/private/tmp/atlas-native-file-v3-c9-development-docx-contract-review/report.md).

### development-1788761674761-248ff763-native-files-development-docx_report-v0-r0-atlas

Original status: `completed`; primary: `false`; original oracle: `False`; reported requests: 4; mandatory usage known: `True`.

The six supplied facts exist in the actual DOCX. Action and due date occur only in the correct table, while the assigned task also requires all supplied facts in readable paragraphs. Original fact:action and fact:due paragraph checks fail, action_table passes.

Actual native tools created the delivered DOCX and original byte binding passed; all four retained packages were inspected by root.

Not evidence of absent/fabricated facts, unreadable output, or a contradictory oracle; root performed no rendering or regrading. All four original failures remain.

DOCX inspection attributed to [root's closed report](/private/tmp/atlas-native-file-v3-c9-development-docx-contract-review/report.md).

### development-1788761674761-248ff763-native-files-development-code_fix-v0-r0-hermes

Original status: `completed`; primary: `false`; original oracle: `False`; reported requests: 11; mandatory usage known: `True`.

The final1203-byte app/money.py uses minor_str.ljust at line26; ljust is absent from the supplied members allowlist, whose rule explicitly requires every attribute to be admitted. Original contract checker reports Member outside contract: ljust and marks19 cases failed at admission.

Hermes read the full contract, public test and initial code; first implementation failed public1.005. It rewrote the code; actual public checks then passed, as did its own additional command checks, and it reread the final source.

The public-test success claim is supported by the actual tool result. The broader final contract-compliance claim is unsupported by its disallowed member. Original0/19 means candidate admission rejection, not19 demonstrated arithmetic-answer errors. No candidate, public test or hidden test was executed again.

### development-1788761674761-248ff763-native-files-development-xlsx_surgical_edit-v0-r0-atlas

Original status: `completed`; primary: `false`; original oracle: `None`; reported requests: 5; mandatory usage known: `True`.

Final text includes the valid inline path artifacts/budget-corrected.xlsx and a sandbox:/artifacts/budget-corrected.xlsx link. The original selector rejects the URI scheme, retains it as invalid and sets path:null even though one valid candidate also exists. Oracle did not run.

Python created the actual5642-byte workbook and then read target Budget!C2=482 and source C2=271. Independent read-only ZIP/XML inspection confirms these stored numeric scalars and actual byte hash matches the native snapshot.

Default binding false/nativeEffectObserved false follows unresolved selection; it does not prove no file was written. The model claimed all other properties were preserved, but its visible verification only read C2, A3 and type; this review does not certify complete workbook preservation or substitute a passing score.

### development-1788761674761-248ff763-native-files-development-pptx_revision-v0-r0-hermes

Original status: `accounting_uncertain`; primary: `false`; original oracle: `None`; reported requests: 7; mandatory usage known: `False`.

The parent deadline stopped the process group with SIGTERM at approximately300s; direct child exit/close observed, zero stdout/stderr, native identity/output unavailable. Caller duration300024.770291ms. Seven requests recorded, six successful response counters total27606 prompt/1030 generated; seventh transport record reports timeout after63664ms. Final mandatory totals remain null.

Native final receipt is absent, but the final original request retains five public terminal call/results: list input, create artifacts directory, python3 failed to import pptx, prepared interpreter reported pptx1.0.2, then a .rgb access on _NoneColor raised AttributeError before save. No successful save or final delivery appears in that retained public history.

The last successful calls include observed45.367s,55.470s,76.255s and44.428s response elapsed times. This does not isolate provider versus transport/network delay or prove the code errors caused the timeout. Parent cleanup reports direct exit/close and absent group probe; all descendants remain unproved and native cleanup/source/file evidence is unavailable. No native runId or zero usage is invented.

### development-1788761674761-248ff763-native-files-development-docx_report-v1-r0-atlas

Original status: `completed`; primary: `false`; original oracle: `False`; reported requests: 8; mandatory usage known: `True`.

The six supplied facts exist in the actual DOCX. Action and due date occur only in the correct table, while the assigned task also requires all supplied facts in readable paragraphs. Original fact:action and fact:due paragraph checks fail, action_table passes.

Actual native tools created the delivered DOCX and original byte binding passed; all four retained packages were inspected by root.

Not evidence of absent/fabricated facts, unreadable output, or a contradictory oracle; root performed no rendering or regrading. All four original failures remain.

DOCX inspection attributed to [root's closed report](/private/tmp/atlas-native-file-v3-c9-development-docx-contract-review/report.md).

### development-1788761674761-248ff763-native-files-development-docx_report-v1-r0-hermes

Original status: `completed`; primary: `false`; original oracle: `False`; reported requests: 11; mandatory usage known: `True`.

The six supplied facts exist in the actual DOCX. Action and due date occur only in the correct table, while the assigned task also requires all supplied facts in readable paragraphs. Original fact:action and fact:due paragraph checks fail, action_table passes.

Actual native tools created the delivered DOCX and original byte binding passed; all four retained packages were inspected by root.

Not evidence of absent/fabricated facts, unreadable output, or a contradictory oracle; root performed no rendering or regrading. All four original failures remain.

DOCX inspection attributed to [root's closed report](/private/tmp/atlas-native-file-v3-c9-development-docx-contract-review/report.md).

## Complete original scheduled census

| # | Original scheduled identity | Caller status | Caller success | Original oracle | Requests | Mandatory usage known |
|---:|---|---|---:|---:|---:|---:|
| 1 | development-1788761674761-248ff763-native-files-development-pdf_create-v1-r0-atlas | completed | True | True | 6 | True |
| 2 | development-1788761674761-248ff763-native-files-development-pdf_create-v1-r0-hermes | completed | True | True | 8 | True |
| 3 | development-1788761674761-248ff763-native-files-development-csv_join-v0-r0-hermes | completed | True | True | 9 | True |
| 4 | development-1788761674761-248ff763-native-files-development-csv_join-v0-r0-atlas | completed | True | True | 6 | True |
| 5 | development-1788761674761-248ff763-native-files-development-pptx_revision-v1-r0-hermes | completed | True | True | 8 | True |
| 6 | development-1788761674761-248ff763-native-files-development-pptx_revision-v1-r0-atlas | completed | True | True | 7 | True |
| 7 | development-1788761674761-248ff763-native-files-development-csv_join-v1-r0-atlas | completed | True | True | 6 | True |
| 8 | development-1788761674761-248ff763-native-files-development-csv_join-v1-r0-hermes | completed | True | True | 7 | True |
| 9 | development-1788761674761-248ff763-native-files-development-code_fix-v1-r0-hermes | completed | True | True | 5 | True |
| 10 | development-1788761674761-248ff763-native-files-development-code_fix-v1-r0-atlas | completed | True | True | 8 | True |
| 11 | development-1788761674761-248ff763-native-files-development-xlsx_reconciliation-v0-r0-atlas | failed | False | None | 10 | True |
| 12 | development-1788761674761-248ff763-native-files-development-xlsx_reconciliation-v0-r0-hermes | completed | True | True | 8 | True |
| 13 | development-1788761674761-248ff763-native-files-development-xlsx_reconciliation-v1-r0-hermes | completed | True | True | 7 | True |
| 14 | development-1788761674761-248ff763-native-files-development-xlsx_reconciliation-v1-r0-atlas | completed | True | True | 7 | True |
| 15 | development-1788761674761-248ff763-native-files-development-xlsx_surgical_edit-v1-r0-atlas | completed | True | True | 8 | True |
| 16 | development-1788761674761-248ff763-native-files-development-xlsx_surgical_edit-v1-r0-hermes | completed | True | True | 9 | True |
| 17 | development-1788761674761-248ff763-native-files-development-pdf_extract-v1-r0-hermes | completed | True | True | 9 | True |
| 18 | development-1788761674761-248ff763-native-files-development-pdf_extract-v1-r0-atlas | completed | True | True | 9 | True |
| 19 | development-1788761674761-248ff763-native-files-development-docx_report-v0-r0-hermes | completed | False | False | 9 | True |
| 20 | development-1788761674761-248ff763-native-files-development-docx_report-v0-r0-atlas | completed | False | False | 4 | True |
| 21 | development-1788761674761-248ff763-native-files-development-pdf_extract-v0-r0-atlas | completed | True | True | 6 | True |
| 22 | development-1788761674761-248ff763-native-files-development-pdf_extract-v0-r0-hermes | completed | True | True | 5 | True |
| 23 | development-1788761674761-248ff763-native-files-development-pdf_create-v0-r0-hermes | completed | True | True | 8 | True |
| 24 | development-1788761674761-248ff763-native-files-development-pdf_create-v0-r0-atlas | completed | True | True | 5 | True |
| 25 | development-1788761674761-248ff763-native-files-development-docx_revision-v1-r0-hermes | completed | True | True | 9 | True |
| 26 | development-1788761674761-248ff763-native-files-development-docx_revision-v1-r0-atlas | completed | True | True | 8 | True |
| 27 | development-1788761674761-248ff763-native-files-development-code_fix-v0-r0-atlas | completed | True | True | 5 | True |
| 28 | development-1788761674761-248ff763-native-files-development-code_fix-v0-r0-hermes | completed | False | False | 11 | True |
| 29 | development-1788761674761-248ff763-native-files-development-xlsx_surgical_edit-v0-r0-hermes | completed | True | True | 9 | True |
| 30 | development-1788761674761-248ff763-native-files-development-xlsx_surgical_edit-v0-r0-atlas | completed | False | None | 5 | True |
| 31 | development-1788761674761-248ff763-native-files-development-docx_revision-v0-r0-atlas | completed | True | True | 6 | True |
| 32 | development-1788761674761-248ff763-native-files-development-docx_revision-v0-r0-hermes | completed | True | True | 10 | True |
| 33 | development-1788761674761-248ff763-native-files-development-pptx_revision-v0-r0-atlas | completed | True | True | 6 | True |
| 34 | development-1788761674761-248ff763-native-files-development-pptx_revision-v0-r0-hermes | accounting_uncertain | False | None | 7 | False |
| 35 | development-1788761674761-248ff763-native-files-development-docx_report-v1-r0-atlas | completed | False | False | 8 | True |
| 36 | development-1788761674761-248ff763-native-files-development-docx_report-v1-r0-hermes | completed | False | False | 11 | True |

The JSON census retains original durations, request records, known subtotals and unknown values for every arm. Numeric subtotals do not certify unknown final accounting. Native unavailable fields remain unavailable, separately from verified parent attribution. The helper flags selected summary differences; it is not a replacement for the frozen full analyzer or an exhaustive forensic validation.

Original source: C9 e2daf1b902a087eb279724f17d61e50b9a27f7c1d64828f6958b61b22225eb98/2121files; controls b3673405fab43fdd268aa286d4f6f0164ea00c2332ba43d00e28abd3d538fde5/53files. Full original file hashes and consulted public/protocol bindings are recorded in original-source-bindings.json.

All raw development evidence is separately preserved by root at outputs/hermes-evidence/2026-09-07/file-v3-c9-development-raw (manifest1b6ea2632ad489265eccc009faecd9a47577f27221293c74f0e43fdbaba13dc0). This review inspected no confirmation content and changed no product, control, task, threshold or score.

Initial local path probes omitted the process subdirectory for runner stdout and tried the empty broker workspace for an artifact copy. Correct original paths were obtained from the actual native receipt; those unsuccessful read-only probes did not mutate any original evidence. No conclusions depend on those absent probe paths.
