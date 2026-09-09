# Closed C9 confirmation census and failure diagnosis

The original once-only analyzer reports **Atlas 44/54 and Hermes 46/54**, with **42 both successful, 2 Atlas-only, 4 Hermes-only and 6 neither successful**. All 54 pairs / 108 scheduled arms remain present, with exactly 108 starts and 108 ends. The unchanged census helper reports no missing/duplicate identity and no selected-summary discrepancy. Original structural validity is true with zero issues; the separately closed independent instrumentation review supports that structural result within its registered scope, without grading semantic failures again.

The prospective finite-census qualification is not met: Atlas is below 49/54 overall, below 5/6 in DOCX report (1/6), and below Hermes in the aggregate. These observations do not establish parity, superiority or population noninferiority. This report does not recompute primary success, run oracles or replace the original analyzer.

| Family | Pairs | Atlas original | Hermes original | Both | Atlas-only | Hermes-only | Neither |
|---|---:|---:|---:|---:|---:|---:|---:|
| code_fix | 6 | 5/6 | 4/6 | 4 | 1 | 0 | 1 |
| csv_join | 6 | 5/6 | 6/6 | 5 | 0 | 1 | 0 |
| docx_report | 6 | 1/6 | 2/6 | 1 | 0 | 1 | 4 |
| docx_revision | 6 | 5/6 | 5/6 | 5 | 0 | 0 | 1 |
| pdf_create | 6 | 6/6 | 6/6 | 6 | 0 | 0 | 0 |
| pdf_extract | 6 | 6/6 | 6/6 | 6 | 0 | 0 | 0 |
| pptx_revision | 6 | 5/6 | 5/6 | 4 | 1 | 1 | 0 |
| xlsx_reconciliation | 6 | 5/6 | 6/6 | 5 | 0 | 1 | 0 |
| xlsx_surgical_edit | 6 | 6/6 | 6/6 | 6 | 0 | 0 | 0 |

These integers are displays of the original analyzer’s paired count fields. The complete identity/status/request/duration table is [all-108-original-arms.md](all-108-original-arms.md); census.json retains every original projected row and the original analyzer groups separately.

## Every original primary failure

There are **18 failures: 10 Atlas and 8 Hermes**. Seven completed DOCX outputs fail the original oracle; three outputs pass the original artifact/code oracle but have unknown mandatory accounting; seven more have unknown accounting with failed or unavailable native completion; one has a deadline with zero admitted upstream requests (two broker-rejected arrivals) and original known-zero accounting. These are descriptions of existing outcomes, not alternative score groups.

| # | Original arm suffix | Original status | Oracle | Main explanation |
|---:|---|---|---|---|
| 2 | code_fix-v0-r0-hermes | accounting_uncertain | True | Accounting uncertainty after successful native code completion |
| 3 | xlsx_reconciliation-v0-r0-atlas | accounting_uncertain | unavailable | Native tool error followed by transport failure and unknown accounting |
| 37 | docx_report-v2-r0-hermes | completed | False | Completed DOCX rejected by original oracle |
| 38 | docx_report-v2-r0-atlas | completed | False | Completed DOCX rejected by original oracle |
| 52 | pptx_revision-v1-r0-atlas | accounting_uncertain | True | Successful PPTX revision; failed auxiliary title accounting |
| 53 | docx_report-v1-r0-atlas | accounting_uncertain | unavailable | Initial transport failure before a DOCX report was produced |
| 54 | docx_report-v1-r0-hermes | accounting_uncertain | unavailable | Deadline with unavailable Hermes native evidence and unknown accounting |
| 55 | docx_revision-v2-r1-hermes | accounting_uncertain | unavailable | Deadline with unavailable Hermes DOCX-revision evidence |
| 56 | docx_revision-v2-r1-atlas | accounting_uncertain | unavailable | Initial Atlas DOCX-revision transport failure |
| 57 | code_fix-v1-r1-atlas | accounting_uncertain | unavailable | Initial Atlas code-task transport failure |
| 58 | code_fix-v1-r1-hermes | budget_exceeded | unavailable | Deadline before any admitted upstream request; native evidence unavailable |
| 59 | pptx_revision-v2-r1-hermes | accounting_uncertain | unavailable | Deadline with unavailable Hermes PPTX evidence |
| 73 | csv_join-v2-r1-atlas | accounting_uncertain | True | Successful CSV delivery; failed auxiliary title accounting |
| 75 | docx_report-v2-r1-atlas | completed | False | Completed DOCX rejected by original oracle |
| 81 | docx_report-v0-r1-atlas | completed | False | Completed DOCX rejected by original oracle |
| 82 | docx_report-v0-r1-hermes | completed | False | Completed DOCX rejected by original oracle |
| 107 | docx_report-v1-r1-hermes | completed | False | Completed DOCX rejected by original oracle |
| 108 | docx_report-v1-r1-atlas | completed | False | Completed DOCX rejected by original oracle |

### #2 — code_fix-v0-r0-hermes

Hermes read the supplied contract, implementation and public test; wrote app/money.py using Decimal and ROUND_HALF_UP; then ran the public test with the prepared Python. The original terminal result is exit 0 with “public checks passed”. Its final text reports completion. The original isolated code result admits the implementation and reports 19/19 cases passed, with source mutation and delivery binding checks passed. Requests 3 and 4, both continuations containing the three public read_file results, timed out after 90,007 and 90,005 ms. Request 5 has the same captured message-array hash as those two continuations and proceeds to write the file; the two failed requests are retained. Request 2 is a successful auxiliary title request, not the cause of uncertainty. Native and full caller completed below 300 seconds, but the two failed-request usage totals remain unknown. Primary stays false; no arithmetic failure is established. This arm precedes the bounded sleep/wake window.

### #3 — xlsx_reconciliation-v0-r0-atlas

Atlas attempted read_file on input/invoices.xlsx. The actual tool rejected binary Excel as UTF-8 and recommended the spreadsheet/document tools. No write or final deliverable is present in its public native event list. The next request, after that public error result, timed out after 90,026 ms. Native output retains its genuine matching identity and failed status, empty final text and the proxy-facing 502 timeout error; direct exit code is 1. The original caller boundary/inspection flags are false and no artifact oracle ran. The evaluation’s generic cleanup-insufficient message does not prove leaked processes: the parent observed direct exit/close and the group absent at its probe. The one successful response contributes a known subtotal, but total accounting remains unknown. This is before the health window; neither the tool error nor transport evidence proves an arithmetic result or provider-side cause.

### #37 — docx_report-v2-r0-hermes

All six supplied facts are present across document paragraphs plus the correct Action/Due table. Action and due occur only in the table, contrary to the explicit instruction to include all supplied facts in readable paragraphs as well. This is a paragraph-location contract failure, not evidence of missing facts throughout the document.

### #38 — docx_report-v2-r0-atlas

All six supplied facts are present across document paragraphs plus the correct Action/Due table. Action and due occur only in the table, contrary to the explicit instruction to include all supplied facts in readable paragraphs as well. This is a paragraph-location contract failure, not evidence of missing facts throughout the document.

### #52 — pptx_revision-v1-r0-atlas

Atlas inspected the source, then its first python_execute failed with an IndentationError. The second Python call successfully saved artifacts/operations-revised.pptx. The third read the delivered deck and reported old target absent/new target present on slide 2. Final text identifies that deck and claims preservation. The original binding and artifact oracle pass; the retained 30,203-byte file still matches both the original binding and native snapshot. The final verification tool itself checks replacement text only, so the broader preservation assessment is the original oracle’s evidence, not that narrow tool check alone. After the completed final answer, request 6 contains explicit public chat-title instructions and the opening user/assistant summary. It timed out after 95,229 ms. Source file-atlas-runner.ts awaits title generation but catches title errors, permitting the native turn to remain completed. This declared full-turn study lifecycle deliberately captures title accounting; ordinary HTTP routes schedule generation in the background, so this observation does not prove that ordinary users wait for title completion before seeing the file; the broker still marks mandatory totals unknown. Primary remains false. The matching closed sleep/wake records support this arm’s 78.779-second wall/monotonic divergence, without isolating the transport timeout’s cause.

### #53 — docx_report-v1-r0-atlas

The only request failed in 5 ms with “Unable to connect. Is the computer able to access the url?” and null captured upstream status. The genuine Atlas native receipt reports failed, empty final text and zero public tool events. No report-generation action or certified deliverable is evidenced. Original boundary/inspection flags are false; no DOCX oracle ran. This is a transport/native-completion failure with unknown usage, distinct from the seven completed DOCX oracle failures. It lies in the released health window after a wake category, but its own clocks do not show a large divergence. Timing proximity does not establish the individual failure cause.

### #54 — docx_report-v1-r0-hermes

Five requests failed with null upstream statuses and connection/URL diagnostic messages, each after 0–2 ms. Every available request has zero assistant/tool history; there is no successful response in the captured wire set. The process deadline fired, SIGTERM was sent and the child exited by SIGTERM; stdout was empty, so native identity, final text, tools and native cleanup receipt remain unavailable. Original caller status is accounting_uncertain, which takes precedence over the separately recorded budgetExceeded flag. Original inputIdentical:false here is absence of a verified native input-copy report, not a demonstrated foreign input assignment. The independently bound parent schedule/input lifecycle retains the failed arm. No file oracle ran. Total wall 950.750 s versus monotonic 8.141 s corresponds to the closed host suspension interval; no attempt is removed or retried.

### #55 — docx_revision-v2-r1-hermes

Two requests failed after 2 and 1 ms, with null upstream statuses and connection/URL messages; neither includes assistant/tool history. No successful wire response is retained. Deadline termination produced empty native stdout and no genuine native identity or completion/cleanup report. Parent exit/close and absent-group probe are observed; all descendants gone remains unproved. The required date-only revision and source preservation cannot be evaluated from absent native evidence, and the original oracle is null. Original accounting_uncertain status and budgetExceeded flag remain. Total wall 912.545 s versus monotonic 2.845 s aligns with the closed host suspension evidence; this does not isolate the cause of either request failure.

### #56 — docx_revision-v2-r1-atlas

One request failed after 2 ms with “Unable to connect. Is the computer able to access the url?” and null upstream status. The genuine matching Atlas native report is failed with empty final text and zero tool events; direct exit code is 1. No date-edit action or successful artifact is evidenced, inspection is disallowed and no original oracle ran. Mandatory totals are unknown even though the reported observed subtotal is zero. This short attempt lies between long divergent-clock attempts in the released health window; no large clock gap is observed in this row itself and no specific network/provider cause is established.

### #57 — code_fix-v1-r1-atlas

One request failed after 1 ms with “Was there a typo in the url or port?” and null upstream status. The native report retains matching identity, failed status, empty final text and zero tool events; direct exit code is 1. There is no public contract read, code write or public-test execution. The original isolated code oracle was not run, so this is not an arithmetic or admission counterexample. Mandatory totals remain unknown; zero observed subtotal is not certified zero usage. The short row is retained within the health window without attributing its diagnostic message to an actual typo or a specific provider fault.

### #58 — code_fix-v1-r1-hermes

The original upstream-request ledger contains zero requests and its finalized usage evidence reports known zero totals. The native queue separately records two arrivals at 09:07:40.383 UTC, both rejected by the broker budget guard before upstream admission; zero upstream requests does not mean zero arrival attempts. Preserve that original known-zero accounting; this row is not one of the ten unknown-accounting arms. The process deadline fired, SIGTERM was sent and the child exited by SIGTERM with empty stdout, leaving genuine native identity and task/tool/cleanup evidence unavailable. Primary status is budget_exceeded; no public or isolated code test ran. A runtime directory and parent identity do not substitute for native identity. Total wall 679.731 s versus monotonic 2.035 s matches the bounded host suspension evidence. These clocks do not imply 679 seconds of model execution, and no task result can be inferred.

### #59 — pptx_revision-v2-r1-hermes

Five requests failed after 1–3 ms with null upstream status and connection/URL messages; available requests show no assistant/tool history and no successful response. Parent deadline handling sent SIGTERM and observed a signal exit plus empty stdout. No genuine native identity, PPTX tool effect, final selection or native cleanup receipt is available; the original artifact oracle remains null. Accounting is unknown and the separate budgetExceeded flag is true. Total wall 359.581 s versus monotonic 9.967 s corresponds to the closed host suspension interval. The process group was absent at the probe, while arbitrary escaped-descendant containment remains unproved.

### #73 — csv_join-v2-r1-atlas

Atlas listed input files, read both CSV sources, then used pandas with customer_id explicitly typed as string and a left merge. python_execute returned exit 0, actual artifacts/joined.csv metadata and the eight-row CSV preview. The final answer clearly links that file. The original oracle and byte binding pass; the retained 283-byte CSV matches the original binding/native snapshot, and both source files match their initial hashes. After the final answer, request 5 is explicitly a chat-title request containing a public user/assistant summary. It timed out after 90,030 ms. The native turn remains completed because the title error is caught, but mandatory accounting remains unknown. The study adapter deliberately awaits this auxiliary lifecycle; ordinary HTTP title scheduling is background work, so no ordinary-UI delay claim follows. Accounting is unchanged and primary stays false. This arm occurs after the bounded health window; the earlier sleep records do not establish its timeout cause.

### #75 — docx_report-v2-r1-atlas

All six supplied facts are present across document paragraphs plus the correct Action/Due table. Action and due occur only in the table, contrary to the explicit instruction to include all supplied facts in readable paragraphs as well. This is a paragraph-location contract failure, not evidence of missing facts throughout the document.

Unscored limitation from the independent package inspection: The statement that resolved status, impact duration or financial loss has not been determined at this time is not established by the supplied input. The original limited forbidden-positive-phrase check passes; this inspection adds no score.

### #81 — docx_report-v0-r1-atlas

All six supplied facts are present across document paragraphs plus the correct Action/Due table. Action and due occur only in the table, contrary to the explicit instruction to include all supplied facts in readable paragraphs as well. This is a paragraph-location contract failure, not evidence of missing facts throughout the document.

### #82 — docx_report-v0-r1-hermes

All six supplied facts are present across document paragraphs plus the correct Action/Due table. Action and due occur only in the table, contrary to the explicit instruction to include all supplied facts in readable paragraphs as well. This is a paragraph-location contract failure, not evidence of missing facts throughout the document.

### #107 — docx_report-v1-r1-hermes

Case-sensitive oracle mismatch: all six supplied facts occur in readable paragraphs; cause and action begin in lowercase in prose. Their meaning is preserved. Exact action and due are also in the required table. No missing-fact or paragraph-omission conclusion is supported by these two failed checks.

### #108 — docx_report-v1-r1-atlas

All six supplied facts are present across document paragraphs plus the correct Action/Due table. Action and due occur only in the table, contrary to the explicit instruction to include all supplied facts in readable paragraphs as well. This is a paragraph-location contract failure, not evidence of missing facts throughout the document.

The seven DOCX package diagnoses are attributed to the separately closed root inspection, report SHA256 `752d1b63c339de4747a733df5c4e1d137785582f7c40b45e87321e788e8cb7ee`. Six are explicit paragraph-location failures; Hermes v1r1 instead contains all facts in paragraphs with two phrases in lowercase. Its original case-sensitive oracle failure is retained but is not factual inaccuracy. No DOCX rendering or visual-quality certification was performed. All eighteen detailed original flags, exact IDs, public final text and source references are in all-eighteen-failure-diagnoses.json.

## Accounting and resource denominators

The following figures are original analyzer resource fields over all 54 arms per harness, including failures. A known-row subtotal is not a complete billing total; observed request subtotals across all rows do not make unknown usage certain. Generated tokens include the provider’s reported completion accounting; hidden reasoning was not inspected. Cost is unavailable for all 108 arms.

| Original resource | Atlas | Hermes |
|---|---:|---:|
| Scheduled/observed arms | 54/54 | 54/54 |
| Upstream request records (all rows known) | 335 | 401 |
| Mandatory usage known / unknown | 48 / 6 | 50 / 4 |
| Prompt tokens, known rows only | 1,949,084 (48 rows) | 2,550,712 (50 rows) |
| Generated tokens, known rows only | 135,396 (48 rows) | 87,525 (50 rows) |
| Cached tokens, known rows only | 1,446,656 (48 rows) | 2,052,480 (50 rows) |
| Observed prompt subtotal, all rows | 2,012,853 | 2,587,187 |
| Observed generated subtotal, all rows | 139,063 | 89,945 |
| Caller monotonic ms, all 54 | 3,457,444.162 | 2,848,729.196 |
| Total-attempt monotonic ms, all 54 | 3,496,343.662 | 2,881,409.834 |
| Original recorded status counts | 329 × 200; 6 × 502 | 387 × 200; 14 × 502 |

The separate queue census records 742 arrivals = 736 admitted upstream request records + 6 budget rejections before upstream admission. The six rejected arrivals occur in #54 (one), #55 (two), #58 (two) and #59 (one), and do not become extra provider usage or replacement scored arms. In particular, the original zero upstream requests for #58 coexist with two rejected arrivals. all-108-queue-counters.json retains every original scalar row.

The status-count 502 values are broker-facing transport outcomes. Every failed request examined here has null captured upstream status; no upstream HTTP 502 attribution follows. The original provider HTTP response metadata for successful calls remains separate. No 401/403 appears in these original aggregate counters, which does not by itself establish a cause for the failures.

All ten unknown-accounting arms are explicitly retained in all-ten-unknown-accounting.json. Their original prompt/generated totals are null, even when observed subtotals are zero. Hermes #58 has zero admitted upstream requests and original known-zero accounting; absent native stdout does not silently turn it into an unknown-accounting row. The three oracle-pass failures (#2, #52, #73) remain failed primary outcomes. No full cost/efficiency ratio is certified from incomplete accounting.

## Closed health-window limitation

The prior health-only investigation is bound unchanged: health-note.md SHA256 `c7143720416cb640fee30fcec2df710167172acf96f75e0895078e7b35972257`. Five matching macOS sleep-entry/wake categories support host suspension corresponding to caller wall-minus-monotonic gaps of approximately 78.779 s (#52), 942.609 s (#54), 909.701 s (#55), 677.696 s (#58) and 349.615 s (#59). The gaps already exist inside native-process and full-caller intervals, not just later grading. The original total wall durations for #54/#55/#58/#59 are 950.750/912.545/679.731/359.581 s while original monotonic totals are 8.141/2.845/2.035/9.967 s. They must not be described as equivalent durations of model computation.

Rows #53, #56 and #57 are short transport failures within the same released window without large row-specific clock gaps; #51 and #60 are retained successful controls around it, and #60 has five successful HTTP 200 responses. Category timestamps include sleep preparation/wake transitions and are not exact asleep-duration counters. The evidence does not identify the cause of every transport error, establish an upstream provider outage, or by itself decide study validity. Rows #2, #3 and #73 lie outside that bounded window and are not assigned its cause. No affected arm is dropped, retried or rescored; the original environment condition limits a clean comparison of harness-only latency or reliability.

For the four missing Hermes native observations, parent identity/lifecycle and input assignment remain independently attributable, but native identity/input-copy/cleanup/output evidence stays unavailable. Original inputIdentical:false is not positive evidence of a foreign input. The raw archive’s 108 indexed directories do not establish 108 genuine native identities. Direct child exit/close plus an absent process-group probe does not prove arbitrary escaped descendants are gone.

## Evidence and closure

This is retrospective inspection registered after full phase and original analysis closure. The helper SHA256 is `31439611c681aa7917baf51cc3ea2cfcf1a7f60c5c0ed56e4866d9e21aba4f03`; the full census SHA256 is `69cc6a8257df6ddf7ca336000bd28f5922eee342ed35ff14f97c354531964dbf`. Original analysis SHA256 is `180ceb12182c8febc7c13f3290f2140ea787784b2ddab94f8fbbbb4639920064`; completed receipt is `8a7dded6ee49daa91e03994c95d98fb139e8bcef0480764026ae2a6048e5d45c`.

Software remains C9 `e2daf1b902a087eb279724f17d61e50b9a27f7c1d64828f6958b61b22225eb98`, control map `b3673405fab43fdd268aa286d4f6f0164ea00c2332ba43d00e28abd3d538fde5`, fixed model mimo-v2.5 and original frozen study manifest `b50f7517975762665cd627e4c0493f5cbe6228d22c9581781b9100946d07b30f`. This reporting operation made no candidate/control/prompt/tool/budget change, model call, test/oracle/analyzer rerun or original-file edit. It makes no causal C9 improvement claim against earlier candidates and no provider/subscription-wide claim.

original-source-bindings.json retains 461 exact original/source file bindings, all reread and hash-matched before assembly closure; source archives were streamed for hashing without executing archived code. external-closed-evidence-bindings.json independently verifies the unchanged DOCX and health package members and binds the root raw-archive qualification. The separate instrumentation review is bound at /private/tmp/atlas-native-file-v3-c9-confirmation-independent-review/review.json, SHA256 402c0232b86b42c2490c39c5815053dece65dc91b55e9a93a58fb9ad4046cef0; its full archive/lifecycle audit is not counted as work rerun here. The root raw archive reports 6,496 files / 282,125,147 bytes, manifest `3e40586bea2272b083857105a8a19d54a852117484c9277fc515490de3d51eed`; this report does not repeat that archive's full verification. Manifest and closure bind this reporting pack separately.

One initial console-only exploratory projection loop reached a list-valued index file after displaying the intended selected public records and raised AttributeError. The corrected inspection uses the explicit 18-row failure inventory; original evidence was never edited, no model/test/oracle was run, and the incidental error is recorded in inspection-method-notes.json.
