"""Deterministic prospective arithmetic; reads no evaluation data or model output."""

import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MARGIN = 0.05


def binomial_cdf(k, n, probability):
    if k < 0:
        return 0.0
    if k >= n:
        return 1.0
    term = (1 - probability) ** n
    total = term
    for i in range(1, k + 1):
        term *= (n - i + 1) / i * probability / (1 - probability)
        total += term
    return min(1.0, total)


def divergence(x, probability):
    if x == 0:
        return -math.log1p(-probability)
    if x == 1:
        return -math.log(probability)
    return x * math.log(x / probability) + (1 - x) * math.log(
        (1 - x) / (1 - probability)
    )


def minimum_n(k, alpha, method="iid_exact", multiple=1, margin=MARGIN):
    for n in range(multiple, 10001, multiple):
        if k / n >= margin:
            continue
        qualifies = (
            binomial_cdf(k, n, margin) < alpha
            if method == "iid_exact"
            else n * divergence(k / n, margin) > -math.log(alpha)
        )
        if qualifies:
            return n
    raise ValueError("Bounded numeric search exhausted")


def rejection_cutoff(n, alpha):
    qualifying = [
        k for k in range(math.ceil(n * MARGIN))
        if binomial_cdf(k, n, MARGIN) < alpha
    ]
    return max(qualifying, default=-1)


def kl_rejection_cutoff(n, alpha):
    qualifying = [
        k for k in range(math.ceil(n * MARGIN))
        if n * divergence(k / n, MARGIN) > -math.log(alpha)
    ]
    return max(qualifying, default=-1)


alphas = [0.05, 0.025, 0.0125]
losses = [0, 1, 2, 3, 5]
result = {
    "scope": "Prospective arithmetic only; no outcomes read; no simulation; no inference",
    "strictCriterion": "Upper loss probability bound < 0.05",
    "iidExactMinimumIndependentPairs": [
        {"oneSidedAlpha": a, "observedLosses": k, "minimumN": minimum_n(k, a)}
        for a in alphas for k in losses
    ],
    "balancedStrataChernoffMinimumIndependentPairs": [
        {
            "scope": label, "families": families, "oneSidedAlpha": a,
            "observedLosses": k, "minimumN": minimum_n(k, a, "kl", families),
        }
        for label, families, a in [("files", 9, 0.025), ("each_memory_condition", 8, 0.0125)]
        for k in losses
    ],
    "allZeroBonferroniStratumExact": [
        {
            "scope": label, "families": families, "oneSidedAlpha": a,
            "perFamilyAlpha": a / families,
            "minimumIndependentPairsPerFamily": minimum_n(0, a / families),
            "minimumTotalPairs": families * minimum_n(0, a / families),
        }
        for label, families, a in [("files", 9, 0.025), ("each_memory_condition", 8, 0.0125)]
    ],
    "iidExactNIOnlyPowerIllustration": [
        {
            "n": n, "oneSidedAlpha": a,
            "maximumQualifyingLosses": rejection_cutoff(n, a),
            "probabilityNIOnlyPass": {
                str(p): binomial_cdf(rejection_cutoff(n, a), n, p)
                for p in [0.01, 0.02, 0.03, 0.05]
            },
        }
        for a in [0.025, 0.0125] for n in [72, 88, 100, 150, 200, 300, 500]
    ],
    "balancedQuotaKLNIOnlyPowerHomogeneousIndependentScenario": [
        {
            "scope": label, "families": families, "n": n,
            "oneSidedAlpha": a, "maximumQualifyingLosses": kl_rejection_cutoff(n, a),
            "probabilityNIOnlyPass": {
                str(p): binomial_cdf(kl_rejection_cutoff(n, a), n, p)
                for p in [0.005, 0.01, 0.025, 0.05]
            },
        }
        for label, families, a, counts in [
            ("files", 9, 0.025, [72, 180, 360]),
            ("each_memory_condition", 8, 0.0125, [88, 192, 384]),
        ]
        for n in counts
    ],
    "illustrativeAllZeroNIAndAccuracyBonferroni": [
        {
            "scope": label, "families": families, "trackAlpha": a,
            "componentAlpha": a / (families + 2),
            "simultaneousComponents": "NI, aggregate accuracy, each family accuracy",
            "minimumAggregateZeroAtlasFailurePairs": minimum_n(0, a / (families + 2), margin=0.10),
            "minimumPerFamilyZeroAtlasFailurePairs": minimum_n(0, a / (families + 2), margin=0.20),
            "minimumTotalBalancedPairsForFamilyBounds": families * minimum_n(0, a / (families + 2), margin=0.20),
            "minimumZeroLossNIOnlyBalancedPairs": minimum_n(0, a / (families + 2), "kl", families),
        }
        for label, families, a in [("files", 9, 0.025), ("each_memory_condition", 8, 0.0125)]
    ],
    "allZeroAdditiveHoeffding": [
        {"oneSidedAlpha": a, "minimumIndependentUnits": math.floor(-math.log(a) / (2 * MARGIN**2)) + 1}
        for a in alphas
    ],
    "allZeroUAtCurrentDeclaredPairCountsUnderNewIndependentDesignOnly": [
        {"n": n, "oneSidedAlpha": a, "upper": 1 - a ** (1 / n)}
        for n, a in [(54, 0.025), (48, 0.0125)]
    ],
    "sourceSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
}
# Cross-check the all-zero inversion with the closed form, including n-1.
for alpha in alphas:
    n = minimum_n(0, alpha)
    assert 1 - alpha ** (1 / n) < MARGIN
    assert 1 - alpha ** (1 / (n - 1)) >= MARGIN
assert binomial_cdf(0, 72, 0.01) == 0.99 ** 72
assert all(
    row["probabilityNIOnlyPass"]["0.05"] < row["oneSidedAlpha"]
    for row in result["iidExactNIOnlyPowerIllustration"]
)
destination = ROOT / "numeric-calculations.json"
destination.write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result, indent=2))
