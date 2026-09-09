#!/usr/bin/env python3
"""Execute actual generated candidates inside the hidden grader's OS boundary."""

import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import nullcontext
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parent


def load(name, filename):
    specification = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


checker = load("code_checker", "file-code-check.py")
fixtures = load("file_fixtures", "file-fixtures.py")
CORRECT = '''from decimal import Decimal, InvalidOperation, ROUND_HALF_UP, localcontext
def to_cents(value: str) -> int:
    try:
        number = Decimal(value.strip())
        if not number.is_finite():
            raise ValueError("nonfinite")
        with localcontext() as context:
            context.prec = max(28, len(number.as_tuple().digits) + abs(number.as_tuple().exponent) + 8)
            return int((number * 100).to_integral_value(rounding=ROUND_HALF_UP))
    except (InvalidOperation, AttributeError) as error:
        raise ValueError("invalid currency") from error
'''


class HiddenCodeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="atlas-hidden-grader-test-", dir="/private/tmp")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.counter = 0

    def run_candidate(self, source, cases=None, invalid=None, enforce_contract=True):
        self.counter += 1
        work = self.root / str(self.counter)
        work.mkdir()
        candidate = work / "candidate.py"
        candidate.write_text(source)
        suite = {"cases": cases if cases is not None else [["1.25", 125]], "invalid": invalid or []}
        digest = hashlib.sha256(json.dumps(suite, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        manifest = work / "private.json"
        manifest.write_text(json.dumps({"kind": "code_fix", "expected": suite, "testSuiteSha256": digest,
                                        "candidateContractSha256": checker.CONTRACT_SHA256}))
        # Component tests may bypass admission to probe the actual OS/worker
        # boundary. The production CLI has no such bypass flag or parameter.
        boundary = nullcontext() if enforce_contract else mock.patch.object(checker, "validate_candidate", return_value=[])
        with boundary:
            return checker.check(candidate, manifest, work / "receipt.json")

    def test_original_fails_and_decimal_fix_passes_real_suite(self):
        fixtures.build("code_fix", "development", 0, self.root / "workspace", self.root / "oracle.json")
        source = self.root / "workspace/app/money.py"
        original = checker.check(source, self.root / "oracle.json", self.root / "original.json")
        self.assertFalse(original["pass"])
        self.assertTrue(original["candidateContract"]["pass"])
        source.write_text(CORRECT)
        fixed = checker.check(source, self.root / "oracle.json", self.root / "fixed.json")
        self.assertTrue(fixed["pass"])
        self.assertEqual(fixed["casesPassed"], fixed["casesTotal"])
        self.assertTrue(fixed["sourcePreserved"])
        self.assertEqual(fixed["sandboxPolicySha256"], checker.runtime_spec()["sandboxPolicySha256"])
        self.assertEqual(fixed["candidateContract"]["sha256"], checker.CONTRACT_SHA256)

    def test_integer_type_and_unexpected_output_are_enforced(self):
        for expression in ["True", "125.0", '"125"']:
            with self.subTest(expression=expression):
                self.assertFalse(self.run_candidate(f"def to_cents(value):\n    return {expression}\n")["pass"])
        for output in ["hello", "x" * 9000]:
            with self.subTest(size=len(output)):
                receipt = self.run_candidate(f"def to_cents(value):\n    print({output!r})\n    return 125\n", enforce_contract=False)
                self.assertFalse(receipt["pass"])
                self.assertIn(receipt["cases"][0]["actual"]["kind"], {"unexpected_stdout", "unexpected_error"})

    def test_private_oracle_and_outside_canary_are_unreadable_and_unchanged(self):
        canary = self.root / "private-canary"
        canary.write_text("PRIVATE")
        for operation in [f"open({str(canary)!r}).read()", f"open({str(canary)!r}, 'w').write('ESCAPED')"]:
            with self.subTest(operation=operation):
                receipt = self.run_candidate(f"def to_cents(value):\n    {operation}\n    return 125\n", enforce_contract=False)
                self.assertFalse(receipt["pass"])
                self.assertEqual(receipt["cases"][0]["actual"]["errorType"], "PermissionError")
                self.assertEqual(canary.read_text(), "PRIVATE")
        # The private manifest is outside the permitted copied source and case TEMP.
        oracle = self.root / str(self.counter + 1) / "private.json"
        receipt = self.run_candidate(f"def to_cents(value):\n    open({str(oracle)!r}).read()\n    return 125\n", enforce_contract=False)
        self.assertEqual(receipt["cases"][0]["actual"]["errorType"], "PermissionError")

    def test_network_and_process_creation_are_denied(self):
        for source in [
            "import socket\ndef to_cents(value):\n    socket.create_connection(('127.0.0.1', 9), timeout=0.1)\n    return 125\n",
            "import os\ndef to_cents(value):\n    os.fork()\n    return 125\n",
        ]:
            receipt = self.run_candidate(source, enforce_contract=False)
            self.assertFalse(receipt["pass"])
            self.assertEqual(receipt["cases"][0]["actual"]["errorType"], "PermissionError")

    def test_each_case_has_fresh_writable_state(self):
        source = '''from pathlib import Path
def to_cents(value):
    state = Path("prior-case")
    if state.exists():
        return -1
    state.write_text(value)
    return 125
'''
        receipt = self.run_candidate(source, [["1.25", 125], ["1.250", 125]], enforce_contract=False)
        self.assertTrue(receipt["pass"])
        paths = [item["TEMP"] for item in receipt["isolation"]["caseParameters"]]
        self.assertEqual(len(paths), len(set(paths)))

    def test_deadline_and_file_output_bound_are_enforced(self):
        deadline = self.run_candidate("def to_cents(value):\n    while True:\n        pass\n")
        self.assertFalse(deadline["pass"])
        self.assertEqual(deadline["cases"][0]["reason"], "case deadline")
        excessive = self.run_candidate("import os\ndef to_cents(value):\n    for _ in range(300):\n        os.write(2, b'x' * 8192)\n    return 125\n", enforce_contract=False)
        self.assertFalse(excessive["pass"])
        temporary = Path(excessive["isolation"]["profilePath"]).parent
        self.assertLessEqual((temporary / "outputs/0.stderr").stat().st_size, checker.MAX_OUTPUT_BYTES)

    def test_disclosed_contract_blocks_direct_and_public_module_chain_forgeries(self):
        for bridge, expression in [
            ("import __main__", "__main__"),
            ("import re", "re.enum.sys.modules['__main__']"),
        ]:
            with self.subTest(bridge=bridge):
                source = f'''{bridge}
def to_cents(value):
    monitor = {expression}
    monitor.emit = lambda ignored: '{{"kind":"value","isInteger":true,"value":125}}'
    return False
'''
                # Verify the regression really can forge the worker in the
                # absence of admission, then verify production denies it.
                forged = self.run_candidate(source, enforce_contract=False)
                self.assertTrue(forged["pass"])
                with mock.patch.object(checker.subprocess, "run") as invocation:
                    denied = self.run_candidate(source)
                invocation.assert_not_called()
                self.assertFalse(denied["pass"])
                self.assertFalse(denied["candidateContract"]["pass"])
                self.assertTrue(denied["candidateContract"]["violations"])
                self.assertEqual(denied["casesPassed"], 0)

    def test_import_aliases_and_attribute_assignment_cannot_hide_forbidden_operations(self):
        denied = [
            "from re import enum as helper\ndef to_cents(value):\n    return 125\n",
            "import re as helper\ndef to_cents(value):\n    helper.enum = value\n    return 125\n",
            "import decimal\ndef to_cents(value):\n    return decimal.__dict__['Decimal'](value)\n",
            "def to_cents(value):\n    action = globals\n    return 125\n",
            "def to_cents(value):\n    action = eval\n    return action(value)\n",
            "from re import *\ndef to_cents(value):\n    return 125\n",
            "from .decimal import Decimal\ndef to_cents(value):\n    return 125\n",
            "class Helper:\n    pass\ndef to_cents(value):\n    return 125\n",
            "def to_cents(value, extra=0):\n    return 125\n",
        ]
        for source in denied:
            with self.subTest(source=source):
                self.assertTrue(checker.validate_candidate(source.encode()))
        admitted = [
            CORRECT,
            "import re as regex\ndef to_cents(value):\n    return int(regex.fullmatch(r'[0-9]+', value).group())\n",
            "from re import compile as regex_compile\ndef to_cents(value):\n    return int(regex_compile(r'[0-9]+').fullmatch(value).group())\n",
            "import decimal as currency\ndef to_cents(value):\n    return int(currency.Decimal(value) * 100)\n",
        ]
        for source in admitted:
            with self.subTest(source=source):
                self.assertEqual(checker.validate_candidate(source.encode()), [])

    def test_evidence_stays_with_attempt_and_receipt_cannot_be_overwritten(self):
        receipt = self.run_candidate(CORRECT)
        work = self.root / str(self.counter)
        evidence = Path(receipt["evidenceRoot"])
        self.assertEqual(evidence.parent, work.resolve())
        self.assertEqual((evidence / "source/money.py").read_text(), CORRECT)
        self.assertEqual(json.loads((evidence / "admission.json").read_text()), receipt["candidateContract"])
        self.assertTrue((evidence / "outputs/0.stdout").is_file())
        self.assertTrue((evidence / "outputs/0.stderr").is_file())
        before = (work / "receipt.json").read_bytes()
        with self.assertRaises(ValueError):
            checker.check(work / "candidate.py", work / "private.json", work / "receipt.json")
        self.assertEqual((work / "receipt.json").read_bytes(), before)
        self.assertEqual(len(list(work.glob("grader-evidence-*"))), 1)

    def test_wrong_contract_or_suite_is_rejected_before_execution(self):
        self.run_candidate(CORRECT)
        work = self.root / str(self.counter)
        original = json.loads((work / "private.json").read_text())
        for key in ["candidateContractSha256", "testSuiteSha256"]:
            with self.subTest(key=key):
                (work / "private.json").write_text(json.dumps({**original, key: "0" * 64}))
                with mock.patch.object(checker.subprocess, "run") as invocation:
                    with self.assertRaises(ValueError):
                        checker.check(work / "candidate.py", work / "private.json", work / "mismatch.json")
                invocation.assert_not_called()
                self.assertFalse((work / "mismatch.json").exists())

    def test_total_deadline_preserves_all_case_denominators(self):
        with mock.patch.object(checker, "TOTAL_SECONDS", 0):
            with mock.patch.object(checker.subprocess, "run") as invocation:
                receipt = self.run_candidate(CORRECT, [["1.25", 125], ["0.29", 29]], ["NaN"])
        invocation.assert_not_called()
        self.assertFalse(receipt["pass"])
        self.assertEqual(receipt["casesTotal"], 3)
        self.assertEqual(receipt["casesPassed"], 0)
        self.assertEqual(len(receipt["cases"]), 3)

    def test_cli_enforces_admission_without_a_bypass_option(self):
        self.run_candidate("def to_cents(value):\n    print('side effect')\n    return 125\n")
        work = self.root / str(self.counter)
        result = subprocess.run(
            [sys.executable, str(ROOT / "file-code-check.py"), str(work / "candidate.py"), str(work / "private.json"), str(work / "cli-receipt.json")],
            capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(json.loads(result.stdout)["pass"])
        receipt = json.loads((work / "cli-receipt.json").read_text())
        self.assertFalse(receipt["candidateContract"]["pass"])
        self.assertEqual(receipt["isolation"]["caseParameters"], [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
