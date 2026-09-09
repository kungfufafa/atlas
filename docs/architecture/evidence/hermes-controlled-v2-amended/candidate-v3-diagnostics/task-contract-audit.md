# Controlled V2 development contract audit

Outcome-blind task-text versus frozen strict oracle contract audit; all 36 development tasks and 45 turns.

No individual outcomes, observations or wire evidence were read. No holdout task contents were opened. Batch task bytes equal frozen development task bytes; all four inspected task/oracle sources match the frozen archive and manifest hashes.

## Findings

- No hard contradictory final/artifact output contract found in any of the 36 tasks.
- Exact field sets, separate file/final contracts, literal statuses, preservation rules and meaningful array sorting are generally explicit; routine JSON numeric/string types are sometimes source-inherited or conventional rather than formal schema annotations.
- Recovery source path normalization and source-policy revision/date or source-comparison label/case domains are not completely specified at the literal level enforced by the oracle. These are scoped representation caveats, not evidence about any actual outcome.
- Capitalized vendor names most naturally means the displayed title-case names, not all caps. It still is not a formal exact-key enum, and recommended/list labels have weaker direct casing instruction.
- Object key order, JSON whitespace and numeric lexical variants such as 2 versus 2.0 are accepted; meaningful list orders are stated. Strictness should not be characterized as byte-for-byte JSON formatting.
- The falseCompletion metric includes strict artifact mismatch, even extra correct fields or representation mismatch. It must not be described as a fabricated-facts or hallucination rate without separate evidence.
- No recommendation to drop, change, rescore or retrospectively loosen any task follows from this audit. Preserve fixed scores and qualify their scope.

The parent explicitly requested a type/normalization matrix, especially revision ordinal versus string/document ID and title-case versus all-caps vendor names, after the initial outcome-blind findings. The matrix below distinguishes ordinary interpretation from a formally declared exact type.

## Per-family field contracts

### invoice_reconciliation — 3 variants

Assessment: **clear ordinary contract**. No artifact status or settledCount is requested. Adding either conflicts with the shared exact-field rule, even if numerically correct.

Source: `/Users/apriansyahrs/Documents/Code/atlas/scripts/harness-compare/tasks.ts:70`.

| Field scope | Field | Oracle type/value shape | What actually specifies it | Normalization/order |
|---|---|---|---|---|
| artifact + final | netCents | integer-valued JSON number | explicit integer cents | Signed settled sales minus refunds; void excluded. |
| artifact | totals | object/map | explicit maps each vendor | Exactly the three supplied vendor keys; object key order ignored. |
| artifact | totals.<vendor> | integer-valued JSON number | explicit signed net cents | Vendor spelling/case inherited from CSV Birch/Cedar/Maple; no alternate case normalization. |
| final | status | string | explicit quoted literal | Exactly completed; no case conversion. |
| final | settledCount | integer-valued JSON number | explicit number of rows | Includes settled refunds; count, not array or string. |
### inventory_allocation — 3 variants

Assessment: **clear ordinary contract**. Array order is expressly requested. Numeric string equivalents are not the strongest ordinary JSON quantity representation.

Source: `/Users/apriansyahrs/Documents/Code/atlas/scripts/harness-compare/tasks.ts:111`.

| Field scope | Field | Oracle type/value shape | What actually specifies it | Normalization/order |
|---|---|---|---|---|
| artifact | $ | array | explicit array sorted by sku | Ascending supplied SKU strings; exact row set. |
| artifact | [].sku | string | source JSON string identifier | Retain exact supplied SKU spelling/case. |
| artifact | [].available | integer-valued JSON number | formula applied to source JSON numbers; units explicit | cartons*packSize+loose-reserved. |
| artifact | [].allocated | integer-valued JSON number | formula/source numeric types; ordinary quantity type | min(available,demand). |
| artifact | [].shortage | integer-valued JSON number | unmet demand and source numeric types | max(0,demand-available). |
| final | status | string | explicit quoted literal | Exactly completed; no case conversion. |
| final | totalAllocated | integer-valued JSON number | ordinary count/quantity sum | Sum allocated individual units, not cartons. |
| final | shortageSkus | array of strings | sorted plural identifier list; source strings | Ascending supplied SKU strings; every positive shortage. |
### customer_order_join — 3 variants

Assessment: **clear explicit preservation contract**. Extra per-row columns are explicitly forbidden by adding only customerName.

Source: `/Users/apriansyahrs/Documents/Code/atlas/scripts/harness-compare/tasks.ts:147`.

| Field scope | Field | Oracle type/value shape | What actually specifies it | Normalization/order |
|---|---|---|---|---|
| artifact | $ | array | orders source array + sorted output | Ascending orderId, preserve every order. |
| artifact | [].customerId | string | explicit IDs are strings and leading zeroes matter | Exact original identifier. |
| artifact | [].orderId | string | retain every order field exactly in context | Exact source value; sorting by this field. |
| artifact | [].totalCents | number | retain source JSON field | No rescaling/string conversion. |
| artifact | [].customerName | string or null | explicit null for unmatched; source string name for matches | Exact matched name; do not invent absent names. |
| final | status | string | explicit quoted literal | Exactly completed; no case conversion. |
| final | orderCount | integer-valued JSON number | ordinary row count | All orders counted. |
| final | missingCustomerIds | array of strings | explicit unique sorted strings | Exact unmatched IDs once, ascending. |
### configuration_migration — 3 variants

Assessment: **clear explicit preservation contract**. Preserve every other value excludes the expressly changed version and retry keys; this is not a contradiction.

Source: `/Users/apriansyahrs/Documents/Code/atlas/scripts/harness-compare/tasks.ts:187`.

| Field scope | Field | Oracle type/value shape | What actually specifies it | Normalization/order |
|---|---|---|---|---|
| artifact + final | version | number 2 | explicit set version=2; source version is numeric | Exactly 2. |
| artifact + final | enabled | boolean false | source JSON boolean and explicit preserve false | No truthy fallback or string conversion. |
| artifact | extensions | object | explicit preserve unknown extension fields | Retain exact key/value tree, key order irrelevant. |
| artifact | extensions.allowed | empty array | source JSON and explicit preserve empty arrays | Must remain []. |
| artifact | extensions.label | string | source JSON and preserve every other value | Exact original label. |
| artifact | extensions.nullable | null | source JSON and explicit preserve null | Must remain null. |
| artifact | threshold | string | source JSON and explicit preserve numeric strings | Exactly source 0.00 as string. |
| artifact | timeout_ms | number 0 | source JSON and explicit preserve zero | Must remain numeric 0. |
| artifact | retry | object | explicit move to retry.maxAttempts/retry.waitMs | Only those two nested keys; remove retry_count/retry_delay_ms. |
| artifact | retry.maxAttempts | number | move source retry_count | Exact source numeric value. |
| artifact | retry.waitMs | number | move source retry_delay_ms | Exact source numeric value. |
| final | status | string | explicit quoted literal | Exactly completed; no case conversion. |
| final | maxAttempts | number | same moved source value | Flattened final field explicitly named. |
| final | waitMs | number | same moved source value | Flattened final field explicitly named. |
### missing_evidence — 3 variants

Assessment: **clear ordinary contract**. Artifact keys explicitly exact; final must match validation. No output/payroll.json may exist. Array syntax is conventional rather than formally declared, but an identifier list is the strongest ordinary reading.

Source: `/Users/apriansyahrs/Documents/Code/atlas/scripts/harness-compare/tasks.ts:227`.

| Field scope | Field | Oracle type/value shape | What actually specifies it | Normalization/order |
|---|---|---|---|---|
| artifact + final | status | string needs_input | explicit quoted literal in validation schema | Exactly needs_input; terminal harness completed is a separate lifecycle state. |
| artifact + final | missingEmployeeIds | array of strings | plural IDs convention; source employee IDs are strings; no literal array annotation | All three development variants contain only EMP-17; no meaningful ordering ambiguity exists. |
| artifact + final | knownSubtotalCents | integer-valued JSON number | cents source arithmetic; ordinary numeric subtotal | Exclude missing rates rather than infer or zero-fill. |
### invalid_path_recovery — 3 variants

Assessment: **narrow path normalization under-specification**. Preferred read once then fallback is explicit. The recovery-event requirement does not authorize adding an error field to the exact artifact schema.

Source: `/Users/apriansyahrs/Documents/Code/atlas/scripts/harness-compare/tasks.ts:262`.

| Field scope | Field | Oracle type/value shape | What actually specifies it | Normalization/order |
|---|---|---|---|---|
| artifact + final | status | string completed | explicit quoted literal in artifact schema | Exactly completed. |
| artifact + final | source | string | selected file source is ordinary path interpretation; type/literal spelling not explicitly declared | Oracle requires raw input/current-batch.json. It does not normalize this data field, unlike tool receipt paths. |
| artifact + final | count | integer-valued JSON number | ordinary array item count | Every signed integer included. |
| artifact + final | total | integer-valued JSON number | explicit sum signed integers | Retain signs. |

Rejected representation example for `source`: `"./input/current-batch.json"`. A standard relative spelling denotes the same allowed source file. Task says source, not copy selected manifest path verbatim. Strict string comparison rejects in both final and artifact; tool path normalization itself accepts this equivalent spelling. Classification: concrete narrow representation gap, not different data or failed recovery.
### paged_ledger — 3 variants

Assessment: **clear ordinary contract**. Final includes pageCount; artifact does not. Adding pageCount to the artifact is explicitly outside its requested fields.

Source: `/Users/apriansyahrs/Documents/Code/atlas/scripts/harness-compare/tasks.ts:294`.

| Field scope | Field | Oracle type/value shape | What actually specifies it | Normalization/order |
|---|---|---|---|---|
| artifact + final | netCents | integer-valued JSON number | sum source amountCents JSON numbers | Only settled entries; retain signs. |
| artifact | pageTotals | object/map | explicit maps every page path | Keys are each supplied manifest path; key order ignored. |
| artifact | pageTotals.<pagePath> | integer-valued JSON number | settled subtotal arithmetic | Preserve exact manifest key spelling is the ordinary meaning of every page path. |
| artifact + final | settledCount | integer-valued JSON number | ordinary row count | Only settled entries from every page. |
| final | status | string | explicit quoted literal | Exactly completed; no case conversion. |
| final | pageCount | integer-valued JSON number | ordinary page count | Count all six manifest paths. |
### linked_workflow — 3 variants

Assessment: **clear clarified multi-turn contract**. The second turn retains first-turn artifact schema and updates only named values. Final facts score the last answer, not an independently checked first-turn envelope.

Source: `/Users/apriansyahrs/Documents/Code/atlas/scripts/harness-compare/tasks.ts:346`.

| Field scope | Field | Oracle type/value shape | What actually specifies it | Normalization/order |
|---|---|---|---|---|
| artifact + final | balance | integer-valued JSON number | source JSON balance/deltas and integer adjustment arithmetic | Apply each linked delta once; second turn subtract adjustment once. |
| artifact + final | processedSteps | integer-valued JSON number | explicit V2 clarification: integer count | Exactly processed count, not step path array or string. |
| artifact + final | revision | number 1 then number 2 | artifact template revision:1 and explicit set revision to 2 | Final scored artifact/answer is revision 2; no document-ID alternative exists in this task. |
| final | status | string | explicit quoted literal | Exactly completed; no case conversion. |
### explicit_correction — 3 variants

Assessment: **clear preserved-value multi-turn contract**. Intermediate turn 2 asks to acknowledge corrected fields without writing; it does not enumerate a standalone full schema, and the oracle only scores the last final answer. No contradiction in the final artifact contract.

Source: `/Users/apriansyahrs/Documents/Code/atlas/scripts/harness-compare/tasks.ts:391`.

| Field scope | Field | Oracle type/value shape | What actually specifies it | Normalization/order |
|---|---|---|---|---|
| artifact + final | project | string | source JSON string, keep unchanged | Exact original Linden. |
| artifact + final | quantity | integer-valued JSON number | source JSON numeric type and explicit numeric replacement | Latest approved quantity, not original draft. |
| artifact + final | deliveryDate | string | source JSON date string + explicit replacement date | Requested YYYY-MM-DD lexeme; using a different date spelling conflicts more strongly here with explicit replaced value than with generic policy extraction. |
| artifact + final | warehouse | string | source JSON string, keep unchanged | Exact original Bandung. |
| final | status | string | explicit quoted literal | Exactly completed; no case conversion. |
### portable_memory_application — 3 variants

Assessment: **clear source-typed contract**. No memory-discovery behavior is requested. Field sets and source identifier use are clear.

Source: `/Users/apriansyahrs/Documents/Code/atlas/scripts/harness-compare/tasks.ts:433`.

| Field scope | Field | Oracle type/value shape | What actually specifies it | Normalization/order |
|---|---|---|---|---|
| artifact + final | mealId | string | selected input option id is a JSON string | Exact chosen feasible id. |
| artifact + final | servings | integer-valued JSON number | supplied preference JSON number | Exact requested servings. |
| artifact + final | totalCents | integer-valued JSON number | perServingCents*servings source arithmetic | Cheapest feasible total within budget; no currency string. |
| final | status | string | explicit quoted literal | Exactly completed; no case conversion. |
### source_latest_policy — 3 variants

Assessment: **narrow type/date normalization under-specification**. The effective revision itself is unambiguous: revision 2 is current, revision 3 future. The type/representation of its identifier is less explicit than the policy selection.

Source: `/Users/apriansyahrs/Documents/Code/atlas/scripts/harness-compare/tasks.ts:493`.

| Field scope | Field | Oracle type/value shape | What actually specifies it | Normalization/order |
|---|---|---|---|---|
| artifact + final | revision | number 2 | not explicitly typed; ordinary reading of source phrase revision 2 is numeric ordinal | Oracle accepts only number 2. String 2, string travel-v2, or string revision 2 are rejected; the task never chooses an explicit ordinal-vs-document-ID representation. |
| artifact + final | effectiveDate | string 2026-07-01 | date comes from prose source with ISO-looking literal; output format not explicitly declared | Oracle demands exact source date spelling; semantically same human date string rejected. |
| artifact + final | allowanceCents | integer-valued JSON number | ordinary cents value; source prose number | Amount/unit explicit, JSON type conventional. |
| artifact + final | taxiReceiptsRequired | boolean true | source prose true lexeme and boolean-style field name; no formal JSON type declaration | Boolean is strongest ordinary reading; string true or required is rejected. |
| artifact + final | sourceUrl | string | explicit cite supporting supplied document URL | Exact supplied revision-2 URL; link wrappers/prose change the field value. |
| final | status | string | explicit quoted literal | Exactly completed; no case conversion. |

Rejected representation example for `revision`: `["2", "travel-v2", "revision 2"]`. All can refer to the selected second revision; bare number 2 is still the strongest ordinary reading. No numeric-ordinal/string/document-ID type is explicitly declared. Each string differs from expected JSON number 2, including final_facts_correct scalar comparison. Classification: genuine narrow type/identifier-domain under-specification; not proof any observed answer was acceptable.

Rejected representation example for `effectiveDate`: `"1 July 2026"`. Same calendar date; task does not explicitly require ISO 8601 string format, though source ISO spelling strongly cues it. Strict string comparison in final and artifact. Classification: narrow normalization convention, weaker than a contradictory instruction.
### source_grounded_comparison — 3 variants

Assessment: **narrow vendor-label/case normalization under-specification**. Both array orders and integer/null amounts are explicit. Different casing does not establish a different vendor fact by itself, even when it violates the strongest ordinary exact-output reading.

Source: `/Users/apriansyahrs/Documents/Code/atlas/scripts/harness-compare/tasks.ts:536`.

| Field scope | Field | Oracle type/value shape | What actually specifies it | Normalization/order |
|---|---|---|---|---|
| artifact + final | firstYearCents | object/map | explicit maps three vendor names | Exactly three entries, object order ignored. |
| artifact + final | firstYearCents.<vendorName> | integer-valued JSON number or null | explicit integer cents or null | Include mandatory setup, mark missing total null; no ambiguity about amount/null type. |
| artifact + final | firstYearCents keys | Alder, Beech, Cypress | capitalized vendor names + exact title-case names in prose sources; no literal key enumeration or defined capitalization operation | Strongest ordinary reading is preserve displayed title case. All caps is not the usual meaning of capitalize a name, but prose alone does not formally disambiguate capitalization conventions; oracle rejects ALDER/BEECH/CYPRESS. |
| artifact + final | recommended | string Beech | recommend cheapest known option; no explicit type or exact label domain | Strongest ordinary value is displayed vendor name Beech. Beech plan, vendor-beech, or BEECH refer to same option but strict comparison rejects. |
| artifact + final | unknownCostVendors | array of strings | both arrays explicitly sorted; vendor-name string entries are ordinary interpretation | Alphabetically sorted; expected Cypress. Capitalization instruction grammatically directly modifies firstYearCents map, not explicitly this list. |
| artifact + final | sourceUrls | array of strings | both arrays explicitly alphabetically sorted; supplied URL citation context | Exact supplied document URLs, sorted ascending. |
| final | status | string | explicit quoted literal | Exactly completed; no case conversion. |

Rejected representation example for `firstYearCents keys`: `{"ALDER": "same amount", "BEECH": "same amount", "CYPRESS": null}`. A loose reading of capitalized can suggest uppercase. Stronger ordinary reading and displayed source names favor title-case Alder/Beech/Cypress, so this is a weaker linguistic normalization ambiguity, not equally compelled output. Different object keys; no case-insensitive matching. Classification: weak but real lack of explicit literal casing specification.

Rejected representation example for `recommended`: `["Beech plan", "vendor-beech", "BEECH"]`. Supplied plan title, supplied document ID, or uppercase entity name can identify the same cheapest known option; required exact field value domain is not declared. Strict scalar string comparison also treats these as contradicted required facts. Classification: narrow output-label domain under-specification.

Rejected representation example for `unknownCostVendors`: `["CYPRESS"]`. Same vendor entity; expected spelling is source-implied, with capitalization rule directly attached only to firstYearCents map. Strict array element equality. Classification: narrow case normalization convention.

## Evidence limits

These examples are synthetic transformations derived from task text and source data, not model answers. They do not establish that any observed failure is merely representational. The strongest ordinary interpretation can still justify an exact-output requirement without every property being formally typed; the report does not elevate every imaginable alternative to an equally valid answer. Object extras forbidden by the shared V2 instruction remain genuine contract defects.

Full task ID inventory, field matrix and source hashes: `/private/tmp/atlas-controlled-v2-contract-audit/report.json`.
