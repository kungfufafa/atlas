# Native comparison V2: reproducibility evidence

This pack records **scripted, offline instrumentation validation**, not Atlas or Hermes model performance. Each final pilot used deterministic localhost responses: four memory trajectories with 16 fake provider calls, and four native XLSX/CSV trajectories with 12 fake calls. Both archived analyses were valid and both source guards passed for candidate 3, source SHA `538c98b4f872e57e6c47d08fde1cd45cb3e591aa8462abde93fb3ec57e38bc74`.

**Native freeze and live execution are on hold.** Review of the earlier native-memory study identified unresolved endpoint compatibility for Hermes auxiliary session-title requests. The queue-lifetime amendment does not fix upstream rejection of an auxiliary JSON schema. Fake responses cannot establish that the live endpoint accepts those requests or returns complete usage. Root must resolve this launch gate before authorizing a native freeze or pilot. The copied readiness and independent review remain evidence of the controls they actually checked, not a guarantee of live compatibility.

The amendment separates descriptive evaluator IDs from opaque model-facing transport, session and state IDs, binds private identity mappings to archived observations, and keeps admission occupied until a disconnected request's broker response/accounting settles. Task/oracle sources, budgets and exact seeded schedule projections are unchanged. Original studies remain separate; earlier results are neither rescored nor pooled.

## Contents

| File | Evidence |
| --- | --- |
| [readiness.json](readiness.json) | Exact final controls, candidate identity, guarded pilot references and gate results |
| [independent-native-v2-review.json](independent-native-v2-review.json) | Independent source review, resolved findings, limits and final reviewed hashes |
| [original-control-bindings.json](original-control-bindings.json) | The exact 49-file original inventory verified unchanged |
| [final-pilot-bindings.json](final-pilot-bindings.json) | Final batch, archive-index, completion and per-arm evidence hashes without model transcripts |
| [gate-summary.json](gate-summary.json) | Existing unit, native, independent, typecheck and lint evidence; overlapping counts are not performance samples |
| [source-copies.json](source-copies.json) | Byte-preserved report origins and reviewed queue delta |
| [launch-status.json](launch-status.json) | Current explicit launch hold and its scope |

Large archives, native state, credentials and raw request/response traces are not included. Referenced temporary evidence must be retained separately to replay the full historical audit. Archive byte hashes here come from each finalized archive index; packaging did not rerun tests or reread large archives. Earlier pilots that preceded the inventory correction remain referenced and are not substituted for the final gates.

## Conditional freeze and live pilot commands

These are documented commands only; none was executed to create this pack. Run them **only after root clears the launch hold**, with stable candidate/control sources and no competing measured run. `freeze` does not call the model. CLI `pilot` is unscored but uses the real provider and may incur usage; it requires frozen admission and is allowed once per candidate. Use separate new V2 study roots and preserve every attempt. The examples use the existing private credential path accepted by the memory runner; supply the already-authorized path if different without copying credentials into the study.

Memory:

```sh
bun /Users/apriansyahrs/Documents/Code/atlas/scripts/harness-product-compare-v2/memory-run.ts freeze --study-root /private/tmp/atlas-hermes-evaluation/memory-study-v2-candidate3

bun /Users/apriansyahrs/Documents/Code/atlas/scripts/harness-product-compare-v2/memory-run.ts pilot --study-root /private/tmp/atlas-hermes-evaluation/memory-study-v2-candidate3 --key-file /private/tmp/atlas-harness-private/opencode-key --candidate-label candidate3
```

Native filesystem and prepared Python:

```sh
bun /Users/apriansyahrs/Documents/Code/atlas/scripts/harness-product-compare-v2/file-run.ts freeze --study-root /private/tmp/atlas-hermes-evaluation/native-file-study-v2-candidate3

bun /Users/apriansyahrs/Documents/Code/atlas/scripts/harness-product-compare-v2/file-run.ts pilot --study-root /private/tmp/atlas-hermes-evaluation/native-file-study-v2-candidate3 --key-file /private/tmp/atlas-harness-private/opencode-key --candidate-label candidate3
```

The file track requires the exact prepared interpreter and reviewed macOS sandbox recorded in its protocol. A changed task, oracle, adapter or transport protocol requires a new manifest/study decision. A failed admission or request is retained; do not delete it or repeatedly invoke a phase until it passes.
