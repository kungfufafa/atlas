"""Deterministic hypothetical sequences only; never opens evaluation outcomes."""
from pathlib import Path
import json
import math

LAMBDAS = [1 / 128, 1 / 64, 1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1]
PATTERNS = [[0], [1, 0, 0, 0, -1, 0, 0, 0, 0, 0],
            [1] + [0] * 19 + [-1] + [0] * 19,
            [-1] + [0] * 19, [1] + [0] * 19]


def log_mixture(logs):
    maximum = max(logs)
    return maximum + math.log(sum(math.exp(x - maximum) for x in logs) / len(logs))


def calculate():
    results = []
    for pattern in PATTERNS:
        for alpha in [.025, .0125]:
            logs = [0.0] * len(LAMBDAS)
            crossing = None
            for t in range(1, 10001):
                value = pattern[(t - 1) % len(pattern)]
                logs = [wealth + math.log1p(bet * (value + .05))
                        for wealth, bet in zip(logs, LAMBDAS)]
                if log_mixture(logs) >= math.log(1 / alpha):
                    crossing = t
                    break
            results.append({"periodicPattern": pattern, "alpha": alpha,
                            "firstCrossingBy10000": crossing,
                            "notRandomPowerCalculation": True})
    return results


if __name__ == "__main__":
    results = calculate()
    saved = json.loads(Path(__file__).with_name("illustrative-calculations.json").read_text())
    assert saved["results"] == results
    print(json.dumps({"verifiedHypotheticalSequences": len(results), "matchesOriginal": True}))
