# Derived historical source bindings

All **nine** previously unavailable adjacent-archive checks now have an exact cross-archive binding for every expected regular file. The original immutable manifest remains unchanged: its nine `not_verified_archive_unavailable` records describe the original adjacent-file check. This separate result locates and hashes already-preserved bundles; it does not fabricate historical archives or change any score.

| Original inventory | Map | Matched members | Preserved bundle | Binding |
|---|---|---:|---|---|
| `evaluation/runs/development-2026-09-06T12-18-54-546Z-700c14/candidate-source.json` | `files` | 2054/2054 | `evaluation/frozen-v1/atlas-baseline-source.tar.gz` | exact_complete_regular_member_map |
| `evaluation/runs/development-2026-09-06T12-59-29-080Z-f1ae48/candidate-source.json` | `files` | 2057/2057 | `evaluation/candidate-v1/atlas-source.tar.gz` | exact_complete_regular_member_map |
| `evaluation/runs/pilot-2026-09-06T12-10-25-466Z-974aa5/candidate-source.json` | `files` | 2054/2054 | `evaluation/frozen-v1/atlas-baseline-source.tar.gz` | exact_complete_regular_member_map |
| `evaluation/frozen-v1/manifest.json` | `harnessHashes` | 17/17 | `evaluation/controlled-v2/frozen/control-source.tar.gz` | exact_expected_member_subset |
| `evaluation/frozen-v1/manifest.json` | `hermesHashes` | 7481/7481 | `evaluation/controlled-v2/frozen/hermes-source.tar.gz` | exact_complete_regular_member_map |
| `evaluation/memory-study-v1/batches/development-2026-09-06T14-20-07-841Z-e58d2c9c/candidate-source.json` | `controlHashes` | 18/18 | `evaluation/memory-study-v1/batches/development-2026-09-06T14-20-07-841Z-e58d2c9c/memory-protocol-source.tar.gz` | exact_complete_regular_member_map |
| `evaluation/memory-study-v1/batches/pilot-2026-09-06T14-17-12-326Z-447c2294/candidate-source.json` | `controlHashes` | 18/18 | `evaluation/memory-study-v1/batches/pilot-2026-09-06T14-17-12-326Z-447c2294/memory-protocol-source.tar.gz` | exact_complete_regular_member_map |
| `evaluation/memory-study-v1/frozen/manifest.json` | `controlHashes` | 18/18 | `evaluation/memory-study-v1/frozen/memory-protocol-source.tar.gz` | exact_complete_regular_member_map |
| `evaluation/native-file-study-v1/frozen/manifest.json` | `controlHashes` | 21/21 | `evaluation/native-file-study-v1/frozen/file-protocol-source.tar.gz` | exact_complete_regular_member_map |

Each inventory and candidate archive SHA-256 was checked against the original archive manifest (`bfa842d7c59be59e9238f3e9a0193fa71153ea03fe9d0943249d2dc260d70609`). Eight existing bundles were streamed without extraction or execution. Member paths and contents were matched by exact SHA-256; filenames alone were never treated as proof. Eight inventory bindings match the complete regular-member maps. The V1 harness map is an exact 17-member subset of the later controlled-V2 archive containing 31 regular files; its 14 extra files do not imply identical whole control versions.

The native memory/file gaps were naming differences: actual preserved `memory-protocol-source.tar.gz` and `file-protocol-source.tar.gz` bundles contain the exact declared control maps. Baseline/pilot Atlas inventories match the retained baseline archive, candidate1 matches its own retained bundle, and the V1 pinned Hermes map matches the preserved shared source bundle.

This strengthens source reproducibility only. It does not independently prove which code executed, rescore outcomes, erase prior failures, inspect holdout expected answers, improve the finite secret scan, or add power-loss durability. No capture, credentials, inference or tests were used.

[Full member bindings](/private/tmp/atlas-evidence-cross-bindings/cross-archive-bindings.json) · [Compact hashes](/private/tmp/atlas-evidence-cross-bindings/cross-archive-summary.json)

Full report SHA-256: `dd479e91e991fdaa3294f96140b101b79dd40b425eaab2c5d34343c1b6e2223d`.
