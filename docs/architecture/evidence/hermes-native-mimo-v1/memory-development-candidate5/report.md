# Candidate 5 native MiMo memory development

The complete frozen schedule finished on 2026-09-07 at 00:26:10 UTC: 48 pairs, 96 terminal attempts, no missing/ambiguous arms or source changes. Frozen analysis validity passes. Atlas candidate is `1b44dd862ed3dac305c1ebe86dabda28c0de085c6a1d9fc1f6f1eb5eaa7dca2d`. Hermes remains pinned at `089bb32886c8c18f7fa20182c7bf8826d6935ac5`. This is development evidence, not confirmatory equivalence or superiority.

| Warm condition | Atlas primary | Hermes primary | Atlas exact factual endpoint | Hermes exact factual endpoint | Atlas strict | Hermes strict |
|---|---:|---:|---:|---:|---:|---:|
| Native default | 14/16 | 14/16 | 15/16 | 14/16 | 14/16 | 11/16 |
| Explicit memory | 16/16 | 15/16 | 16/16 | 16/16 | 16/16 | 15/16 |

The explicit-memory primary difference is entirely due to unknown usage on a Hermes main-request timeout followed by a real retry and correct recall. Both harnesses gave correct required explicit-memory values in all 16 cases. This is not evidence that Atlas recalls those facts better. Native-default Atlas still misses the observed 90% aggregate and 80% family floors. The unchanged family-bootstrap intervals are −18.75 to +18.75 percentage points for default and 0 to +18.75 for explicit. Nominal coverage/power with eight families is not established; these exploratory intervals do not certify a five-point noninferiority claim. The confirmatory schedule remains unopened/unrun.

All seven original primary failures are retained:

| Original arm | What the public/effect evidence supports |
|---|---|
| Atlas forgotten_preference-1907, default warm | First main request timed out before save, withdrawal or recall; unknown usage. This is not demonstrated forgetting failure. |
| Atlas cross_language-2953, default warm | Correct completed recall; auxiliary title request timed out and usage stays unknown. |
| Hermes cross_language-2953, default warm | Returned nulls after empty searches despite retained training history: a retrieval miss. |
| Hermes episodic_decision-1907, default warm | Correct rail choice rendered as `Rail shipping`; the unchanged exact `rail` representation endpoint fails. |
| Hermes unsupported_fact-1907, explicit warm | Main request timeout, real retry and correct recall; unknown failed usage remains a primary failure. |
| Atlas durable_fact-2953, explicit different-user control | Same-profile fact transfer; this differs from the null-control oracle but is not by itself a tenant ACL violation or fabricated completion. |
| Atlas durable_fact-2953, explicit different-organization control | First main request timed out before acquiring facts; not demonstrated cross-tenant transfer. |

All 32 cold/identity controls remain separate from warm recall. Their complete tables and original format findings are in analysis-final.json. The frozen `falseCompletion` diagnostic means a wrong exact required field; its three positive C5 labels above must not be relabeled as three fabricated finished-work claims. Manual public-process review is a distinct endpoint and does not change scores.

All 96 public-process dispositions were sealed: 64 warm and 32 controls. They include tool-bearing public text, actual effects and snapshots, excluding hidden reasoning. Ancillary unsupported statements, arithmetic/timeline errors, temporary notes, repaired tool calls and proper save receipts remain visible even when required final values are correct. The independent 20-arm diagnostic review agrees within its selected scope; it does not independently certify the other 76 arms.

Across all 48 attempts per harness, Atlas made 392 provider requests and Hermes 399. The broker observed 787 HTTP-200 responses and four synthetic 502 responses reporting upstream timeouts, not four upstream HTTP-502 responses. Three Atlas arms and one Hermes arm have incomplete usage. Observed generated-token lower bounds are 118,211 Atlas versus 45,670 Hermes; prompt-token lower bounds are 2,515,273 versus 1,389,247. Complete token/cost totals remain unknown. Mean whole-attempt latency is 67.40s Atlas versus 46.44s Hermes. These are full-attempt descriptive records, not a price comparison or causal efficiency claim.

Candidate 3, candidate 5 and prior DeepSeek conditions are retained separately. Source changes, stochastic/provider behavior and time differ; development-seed reuse is deliberate and is not held-out validation. No candidate/version/model results are pooled and no original score is rewritten.
