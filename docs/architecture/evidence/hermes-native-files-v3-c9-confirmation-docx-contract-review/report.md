# Closed C9 confirmation DOCX contract inspection

The original seven DOCX oracle failures remain failed. Six are paragraph-location failures; one is a case-sensitive oracle mismatch with the supplied facts still present in paragraphs. This inspection does not rescore any arm or certify visual polish.

The assigned task explicitly requires every supplied incident fact in readable paragraphs, then a separate Action/Due table. The frozen oracle reads top-level document paragraphs and performs case-sensitive string matching for nonnumeric facts; the table has its own check. The prompt explicitly requests an exact title, but does not explicitly require the cause and action phrases to preserve capitalization. Therefore the seventh failure should not be described as factual inaccuracy.

| Original arm suffix | Original failed checks | Read-only finding |
| --- | --- | --- |
| docx_report-v2-r0-hermes | fact:action, fact:due | Correct action/due appear only in the required table. |
| docx_report-v2-r0-atlas | fact:action, fact:due | Correct action/due appear only in the required table. |
| docx_report-v2-r1-atlas | fact:action, fact:due | Correct action/due appear only in the required table. |
| docx_report-v0-r1-atlas | fact:action, fact:due | Correct action/due appear only in the required table. |
| docx_report-v0-r1-hermes | fact:action, fact:due | Correct action/due appear only in the required table. |
| docx_report-v1-r1-hermes | fact:cause, fact:action | All six facts are in paragraphs; lowercase cause/action text fails the case-sensitive matcher. |
| docx_report-v1-r1-atlas | fact:action, fact:due | Correct action/due appear only in the required table. |

For Hermes v1r1, the input contains `Barcode printer offline` and `Replace printer cable`. Its prose contains `barcode printer offline` and `replace printer cable`. Incident INC-2000, owner Nara Wijaya, 17 affected orders, cause, action and due 2026-10-12 are all represented in its paragraphs. The table preserves the exact supplied action and due. The two original failed checks are not evidence of omitted facts. This diagnosis retains the original score and does not create an alternative favorable comparison.

For the other six, the document collectively contains the supplied facts, including correct table values. Omitting action/due from the paragraph portion violates a separately explicit placement requirement. Neither generic factual loss nor unreadable/corrupt DOCX files is established by these failures.

Atlas v2r1 also says that no resolved status, impact duration or financial loss has been determined at this time. The input does not establish that state. The original limited forbidden-positive-phrase check passes; it is not a comprehensive supported-fact audit. This observation is unscored and does not add an eighteenth/nineteenth failure or change any outcome.

The read-only helper opened the seven exact native ZIP packages, extracted bounded `word/document.xml`, and retained top-level paragraph/table text. All seven artifact SHA-256 values match their original ledger binding, and all 30 source bindings remained unchanged after inspection. The complete assigned task turns, supplied inputs, original oracle checks and package projections are in `public-package-projections.json`; precise per-arm diagnoses are in `all-seven-diagnoses.json`.

This was retrospective diagnosis after all 108 attempts and the once-only frozen analyzer had closed. No oracle, model, analyzer, test, document renderer or original artifact was executed or modified. No population, provider-wide, visual-quality or Atlas/Hermes parity claim follows from this inspection.
