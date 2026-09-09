"""Synthetic checks of the exact successor policy; never broaden its grants.

ATLAS_POLICY_TEST_ROOT must be a fresh absolute path. This suite preserves all
evidence. Its only child is /bin/sh running fixed builtins against owned canaries;
it does not run document renderers or send network traffic.
"""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import traceback
import unittest


SUCCESSOR = Path(__file__).with_name("inspect_output.py")
ROOT = None
ROOT_OWNED = False
INSPECTOR = None

# All paths arrive as argv; no fixture path or file contents become shell code.
# Each redirection runs in an if condition so denied access does not terminate
# the shell before the remaining observations are collected. No external command
# or shell startup file is requested.
BUILTINS = r"""
if IFS= read -r captured < "$1"; then
    printf 'captured_read=allowed\n'
    if printf '%s\n' "$captured" > "$2"; then
        printf 'private_write=allowed\n'
    else
        printf 'private_write=denied\n'
    fi
else
    printf 'captured_read=denied\n'
    printf 'private_write=not_attempted\n'
fi
if IFS= read -r sibling < "$3"; then
    printf 'sibling_read=allowed\n'
else
    printf 'sibling_read=denied\n'
fi
if printf 'SYNTHETIC_WRITE_ATTEMPT\n' > "$3"; then
    printf 'sibling_write=allowed\n'
else
    printf 'sibling_write=denied\n'
fi
if IFS= read -r outside < "$4"; then
    printf 'outside_read=allowed\n'
else
    printf 'outside_read=denied\n'
fi
if printf 'SYNTHETIC_WRITE_ATTEMPT\n' > "$4"; then
    printf 'outside_write=allowed\n'
else
    printf 'outside_write=denied\n'
fi
"""


def reference(path):
    data = Path(path).read_bytes()
    return {"path": str(path), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def write_json(path, value):
    with Path(path).open("x", encoding="utf8") as stream:
        json.dump(value, stream, indent=2, sort_keys=True)
        stream.write("\n")


def setUpModule():
    global ROOT, ROOT_OWNED, INSPECTOR
    configured = os.environ.get("ATLAS_POLICY_TEST_ROOT")
    if not configured or not Path(configured).is_absolute():
        raise RuntimeError("ATLAS_POLICY_TEST_ROOT must be a fresh absolute path")
    ROOT = Path(configured)
    ROOT.mkdir()
    ROOT_OWNED = True
    try:
        write_json(ROOT / "registration.json", {
            "testSource": reference(Path(__file__)),
            "successorSource": reference(SUCCESSOR),
            "python": {"executable": sys.executable, "version": sys.version},
            "shell": reference(Path("/bin/sh")),
            "actualPolicyCases": ["soffice", "pdfinfo", "pdftoppm"],
            "requiredObservations": {
                "captured_read": "allowed", "private_write": "allowed",
                "sibling_read": "denied", "sibling_write": "denied",
                "outside_read": "denied", "outside_write": "denied",
            },
            "unitCases": [
                "unsupported renderer command rejected",
                "runtime root redirect rejected",
                "runtime external file symlink rejected",
                "internal runtime symlink remains supported",
            ],
            "scope": "Exact returned sandbox prefix and environment; no additional grants or fallback. Synthetic filesystem access only.",
            "limits": [
                "Shell initialization failure is failure, not denial proof",
                "No renderer, network, lifecycle or descendant quiescence certification",
                "No mutation of actual runtime, system font or historical fixture trees",
            ],
        })
        spec = importlib.util.spec_from_file_location("atlas_policy_successor", SUCCESSOR)
        if spec is None or spec.loader is None:
            raise RuntimeError("Cannot import sibling successor")
        INSPECTOR = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = INSPECTOR
        spec.loader.exec_module(INSPECTOR)
    except BaseException:
        write_json(ROOT / "setup-failure.json", {"traceback": traceback.format_exc()})
        raise


class RendererPolicyTests(unittest.TestCase):
    def setUp(self):
        self.case = ROOT / self._testMethodName
        self.case.mkdir()

    def capture_fixture(self):
        capture = self.case / "capture"
        capture.mkdir()
        original = capture / "original.pdf"
        original.write_bytes(b"SYNTHETIC_CAPTURED_INPUT\n")
        original.chmod(0o444)
        render = capture / "rendered"
        render.mkdir()
        sibling = capture / "sibling.txt"
        sibling.write_bytes(b"SYNTHETIC_SIBLING_CANARY\n")
        outside_root = self.case / "outside-capture"
        outside_root.mkdir()
        outside = outside_root / "outside.txt"
        outside.write_bytes(b"SYNTHETIC_OUTSIDE_CANARY\n")
        return original, render, sibling, outside

    def check_policy(self, wrapper):
        original, render, sibling, outside = self.capture_fixture()
        before = [reference(p) for p in (original, sibling, outside)]
        write_json(self.case / "canaries-before.json", before)
        command = [str(Path(INSPECTOR.BIN) / wrapper), str(original)]
        try:
            launch, env, evidence = INSPECTOR.renderer_launch(command, render)
        except BaseException:
            write_json(self.case / "admission-failure.json", {"traceback": traceback.format_exc()})
            raise
        write_json(self.case / "renderer-admission.json", evidence)
        executable_index = launch.index("-p") + 2
        self.assertEqual(launch[executable_index], evidence["executable"]["path"])
        prefix = launch[:executable_index]
        self.assertEqual(prefix, ["/usr/bin/sandbox-exec", *evidence["parameters"], "-p", evidence["policy"]])
        private = render / "private-written.txt"
        actual = [*prefix, "/bin/sh", "-c", BUILTINS, "synthetic-policy-check", str(original), str(private), str(sibling), str(outside)]
        write_json(self.case / "launch.json", {
            "exactRendererPrefix": prefix,
            "actualCommand": actual,
            "environment": env,
            "policyUnchanged": actual[:executable_index] == launch[:executable_index],
            "rendererExecutableSubstitutedOnlyForTrustedBuiltinTest": True,
        })
        started = time.monotonic()
        receipt = {"timedOut": False, "exitCode": None, "started": False, "spawnAttempted": False}
        stdout = b""
        stderr = b""
        try:
            receipt["spawnAttempted"] = True
            completed = subprocess.run(
                actual, cwd=render, env=env,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=10, check=False,
            )
            stdout, stderr = completed.stdout, completed.stderr
            receipt["started"] = True
            receipt["exitCode"] = completed.returncode
        except subprocess.TimeoutExpired as error:
            stdout, stderr = error.stdout or b"", error.stderr or b""
            receipt["started"] = True
            receipt["timedOut"] = True
            receipt["errorType"] = type(error).__name__
        except OSError as error:
            receipt["errorType"] = type(error).__name__
            receipt["detail"] = str(error)
        finally:
            receipt["elapsedSeconds"] = time.monotonic() - started
            (self.case / "stdout.log").write_bytes(stdout)
            (self.case / "stderr.log").write_bytes(stderr)
            receipt["logs"] = [reference(self.case / n) for n in ["stdout.log", "stderr.log"]]
            write_json(self.case / "process.json", receipt)
            after = [reference(p) for p in (original, sibling, outside)]
            write_json(self.case / "canaries-after.json", after)
        self.assertFalse(receipt["timedOut"])
        self.assertEqual(receipt["exitCode"], 0, "Shell must initialize under the unmodified policy")
        observations = dict(line.split("=", 1) for line in stdout.decode("utf8").splitlines() if "=" in line)
        write_json(self.case / "observations.json", observations)
        self.assertEqual(observations, {
            "captured_read": "allowed", "private_write": "allowed",
            "sibling_read": "denied", "sibling_write": "denied",
            "outside_read": "denied", "outside_write": "denied",
        })
        self.assertEqual(private.read_bytes(), original.read_bytes())
        self.assertEqual(after, before)

    def test_soffice_exact_policy(self):
        self.check_policy("soffice")

    def test_pdfinfo_exact_policy(self):
        self.check_policy("pdfinfo")

    def test_pdftoppm_exact_policy(self):
        self.check_policy("pdftoppm")

    def test_unsupported_command_refused(self):
        original, render, _, _ = self.capture_fixture()
        with self.assertRaises(OSError):
            INSPECTOR.renderer_launch(["/bin/sh", str(original)], render)

    def test_runtime_root_redirect_refused(self):
        target = self.case / "target"
        target.mkdir()
        (target / "ordinary.txt").write_bytes(b"SYNTHETIC_RUNTIME\n")
        alias = self.case / "root-alias"
        alias.symlink_to(target, target_is_directory=True)
        with self.assertRaises(OSError):
            INSPECTOR.runtime_tree(alias)

    def test_runtime_external_symlink_refused(self):
        package = self.case / "package"
        package.mkdir()
        target = self.case / "outside.txt"
        target.write_bytes(b"SYNTHETIC_OUTSIDE_RUNTIME\n")
        before = reference(target)
        (package / "external-link").symlink_to(target)
        with self.assertRaises(OSError):
            INSPECTOR.runtime_tree(package)
        self.assertEqual(reference(target), before)

    def test_internal_runtime_symlink_supported(self):
        package = self.case / "package"
        package.mkdir()
        target = package / "ordinary.txt"
        target.write_bytes(b"SYNTHETIC_RUNTIME\n")
        (package / "internal-link").symlink_to("ordinary.txt")
        result = INSPECTOR.runtime_tree(package)
        write_json(self.case / "runtime-tree.json", result)
        self.assertEqual({m["path"] for m in result["members"]}, {"ordinary.txt", "internal-link"})
        self.assertEqual(next(m for m in result["members"] if m["path"] == "internal-link")["kind"], "symlink")
        self.assertEqual(next(m for m in result["members"] if m["path"] == "ordinary.txt")["sha256"], reference(target)["sha256"])


class RetainedResult(unittest.TextTestResult):
    def stopTestRun(self):
        super().stopTestRun()
        if ROOT_OWNED:
            write_json(ROOT / "unittest-result.json", {
                "testsRun": self.testsRun, "successful": self.wasSuccessful(),
                "failures": [{"test": t.id(), "traceback": tb} for t, tb in self.failures],
                "errors": [{"test": t.id(), "traceback": tb} for t, tb in self.errors],
                "skipped": [{"test": t.id(), "reason": why} for t, why in self.skipped],
                "semanticOrLifecycleQualification": False,
            })


if __name__ == "__main__":
    unittest.main(testRunner=unittest.TextTestRunner(verbosity=2, resultclass=RetainedResult))
