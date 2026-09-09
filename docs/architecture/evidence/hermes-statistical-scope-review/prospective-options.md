# Prospective options for a scoped 5pp noninferiority claim

This is a design proposal, **not an implemented, powered or experimentally calibrated new study**. It changes no current threshold, corpus, score, bootstrap result, freeze or claim decision. No current MiMo scored outcomes or holdout contents were read. I am not globally blinded: earlier DeepSeek development/native-memory evidence and offline instrumentation were inherited. The requested focus is a future analytically justified alternative to relying on eight/nine-family percentile-bootstrap coverage, including loss-only bounds and fixed-quota versus random sampling. The arithmetic below uses no observed evaluation data.

## A finite target and the independent unit

A concrete candidate sampling frame is a **new, frozen catalog**, with 100 independently specified cases in each of the existing nine file workflow categories (900 cases), and 100 acquisition/recall case specifications in each of the eight memory categories (800 cases). These counts define an illustrative finite frame, not a recommended execution budget or an already authored corpus. Each memory condition is a separate estimand over the 800-case frame. Cold/identity checks remain diagnostics. The existing family names are available in the [file preregistration](/Users/apriansyahrs/Documents/Code/atlas/docs/architecture/hermes-native-files-mimo-preregistration.md:55) and [memory preregistration](/Users/apriansyahrs/Documents/Code/atlas/docs/architecture/hermes-memory-mimo-preregistration.md:68); no current heldout instances would enter this new frame.

Catalog inclusion would require an operator-relevant workflow within the declared native capabilities and budget, fully available source information, an explicit output contract and an independently audited oracle. Cases should vary substantive layouts, instructions and edge cases, not merely substitute names/numbers in a template. Author and audit the entire list before drawing a sample or running either harness. Exclude duplicates and infeasible cases by those prospective criteria, never by a product's performance. Actual operator review is still needed to establish relevance; a synthetic catalog cannot stand in for all daily work.

Give each family weight 1/K and each case within its family weight 1/100. Define performance as expected success for this finite task distribution under one pinned model/endpoint/header, candidate, native setup and resource policy during the declared execution regime. This is **fixed-family** inference: it does not estimate performance on unseen families or other providers/subscriptions.

One independent unit is one newly sampled case with a complete paired Atlas/Hermes execution and fresh isolated runtime state. For memory, that includes the entire acquisition-to-recall trajectory; turns, sessions and auxiliary calls are not independent units. Within-pair outcomes may be correlated. Across-pair independence and stable execution probabilities are assumptions to justify, not consequences of a fresh directory. Randomized adjacent arm order limits order imbalance but cannot eliminate a common provider outage, model drift or shared time effect.

For the iid design, draw the family independently with probability 1/K, then a case uniformly **with replacement**, for every pair. Random counts by family are allowed; a missing sampled family can block the separate per-family quality gate. Do not retrospectively force quotas. For fixed equal quotas, draw m cases independently with replacement within each family. If instead sampling without replacement, or deliberately repeating one selected case, use an analysis justified for that sampling design; neither operation becomes iid merely because run IDs differ. If R repeats are wanted, regard the selected case plus its R paired repeats as a bounded block and count independent blocks, not R times as much evidence. Broader common-shock blocks require the same caution.

## A conservative NI claim that gives no credit for wins

Let A and H be binary task success for the paired products. Define q=P(A=0,H=1), r=P(A=1,H=0). Then

\[
\Delta=P(A=1)-P(H=1)=r-q\ge -q.
\]

Therefore a valid one-sided upper confidence bound **Uq < 0.05** gives the lower bound −Uq > −0.05 and suffices for the same strict 5pp NI tolerance. Uq ≤ 0.05 gives only the non-strict conclusion. This algebra does not require independence within a pair. It is deliberately sufficient, not necessary: equal win/loss probabilities of 10% have Δ=0 but cannot pass a loss-only 5% bound. It never proves superiority.

Both products always failing also has q=0. Consequently the existing observed ≥90% aggregate / ≥80% per-family Atlas floors, completion, integrity and known accounting gates must remain separate prerequisites. Those observed floors are not themselves confidence guarantees of population accuracy. A formal population-quality guarantee would require additional valid lower bounds and an explicit multiplicity plan. Report all four paired outcome cells, not just the loss bound.

Keep every scheduled pair and the original failure classification. Unknown correctness must not become a zero loss through dropping a pair; a future conservative loss analysis can prespecify the worst feasible loss value for ambiguous pairs, but current unknown-usage/provenance gates still block a qualifying product claim. This is no license to reclassify prior failures or reinterpret accounting-driven zeros as quality parity.

## A different future endpoint: probability of certified completion

There is a legitimate conceptual distinction in the current definitions. [Memory status](/Users/apriansyahrs/Documents/Code/atlas/scripts/harness-native-mimo-v1/memory-run.ts:776) and [file status](/Users/apriansyahrs/Documents/Code/atlas/scripts/harness-native-mimo-v1/file-run.ts:1160) make missing mandatory usage incompatible with success. The [analyzer](/Users/apriansyahrs/Documents/Code/atlas/scripts/harness-native-mimo-v1/product-analysis.ts:950) additionally requires known usage for every comparative arm, including failed arms. Neither frozen rule changes here.

A **new protocol** could explicitly target Y=1 only when the complete delivered result passes the fixed content/delivery checks and has the required finalization, usage and budget certificate; Y=0 when any of those conditions fails, including known absence of the certificate at the fixed deadline. In that endpoint, a recorded uncertified attempt is an observed binary failure, not an imputed answer about its unknown underlying correctness. Thus binary NI inference for Δ_cert=E(Y_Atlas)−E(Y_Hermes) does not intrinsically require the consumption of every failed attempt to be known. This is an application of the estimand distinction between defining an event as a component of failure versus treating the underlying result as missing; the general principle is described in [ICH E9(R1), composite-variable strategies, page 8](https://database.ich.org/sites/default/files/E9-R1_Step4_Guideline_2019_1203.pdf). That statistical analogy is not a regulatory endorsement of this software benchmark.

This endpoint is conservative about **certification**, but not necessarily conservative about the **comparative accuracy difference**. If Hermes produces a correct result without a usage certificate and Atlas produces a correct certified result, Y records an Atlas-only success. That cannot be described as a Hermes factual error. Both uncertified attempts produce no discordant loss, so a loss-only NI bound can look favorable even when the endpoint is largely failing; the separate quality floors matter. If the target remains latent task correctness instead, unknown evidence requires bounds/sensitivity or justified missing-data handling, not this relabeling.

To make the prospective endpoint meaningful, keep complete scheduled-arm records, fixed deadlines, exact source/model/identity evidence, known grader decisions where available, and all failure/certificate reasons. Apply the same certification and observation policy to both harnesses. An asymmetric evaluator fault may still invalidate the intended product comparison: at best the mathematical result would concern certification by that particular harness–provider–evaluator setup. It would not isolate model reasoning, memory quality, a product improvement or a provider-independent experience. Fix known measurement defects prospectively before interpreting this as product reliability.

Unknown failed consumption still blocks a complete study cost total, token-efficiency ratio and any guarantee that **all attempts actually consumed ≤12,000 generated tokens**. Preserve partial reported usage and mark missing amounts unknown; do not add zero or estimate an exact total. Requested per-call caps and a 24-request admission limit are observable policy controls, not proof of provider compliance or of unreported consumption. A future operational policy could stop admitting more requests after accounting becomes uncertain, preserving every pending request/failure and finalized receipt. It must be specified before execution. Success certificates may establish observed compliance for successful arms; that does not extend to failed arms or true billing totals.

The sampling assumptions still apply to Y: a common outage/certificate-service failure can correlate many pairs, and provider drift can change the target regime. Relabeling unknown usage as failure does not create iid data. Treat independent outage/time blocks as units if justified, or limit inference and report the disruption; never discard outage pairs or retry until a clean sample appears. This endpoint option is a separately versioned design decision, not a route around the current mandatory-usage gate or a rescore of prior DeepSeek/MiMo evidence.

## Option 1: iid draws from the fixed weighted catalog

Under the iid pair-draw assumptions, the loss count X is binomial(n,q), even though the two products inside a pair need not be independent. An exact one-sided Clopper–Pearson upper bound inverts

\[
\sum_{j=0}^{X}{n\choose j}U^j(1-U)^{n-j}=\alpha.
\]

For X=0 this reduces to U=1−α^(1/n); for X=n set U=1. Exact coverage is at least 1−α under the binomial model, not under arbitrary correlated repeats. [NIST exact-binomial documentation](https://itl.nist.gov/div898/software/dataplot/refman2/auxillar/exacbino.htm) and [Thulin, Section 2.1, equation (5)](https://arxiv.org/html/1303.1288) give the inversion and one-sided convention.

The following are **conditional minimum fixed sample sizes if exactly X losses occur**, not stopping rules or power targets. Each pair costs two complete native trajectories, including their auxiliary work.

| Loss count X | Standalone α=.05 | File-direction allocation α=.025 | Each memory-direction allocation α=.0125 |
|---:|---:|---:|---:|
| 0 | 59 | 72 | 86 |
| 1 | 93 | 110 | 125 |
| 2 | 124 | 142 | 160 |
| 3 | 153 | 173 | 192 |
| 5 | 208 | 230 | 252 |

The last two columns retain the directional tail allocations of the current file 95% and two memory 97.5% two-sided intervals: .025+.0125+.0125=.05. This is a possible prospective three-claim allocation, not permission to rerun already inspected studies until one succeeds. The easier .05 column applies only to a separately declared standalone claim. Additional candidates/models/claims need their own prospective error allocation.

All-zero minima are poor substitutes for power planning. At n=72 and α=.025, only zero losses qualify; if true q=.01, that happens with probability 0.99^72=48.5%. Under the same iid scenario, n=150 permits two losses and gives NI-only power 80.9%, but at α=.0125 it permits only one and gives 55.7%. The full illustrative exact-binomial power grid is retained in `numeric-calculations.json`. These are not selected target alternatives or a claim that the whole study has 80/90% power. Decide a practically justified alternative range and acceptable power before choosing n. Discrete rejection cutoffs can make power nonmonotone locally as n increases; do not stop after whichever prefix qualifies.

## Option 2: fixed equal family quotas, with heterogeneous loss rates

For m independent draws in each of K fixed families, define q̄=K^−1 Σq_h, n=Km. The pooled count generally is **not binomial(n,q̄)**. A conservative option applies the independent bounded-variable Chernoff–Hoeffding bound:

\[
P(\hat q\le x)\le \exp[-n d(x\Vert\bar q)],\qquad
d(x\Vert u)=x\log(x/u)+(1-x)\log[(1-x)/(1-u)].
\]

Here 0≤x<q̄. Invert n d(q̂||U)=log(1/α) above q̂; set U=1 at q̂=1. This allows unequal q_h, while requiring independence. See the independent, unequal-mean bounded-variable result in [Hoeffding (1963), Theorems 1–2](https://www.cs.rpi.edu/academics/courses/spring06/random/hoefding.pdf) and its explicit formulation in [León and Perron (2003), Theorem 2](https://www.sciencedirect.com/science/article/abs/pii/S0167715203000373).

For completeness, the argument specialized to this proposed design is short. Write the n independent, not necessarily identically distributed Bernoulli losses as L_i with probabilities q_i. Equal family quotas give n^−1 Σq_i=K^−1 Σq_h=q̄. For λ<0, Markov's inequality and concavity of log give

\[
P(\textstyle\sum L_i\le nx)
\le e^{-\lambda nx}\prod_i(1-q_i+q_i e^\lambda)
\le e^{-\lambda nx}(1-\bar q+\bar q e^\lambda)^n.
\]

Minimizing at e^λ=x(1−q̄)/[q̄(1−x)] yields the stated bound, with x=0 obtained as a limit. This derivation explains exactly why a common q_i is unnecessary and why unequal quotas cannot silently substitute their pooled mean for the equal-family estimand. Inverting the monotone lower-tail bound controls P(Uq<q̄) by α. It applies at a fixed preplanned n; no optional-stopping guarantee is asserted.

The zero-loss special case is particularly transparent:

\[
P(X=0)=\prod_h(1-q_h)^m\le(1-\bar q)^n.
\]

Thus U=1−α^(1/n) is valid in that case by arithmetic–geometric means, **not because the quota total is iid binomial**. These thresholds use the full KL bound, with n constrained to complete equal quotas:

| Total losses | Nine file families, α=.025 | Eight families per memory condition, α=.0125 |
|---:|---:|---:|
| 0 | 72 pairs (8/family) | 88 pairs (11/family) |
| 1 | 135 (15/family) | 152 (19/family) |
| 2 | 171 (19/family) | 192 (24/family) |
| 3 | 207 (23/family) | 224 (28/family) |
| 5 | 279 (31/family) | 296 (37/family) |

These remain conditional thresholds, not a quota-design power guarantee. The all-zero 72+88+88 example totals 248 independent pairs / 496 trajectories before diagnostics. More are likely necessary for power and the family quality floors. It does not reinterpret the current 54/48 pairs as independent: even hypothetically independent zero-loss samples of those sizes yield upper bounds 6.60% / 8.72%, above 5%.

The next small grid uses balanced quotas and the **KL decision rule above**, but assumes every family's loss probability is the same q and all losses are independent. Only in this homogeneous scenario does a binomial sum give the decision probability. Values are illustrative NI-only power, not worst-case-heterogeneity guarantees or full qualification probabilities.

| Quotas; fixed n | Largest qualifying losses | True q=.5% | True q=1% | True q=2.5% |
|---|---:|---:|---:|---:|
| Files: 9×8=72; α=.025 | 0 | 69.7% | 48.5% | 16.2% |
| Files: 9×20=180; α=.025 | 2 | 93.8% | 73.1% | 17.0% |
| Files: 9×40=360; α=.025 | 7 | 99.9% | 97.0% | 32.1% |
| Each memory condition: 8×11=88; α=.0125 | 0 | 64.3% | 41.3% | 10.8% |
| Each memory condition: 8×24=192; α=.0125 | 2 | 92.7% | 69.8% | 13.9% |
| Each memory condition: 8×48=384; α=.0125 | 7 | 99.9% | 95.9% | 25.5% |

For example, the first column's file n=180 probability is Σ(j=0..2) BinomialPMF(j;180,q). A heterogeneous q_h vector changes this power calculation even when q̄ stays fixed. The bound's coverage argument survives independent heterogeneity; these particular power numbers do not.

Two alternatives expose the cost of weaker assumptions or simpler weighting:

- Within each fixed family, obtain an exact upper U_h with α_h=α/K, then use Uq=ΣU_h/K. Simultaneous coverage follows by the union bound; independence between strata is unnecessary, though iid sampling inside each stratum is still required. With zero losses and equal allocations, this needs 115 independent pairs per file family (1,035 total), or 126 per memory family (1,008 per condition). It is valid but very conservative for a macro-average claim; it also supports simultaneous family loss bounds.
- For independent observations with arbitrary fixed weights w_h and n_h per family, a simpler bound is Uq=min(1, q̂_w+sqrt[log(1/α) Σ(w_h²/n_h)/2]). This is the weighted application of [Hoeffding's Theorem 2](https://www.cs.rpi.edu/academics/courses/spring06/random/hoefding.pdf). With balanced weights it needs 738 / 877 independent units even at zero observed loss before rounding to family quotas. Bounded block means may replace repeated observations, but then the independent-unit count is the number of blocks. No distribution-free method can manufacture independence from one shared dependent batch.

## If the headline also guarantees true Atlas accuracy

The old observed floors remain unchanged. A different, stronger future claim could require simultaneous lower confidence bounds of at least 90% aggregate Atlas accuracy and 80% in every family, alongside NI. For independent within-family draws, exact binomial upper bounds on **Atlas failures**, followed by 1−U, provide family accuracy lower bounds. An aggregate bound must match the sampling design: exact binomial for iid mixture draws, or a conservative weighted/KL bound for fixed strata. At zero failures, the common all-zero bound applies under either independent design.

One simple conservative simultaneous-confidence allocation divides each track's existing directional α across K+2 components: NI, aggregate accuracy and K family accuracies. The three track budgets still sum to .05. This is an illustrative future allocation, not a current-rule amendment or an optimal allocation; it tightens each component and changes the NI sample arithmetic above. A claim merely requiring a conjunction of tests can admit other error-control designs, but must not be mislabeled simultaneous confidence for separately displayed bounds.

Under this explicit allocation and **zero Atlas failures**, a family lower bound is β^(1/m), β=α/(K+2). Files need m=28 independent cases per family (252 pairs); each memory condition needs m=30 (240 pairs). Those counts also suffice for the aggregate and zero-loss NI components in that all-zero scenario. These are best-case passing counts for these bounds, not recommended n, likely outcomes or power targets. They show why true per-family accuracy assurance costs substantially more than observed 5/6 success. Nonzero failures, loss discordance, dependence and multiple future candidate/model selections need further prospective planning. No current result is promoted or rescored under this example.

## What should be decided before any new control implementation

Choose the estimand first: random work-family generalization is different from fixed equal-family catalog performance. Independently drawing among the *fixed* families yields the defined mixture; it does not turn those families into a random sample of all work. Generalization to new families requires an independently defined family sampling frame and new family draws. If a sampled family carries multiple cases/repeats, its block must remain the sampling unit for that broader estimand.

For the fixed-family scope, either independently sampled mixture pairs with an exact binomial loss bound, or balanced independent case quotas with the conservative KL bound, has an analytic coverage argument that does not depend on an eight/nine-cluster bootstrap. Decide between them on coverage/relevance/cost needs before results, and use one as the primary analysis. A calibrated paired-difference method crediting wins may be more efficient and is needed for superiority; it requires a separately reviewed prospective method, not a post-hoc replacement when loss-only NI fails.

Before launch: author/audit the frame; justify the 5pp tolerance in user consequences; lock the model/source/budget and failure policy; specify independent units and common-shock handling; choose fixed n from explicit alternative/power scenarios; bind the three-claim allocation (or a new declared claim family); implement and independently test the mathematics, numerical boundaries and complete-ledger admission. If optional stopping is wanted, design a valid sequential method first. Current uncalibrated bootstrap decisions and all prior evidence remain exactly as recorded. None of these options proves universal harness parity, API/subscription consistency, human visual quality, or performance outside the chosen catalog and transport profile.

The deterministic source and full calculations are `calculate-options.py` and `numeric-calculations.json`. Source links, verification date and evidence hashes are recorded in `prospective-sources.json`. No new live study is approved by this note.
