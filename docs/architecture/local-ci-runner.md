# Local CI recovery

This is an operator procedure for the reviewed Atlas Phase 0 owner branch. It
does not deploy Atlas, modify GitHub billing, or certify production readiness.
The runner processes one Actions job and exits. It is not a daemon or a service
for arbitrary public pull requests.

## Preconditions

- macOS with at least 8 GiB RAM and **35 GiB free disk before admission of one
  bounded CI gate**. The disk threshold is conservative build headroom, not a
  measured minimum. `preflight`, `provision`, and `refresh` also require 35 GiB.
  The bootstrap never deletes caches, existing VMs, or user data to satisfy it.
- Colima, QEMU, `lima-additional-guestagents`, `gh`, and `jq` installed through
  Homebrew. The additional guest agent is required for x86_64 on an ARM host.
  GitHub authentication
  remains on the host. Run `bash scripts/ci-local.sh preflight` first.
- Review the exact owner-branch commit and workflow changes before assigning
  jobs. Seven merge requirements remain `static`, `mobile`, `docs`,
  `docker-files`, `unit`, `smoke`, and `heavy`; no admin bypass. React Doctor
  remains advisory. Fork PR checks route to hosted runners.

## Prepare a dedicated guest

Run `bash scripts/ci-local.sh provision` only after preflight succeeds. It creates
`atlas-ci` with QEMU x86_64, four CPUs, 4 GiB RAM, a 40 GiB data disk and
20 GiB root disk. These are sparse capacity limits, not a promise of free host
space. The existing `atlas-verification` profile is left alone. Provisioning
refuses to overwrite an existing `atlas-ci` profile.

Host mounts, SSH agent forwarding, automatic context activation, custom template
inheritance, and application port forwarding are disabled. Only bootstrap
scripts are streamed into the guest. The runner archive is pinned to 2.337.0
and its GitHub SHA-256 digest. No host PAT, provider credential, or home directory
is copied. The scripts use Ubuntu package repositories as configured by the
official Colima image; package or kernel failures remain failures.

The two guest scripts live at `$HOME/.local/share/atlas-ci-bootstrap` inside
`atlas-ci`, so they survive a guest reboot. To install or refresh them in an
existing running `atlas-ci`, run `bash scripts/ci-local.sh refresh` from the
current checkout after reviewing and testing its scripts. This copies only
`ci-local-guest.sh` and `verify-linux-landlock.sh`; it does not start, recreate,
or reprovision the VM, install packages, register a runner, or remove existing
data. It refuses an existing runner lock. This also repairs older guests whose
bootstrap was stored under `/tmp` and disappeared on restart.

The guest must return Landlock ABI >=3 from the real syscall. The production
image must independently pass `verify-linux-landlock.sh IMAGE` under default
container confinement and the existing filesystem isolation tests. Do not use
ARM64, Rosetta/binfmt, privileged containers, relaxed seccomp, or test skips to
replace this proof. A passed syscall probe establishes availability only.

## Run one reviewed job

After the guest is ready, explicitly set repository variable `ATLAS_CI_RUNNER`
to `atlas-local-ci-amd64`, then rerun the reviewed workflow so queued jobs
resolve that label. This variable change is a separate operator action; the
bootstrap does not perform it. Docker publishing uses the same configurable
routing and builds `linux/amd64` explicitly.

Run `bash scripts/ci-local.sh run ACTIONS_RUN_ID FULL_REVIEWED_COMMIT_SHA RUN_ID:ATTEMPT [...]`.
Supply the complete finite list of workflow run IDs and their `run_attempt`
values from GitHub, intentionally including both required checks and any
advisory workflow that requests this label. For example, a gate with runs 123
and 456 on their first attempts uses `123:1 456:1`. Use that same list for every
job in the gate, retaining completed members. The requested active run must be
in the list. Every listed run, including completed ones, must still match the
reviewed owner SHA and attempt; any currently targetable run outside the list
blocks dispatch even when it has the same SHA.

Before the first job, the launcher measures at least 35 GiB free on the host
and writes a private, atomic admission receipt under
`$(git rev-parse --absolute-git-dir)/atlas-ci/gate-admission.json`. The directory
has mode `0700` and the file `0600`. The receipt binds the repository, guest
profile, reviewed SHA, and exact run/attempt list to this fresh observation.
It is an operator record, not CI success evidence. Do not edit it or import an
earlier disk observation. Malformed, unmeasured, or unsafely permissioned
receipts fail closed. A different SHA, run, attempt, or gate list requires a
new measurement of at least 35 GiB; the launcher cannot waive that requirement.

Later jobs in the same admitted gate may use its accumulated build caches.
Before **every** job, the launcher still requires at least **10 GiB free on
the host** and **5 GiB free on each guest root and data filesystem**. The data
check targets the mounted `/mnt/lima-colima-atlas-ci` disk, and missing mounts
or unreadable disk evidence block execution. These continuation reserves are
conservative operator guards chosen for this runner, not user-specified limits
or a guarantee that a remaining build will fit. If a reserve is exhausted,
stop and report the actual blocker; no cleanup, override, or unattended retry
is provided. A fresh gate also passes these guest reserve checks before its
receipt is written.

The launcher rejects pending jobs with the dedicated label from other or fork
commits, and refuses an empty dispatch queue. The local checkout must be at that
reviewed commit, and the launcher, guest bootstrap, and Landlock probe must match
its committed bytes. Each run refreshes the persistent guest scripts from that
verified source before executing them, so an older installed script cannot be
used silently. A short-lived registration token is passed over stdin only after
these checks and the guest probe succeed. Registration has no default labels,
and the listener has a one-hour deadline. Repeat the explicit command for each
job; there is no unattended loop. Do not enqueue unreviewed workflows while this
scoped listener is active: queue inspection is not an atomic GitHub dispatch lock.

Runner credentials and its temporary workspace are removed on normal exit and
handled cancellation. A host/VM crash can prevent cleanup; inspect the dedicated
VM and remove any stale GitHub registration before reuse. The VM and installed
tooling persist: ephemeral registration **does not mean a reset VM**. Preserve
Actions logs and record the run URL, exact SHA, target architecture, and actual
failures. Shut down the task-owned profile with `colima stop atlas-ci` when
finished. Removing/recreating this dedicated VM is a separate explicit action.

If disk, QEMU, guest/kernel, network, or billing-dependent hosted jobs remain
unavailable, report `BLOCKED`. A successful local preflight is not a green main
branch, complete Docker proof, or evidence that the application was deployed.
