# Python execution boundary audit

Date: 2026-09-06. These probes used temporary workspaces and synthetic canary
files only. No host credentials or other tenants' actual files were read.

## Remediation and current evidence

Python and Bash now both use `apps/server/src/services/restricted-process.ts`.
It requires macOS `sandbox-exec` or Linux Landlock ABI 3 and never falls back to
host execution, including when a caller sets `codingAgent`. The child receives
only an allowlisted environment plus explicitly supplied Bash variables; `HOME`,
temporary directories and XDG config/cache point to a private directory removed
after the run. Host environment variables and host-native CLI login directories
are not inherited. Bash respects the execution context's profile workspace and
does not load host shell startup files.

Profile and private-temp roots are writable. Installed system software/library
roots, discovered Python libraries, the exact executable and specific system
certificate/MIME/network configuration files are read-only. No recursive host
home, Atlas configuration, `/etc`, `/tmp` or `/proc` grant exists. Runtime roots
that would expose the profile/configuration tree are rejected. Python runtime
discovery executes a fixed `-I -S` introspection program, with no caller code,
environment hooks, sitecustomize or `.pth` startup execution. The configured
runtime installation is an administrator trust boundary. The executable's venv
path is preserved so Python still resolves its installed native packages.

The Linux launcher reuses existing Landlock primitives from
`javascript-tool-sandbox-linux.c`, accepts an explicit argument vector and
read/write roots, closes all descriptors above stderr before `execv`, and fails
if restriction or descriptor closure is unavailable. Both launcher assets are
included by the normal server build. The custom-JavaScript launcher is unchanged.

| Verification | Observed result |
| --- | --- |
| Actual macOS Python/Bash and server build, outside Codex's outer sandbox | **33 tests, 130 assertions passed**, across `process-filesystem-isolation.test.ts`, Bash, Python ordinary/deep regressions and `apps/server/scripts/build.test.ts` |
| PY06 canaries | Profile read/write and private-temp write succeed; sibling profile/org, synthetic config/home reads and writes, symlink/hard-link escape and inherited FD read are denied |
| Python native daily-file workflow in macOS sandbox | `scripts/file-runtime/verify.py` passed from a managed venv; DOCX/PPTX/XLSX/CSV/PDF roundtrips produced eight artifacts |
| Native package versions exercised | pandas 3.0.5, openpyxl 3.1.5, python-docx 1.2.0, python-pptx 1.0.2, pypdf 6.17.0, reportlab 5.0.1 |
| Nested sandbox denial | Actual child returned exit 71, empty stdout/artifacts and `sandbox_apply: Operation not permitted`; no host fallback occurred |
| Linux C compilation | `cc -D__linux__ -fsyntax-only` passed; this is static evidence, **not** a Linux enforcement test |
| Linux kernel and production Docker execution | **Not verified on this host**; the production container verification gate must pass on a supported Linux host before declaring deployment acceptance |

Reproduce the macOS checks outside any outer sandbox that blocks sandbox-exec:

```sh
bun test apps/server/src/tools/process-filesystem-isolation.test.ts \
  apps/server/src/tools/bash.test.ts \
  apps/server/src/tools/python-execute-tool.test.ts \
  apps/server/src/tools/python-execute-deep.test.ts \
  apps/server/scripts/build.test.ts
```

The tool result contracts are unchanged: Python still publishes successful files
under `artifacts/`, while Bash returns stdout/stderr/exit status. These local
execution checks do not prove actual WhatsApp, Telegram or Discord delivery.

This is a filesystem boundary, not a complete hostile-workload container.
Network access remains enabled; memory/disk quotas and arbitrary process-tree
containment are separate requirements. Same-process-group descendants are killed
on completion, cancellation and timeout. A descendant that creates a new session
may outlive the parent while retaining its filesystem restrictions; this has not
been claimed as complete process-tree containment. The protected-skills snapshot
still restores after execution rather than preventing transient writes.

## Historical findings before remediation

The remaining sections retain the initial audit and follow-up findings. Statements
about direct host execution below describe the code before the remediation above.

## Observed boundary

`apps/server/src/tools/python-execute-tool.ts` launches the configured Python
binary directly with `-c` and the profile directory as `cwd`. `guardFilePath`
checks only the optional `files` argument; Python code is free to name different
absolute paths. `cwd` is not a filesystem restriction. The child inherits the
server's operating-system identity and filesystem access.

The environment is filtered by name patterns, but includes the host `HOME` and
other variables outside those patterns. Environment filtering does not prevent
reading files. `packages/core/src/tools/permissions.ts` labels Python as
`risk: system`, `privileged: false`; system approval is policy-dependent. Tool
assignment or a user approving execution does not establish filesystem isolation.
Default profile assignment therefore cannot be interpreted as a safe multi-tenant
code-execution boundary.

The coordinator's predeclared PY06 probe returned:

```json
{"caseId":"PY06","expected":"profile-filesystem-isolation","outsideReadSucceeded":true,"boundary":"host-process","status":"unsupported"}
```

Evidence: `/private/tmp/atlas-deep-20260906/python-trust-boundary.json`.
The implementation currently provides host execution, so an isolation guarantee
is unsupported. Against the declared isolation requirement this is a failed
requirement, never a passed capability test. Shared-host deployments cannot
claim that profile or org boundaries constrain Python filesystem access.

## Independent process and protected-write reproductions

### Successful parent exit leaves a background writer

Run this through `runPythonExecute` in a temporary workspace:

```python
import subprocess, sys
subprocess.Popen(
    [sys.executable, "-c",
     "import time; from pathlib import Path; time.sleep(0.8); "
     "Path('late.txt').write_text('late effect')"],
    stdin=subprocess.DEVNULL,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)
```

With tool timeout 1000 ms, the initial observed result was:

```json
{"success":true,"returnMs":74,"reportedArtifacts":[],"lateWrite":"late effect"}
```

The late file appeared after the successful tool result. At reproduction time,
the close handler killed the process group only for timeout/cancellation and
cleared the timer on normal exit. Normal-close group cleanup is now corrected;
the actual Python PY07 regression verifies that this delayed write no longer
appears. It does not provide a filesystem sandbox.

Process-group termination also is not containment of arbitrary descendants:
code can create a new session/process group. This audit did not claim or test a
guarantee that such escaped children are reaped. Windows' child-only fallback is
not equivalent to the POSIX group behavior.

### Cancellation bypasses protected skill restoration

In a temporary workspace, create `skills/example/SKILL.md` containing `original`,
enable `forbidProfileSkillMarkdownWrites`, and execute:

```python
from pathlib import Path
import time
Path("skills/example/SKILL.md").write_text("changed")
Path("ready").touch()
time.sleep(10)
```

Abort after `ready` exists. The independent result was:

```json
{"error":"Error: Python execution was cancelled by the user.","skillAfter":"changed"}
```

`packages/core/src/tools/protect-profile-skill-tree.ts` took its after-snapshot
only after `await run()` resolved. A rejection skipped restoration. This helper
also wraps Bash; the defect concerns protected skill writes, separately from
cross-profile access. The corrected helper restores the protected tree on rejection
while preserving the original cancellation/error identity; the actual Python
PY08 regression verifies this case. A snapshot-and-revert helper is still not an
OS sandbox or a concurrency-safe transaction against unrelated writers.

## Existing sandbox facilities and reuse limits

`apps/server/src/services/custom-tool-subprocess.ts` already restricts custom
JavaScript using macOS `sandbox-exec` or a Linux Landlock launcher. It supplies an
allowlisted environment with a private temporary home and explicit module,
runtime and workspace paths. Production execution fails closed when the selected
sandbox is unavailable, except for the explicitly configured custom-tool opt-out.

An independent probe of that existing JavaScript boundary performed a workspace
write and attempted to read a synthetic sibling file:

| Attempt | Boundary | Observation |
| --- | --- | --- |
| 1 | Inside Codex's outer sandbox | `sandbox_apply: Operation not permitted`; enforcement probe blocked, not passed |
| 2 | Same probe outside the outer sandbox, with `requireSandbox: true` | Workspace write succeeded; sibling read returned `EPERM` |

This establishes the existing macOS JavaScript restriction for this canary. It
does not establish a Python boundary or a tested Linux implementation. Some
existing JavaScript security tests return successfully after asserting sandbox
unavailability; those branches prove rejection without fallback, not successful
OS enforcement.

There is no current generic restricted-process launcher to call from Python:

- `prepareSubprocess` is private and constructs Bun's `--no-install`,
  `--no-addons`, JavaScript runner/mode/module argument sequence.
- The macOS profile names the exact Bun executable and runner/module paths.
- `javascript-tool-sandbox-linux.c` hardcodes the same executable/argument
  sequence and executable permissions. Its runtime read roots were selected for
  Bun, not a Python venv, standard library and native analysis packages.

Passing a Python path into the current interface would therefore not implement
the intended boundary. Allowing the entire host or configuration tree merely
to make Python start would defeat it. No broad untested Linux launcher rewrite
was made during this audit.

## Required implementation and acceptance before closing PY06

Extract a restricted-process preparation layer with an explicit executable and
argument vector, allowlisted environment, working directory, read-only runtime
roots, writable profile/private-temp roots, and a required sandbox backend.
Reuse the existing macOS and Landlock primitives behind that contract. Resolve
Python's managed runtime, standard library, site-packages and native library roots
without admitting sibling org data or host credentials. Unsupported kernels or
missing backends must remain explicit execution failures; a missing sandbox must
not silently select host execution.

Test actual children on both macOS and a supported Linux kernel, not just command
construction. Acceptance includes allowed profile read/write, blocked sibling
profile/org/config read and write, symlink and inherited-file-descriptor paths,
native packages used by daily-file workflows, cancellation and process-tree
cleanup, plus the deployment build that owns these assets. Define network policy
and resource/process limits separately: the existing JavaScript policies allow
network access, and a filesystem sandbox alone does not reap background work or
bound memory/disk usage.

Until that implementation and its cross-platform/deployment evidence exist,
Python execution is a shared-host trust boundary and blocks a tenant-isolated
deployment claim. Removing a default tool, adding an approval dialog, or changing
the test to expect an outside read would not close the requirement.

## Output and cleanup fixes reviewed

The bounded output implementation retains at most 64 KiB plus four bytes per
stream before UTF-8 decoding and applies a final byte limit. Its existing
multibyte regression exercises actual Python output. Signal exit now produces a
nonzero failure result; failed runs do not promote partial files as deliverables.
Those are narrower properties than sandboxing. The normal-exit background
writer and rejected protected-write cases above were found independently after
the initial passing cancellation/output cases and remain in this ledger.

## Follow-up: symbolic links in the protected skills snapshot

The independent publication/skill probe
`/private/tmp/atlas-review-publication.ts` also created a directory symlink under
`skills/` pointing to a synthetic target with `SKILL.md`. Before correction,
`withProtectedProfileSkillTree` returned `ok` and retained the new link despite
the forbid flag (`/private/tmp/atlas-review-publication.json`). The snapshot
tracked only regular file bytes and ignored symbolic links.

The snapshot now records links with `lstat`/`readlink`, including dangling links
and a linked skills root, without traversing their targets. Added, changed and
removed links trigger restoration; original link targets, regular file bytes and
permission modes, and empty directories are retained. Existing cancellation
identity and cooperative profile-lock behavior remain covered. Twelve helper
tests pass; the joint helper plus actual Python ordinary/deep regression run
passes **27 tests, 96 assertions** across three files
(`/private/tmp/atlas-skill-links-final-tests.log`). Standard TypeScript and the
two-file Ultracite check pass.

This restores the protected tree after the operation. It neither prevents
temporary effects during execution nor confines access through an unchanged
link to its target. It does not resolve PY06 or provide an OS filesystem boundary.
