#!/usr/bin/env bash
set -euo pipefail

# Query the real syscall in the execution environment. A kernel version or
# /proc/config entry alone does not prove that seccomp permits Landlock.
probe='import ctypes, json, platform, sys
if platform.system() != "Linux" or platform.machine() != "x86_64":
    sys.exit("BLOCKED: production isolation requires native Linux x86_64 syscall semantics")
libc = ctypes.CDLL(None, use_errno=True)
abi = libc.syscall(444, None, 0, 1)
if abi < 3:
    sys.exit(f"BLOCKED: Landlock ABI >=3 required; detected {abi}, errno={ctypes.get_errno()}")
print(json.dumps({"architecture": platform.machine(), "landlockAbi": abi, "evidence": "actual syscall availability; filesystem isolation tests are still required"}))'

if [[ $# -eq 0 ]]; then
  python3 -c "$probe"
elif [[ $# -eq 1 && -n "$1" ]]; then
  # Preserve the production container security policy: no privilege or seccomp
  # overrides, no host mounts, no network, and no emulated target substitution.
  docker run --rm --network none --read-only --entrypoint python3 "$1" -c "$probe"
else
  printf 'Usage: bash scripts/verify-linux-landlock.sh [production-image]\n' >&2
  exit 2
fi
