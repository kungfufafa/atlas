# Candidate5 isolated assembly — final gates pending

This new source combines exact verified candidate4 with the reviewed task-stop candidate's patch. It does not apply anything to root or change either earlier scratch. Candidate4 remains preserved and has not been run as a live candidate. Root remains candidate3.

Inputs are copied immutably under inputs/. Candidate3 archive SHA e738224f0c13eeae6a2a3739900f983d879f6cab88171e5bd570adc7634e09c5 and its 2072 source bytes were verified. All 2076 candidate4 files were verified before copy and before applying the stop patch. The original task-stop 2078-file source and every root candidate3 source file were reverified after assembly.

The only integration-only edit is parent-requested template-literal formatting of two expressions in stoppedTaskError; integration-amendment.json records exact before/after hashes. The original stop patch/evidence remains unchanged. There is no implementation conflict or overlap between candidate4's 12 changed/new files and the task-stop six-file patch. Combined delta against candidate3 is 18 files: 12 existing and six new; 11 production and seven tests.

combined.patch and production.patch target candidate3. Both pass git apply --check on the unchanged root; neither was applied. Source aliases point to this isolated source from root and server importer paths; installed dependency directories are reused by read-only symlinks. No packages were installed, no tests or external account calls launched during this assembly.

Gate plan is one deduplicated 19-file regression union spanning native-memory scope, conversation retrieval and source fidelity, numeric tokenization, mechanical stop signaling, task status, persistence, cancellation and output-limit recovery; plus one full production typecheck, changed-source-and-tests typecheck and scoped 18-file lint. These gates are deliberately NOT RUN yet, pending parent's explicit confirmation that the paid 96-arm batch is closed. Previous constituent pass counts are evidence for those earlier sources, not a claim that candidate5 passed integration.

Independent substantive task-stop review is also pending. Final readiness must require that review, actual final gates, and fresh before/after source verification. No release, root application, model-quality improvement or evaluation result is claimed here.
