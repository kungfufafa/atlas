# Prospective paired inference for sustained evaluation

Status: design option only, 2026-09-06 UTC. No current control, score, sample size, endpoint, or stopping rule changes. No current trial outcomes enter this calculation. This is a possible way to support the requested sustained evaluation without repeatedly testing fixed-sample intervals until one passes.

The earlier fixed-quota KL proposal gives no credit for Atlas-only wins. A valid method using paired differences can sometimes require less data, although that is not guaranteed. Matched-proportion score methods and exact unconditional NI methods exist; a score interval's favorable simulations alone do not establish uniform finite-sample coverage. [Tango (1998)](https://onlinelibrary.wiley.com/doi/abs/10.1002/%28SICI%291097-0258%2819980430%2917%3A8%3C891%3A%3AAID-SIM780%3E3.0.CO%3B2-B), [Hsueh, Liu and Chen (2001)](https://onlinelibrary.wiley.com/doi/abs/10.1111/j.0006-341X.2001.00478.x).

## A simple sequential option to review

For each fully finalized paired unit, let X=A−H, taking values −1,0,+1. Set the NI margin δ=.05. Under a null conditional mean E[X_t | F_(t−1)]≤−δ, the following is a nonnegative test supermartingale for any fixed 0≤λ≤1:

    M_t(λ) = product_(i=1..t) [1 + λ(X_i + δ)].

Every factor is at least .05. Its conditional expectation under the null is at most one; multiplying the prior nonnegative wealth proves the supermartingale property. A prespecified positive-weight average of such processes, with weights summing to one, has the same property. Reject when the mixture first reaches 1/α. Ville's inequality controls the probability of ever crossing under the null by α. This is a direct specialization of the bounded-mean betting framework, not an implementation of its optimized estimators. [Waudby-Smith and Ramdas, Sections 2 and 4](https://academic.oup.com/jrsssb/article/86/1/1/7043257).

An illustrative, unselected mixture uses equal weights on λ={1/128,1/64,1/32,1/16,1/8,1/4,1/2,1}. It credits both discordant outcomes and ties. It must not maximize over λ after seeing data: the average, or another genuinely prespecified/predictable rule, is essential. The numerical companion computes only hypothetical all-tie and fixed periodic sequences. These crossing counts are neither power estimates nor recommended sample sizes. Nothing has been applied to a live ledger.

## Sampling and claim boundaries

For a fixed, operator-audited catalog, a simple sufficient design is independently drawing the family and case with replacement using predeclared weights, then executing a complete fresh pair with randomized adjacent arm order. Random family counts are part of that design. The null concerns the resulting weighted catalog mean under a stable execution regime. The conditional-mean assumption is substantive: shared outages, provider drift, adaptive case selection or persistent inter-pair state can break it. Fresh directories alone do not prove it.

This process cannot silently replace the independent-but-heterogeneous fixed-quota KL analysis. A fixed quota order may have some families with positive conditional means even when the overall weighted null is true. Neither a shuffled quota sequence nor checking only at convenient times automatically repairs that proof. Independent full-catalog blocks are another possible unit, but would need their own power/cost analysis and source-locked design.

Use separate paired variables for factual/delivered correctness and certified completion. Certification parity alone can hide inferior factual accuracy. Both directional tests and separate observed quality, integrity, relevance and ownership gates would be needed for a joint useful-work claim. Specify whether confidence guarantees are simultaneous or the advertised claim is a conjunction; a conservative alpha allocation across all displayed claims is simplest to audit. No numeric allocation is selected here.

Define the factual scope precisely. An oracle checking only requested final fields does not establish that every free-text statement throughout the conversation is supported. A claim about entire-conversation factuality would need its own predeclared, consistently audited public-utterance endpoint. Neither a correct stored fact nor a correct final JSON object erases an unsupported intermediate operational assertion. Process diagnostics remain separately reported unless the new protocol explicitly makes them part of the primary outcome.

Every selected candidate, model, endpoint and promised claim needs a prospective error budget. A newly improved candidate must start on fresh evaluation data; resetting wealth without allocating additional error would be repeated testing. Keep all attempts, including failed and incomplete pairs. Only finalized pairs update the process, in predeclared order, with a fixed missing-evidence rule. Unknown failed consumption prevents complete cost/budget claims even if a separately observed delivery endpoint is binary.

Before adoption: independently review the mathematics; audit a relevant task frame and exact contracts; justify the five-point tolerance in user consequences; predeclare candidate/model selection, alpha, missingness, ordering, operating assumptions, practical maximum exposure and success/futility rules; validate numerical boundary handling and null behavior. The formula by itself is not an approved experiment. It does not establish exact equality, universal provider/subscription parity, or visual/user-experience quality.
