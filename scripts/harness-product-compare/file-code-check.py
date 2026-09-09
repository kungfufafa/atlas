#!/usr/bin/env python3
"""Parent-owned hidden checks; each confined candidate sees only its argument.

No expected value, oracle file, or parent evaluator state enters the candidate
process. This is a finite behavioral test, not a general proof of code safety.
"""

from __future__ import annotations

import argparse
import importlib.util
import hashlib
import json
import resource
import subprocess
import sys
import tempfile
import time
from pathlib import Path

CASE_SECONDS = 1
TOTAL_SECONDS = 30
MAX_SOURCE_BYTES = 100_000
MAX_OUTPUT_BYTES = 1_000_000
_contract_spec = importlib.util.spec_from_file_location(
    "file_code_contract", Path(__file__).with_name("file-code-contract.py")
)
_contract_module = importlib.util.module_from_spec(_contract_spec)
_contract_spec.loader.exec_module(_contract_module)
CONTRACT = _contract_module.CONTRACT
CONTRACT_SHA256 = _contract_module.CONTRACT_SHA256
validate_candidate = _contract_module.validate_candidate
READ_ROOTS = ["/usr/lib", "/usr/share", "/System", "/opt/homebrew/Cellar", "/opt/homebrew/lib", "/dev/null", "/dev/urandom", "/dev/random"]
PROFILE = '''(version 1)
(deny default)
(import "system.sb")
(allow process-exec (literal (param "PYTHON")) (literal (param "PYTHON_REAL")))
(deny process-fork)
(allow file-read-metadata file-test-existence)
(allow file-read-data (subpath (param "RUNTIME")) (subpath (param "SOURCE")) {system_reads})
(allow file-read* file-write* (subpath (param "TEMP")) (literal "/dev/null"))
(allow sysctl-read mach-lookup)
(deny network*)
'''

WORKER = '''import contextlib, importlib.util, io, json, sys
class BoundedCapture(io.StringIO):
    def write(self, text):
        if self.tell() + len(text) > 8192:
            raise RuntimeError("Candidate stdout exceeded the grading limit")
        return super().write(text)
emit = json.dumps
kind = type
integer = int
value_error = ValueError
argument = json.loads(sys.stdin.read())
captured = BoundedCapture()
try:
    with contextlib.redirect_stdout(captured):
        spec = importlib.util.spec_from_file_location("candidate_money", sys.argv[1])
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        result = module.to_cents(argument)
    reply = {"kind": "value", "isInteger": kind(result) is integer, "value": result if kind(result) is integer else None}
except value_error:
    reply = {"kind": "ValueError"}
except BaseException as error:
    reply = {"kind": "unexpected_error", "errorType": kind(error).__name__}
if captured.getvalue():
    reply = {"kind": "unexpected_stdout"}
print(emit(reply))
'''


def sha_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()



def runtime_spec() -> dict:
    executable = Path(sys.executable).absolute()
    real = executable.resolve()
    runtime = executable.parent.parent.resolve()
    system = [str(Path(root).resolve()) for root in READ_ROOTS if Path(root).exists()]
    profile = PROFILE.format(system_reads=" ".join(f"(subpath {json.dumps(root)})" for root in system))
    definition = {
        "platform": sys.platform,
        "profile": profile,
        "python": str(executable),
        "pythonReal": str(real),
        "pythonSha256": sha_bytes(real.read_bytes()),
        "runtime": str(runtime),
        "caseSeconds": CASE_SECONDS,
        "totalSeconds": TOTAL_SECONDS,
        "flags": ["-I", "-u", "-c"],
        "workerSha256": sha_bytes(WORKER.encode()),
        "maxSourceBytes": MAX_SOURCE_BYTES,
        "maxOutputBytes": MAX_OUTPUT_BYTES,
        "freshTemporaryDirectoryPerCase": True,
        "candidateContract": CONTRACT,
        "candidateContractSha256": CONTRACT_SHA256,
        "evidencePlacement": "new unique directory beside the immutable grading receipt",
    }
    return {**definition, "sandboxPolicySha256": sha_bytes(json.dumps(definition, sort_keys=True, separators=(",", ":")).encode())}


def child_limits() -> None:
    resource.setrlimit(resource.RLIMIT_CPU, (1, 2))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))


def check(source: Path, manifest: Path, output: Path) -> dict:
    if sys.platform != "darwin":
        raise RuntimeError("Hidden execution requires the verified macOS process sandbox")
    if source.is_symlink() or not source.is_file() or source.stat().st_size > MAX_SOURCE_BYTES:
        raise ValueError("Candidate source must be a bounded regular Python file")
    if output.exists():
        raise ValueError("A grading receipt must never be overwritten")
    task = json.loads(manifest.read_text())
    if task.get("kind") != "code_fix":
        raise ValueError("This grader accepts code_fix task manifests only")
    if task.get("candidateContractSha256") != CONTRACT_SHA256:
        raise ValueError("The task must disclose the exact admitted candidate contract")
    expected = task["expected"]
    # Same canonical suite digest as the separately audited fixture generator.
    suite = {"cases": expected["cases"], "invalid": expected["invalid"]}
    suite_hash = sha_bytes(json.dumps(suite, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode())
    required_hash = task.get("testSuiteSha256") or expected.get("testSuiteSha256")
    if required_hash != suite_hash:
        raise ValueError("The private hidden suite does not match its recorded hash")
    specification = runtime_spec()
    source_bytes = source.read_bytes()
    source_hash = sha_bytes(source_bytes)
    contract_violations = validate_candidate(source_bytes)
    output.parent.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="grader-evidence-", dir=output.parent.resolve()))
    admission = {"name": CONTRACT["name"], "sha256": CONTRACT_SHA256,
                 "pass": not contract_violations, "violations": contract_violations}
    (root / "admission.json").write_text(json.dumps(admission, indent=2) + "\n")
    source_root, case_root, output_root = root / "source", root / "cases", root / "outputs"
    source_root.mkdir()
    case_root.mkdir()
    output_root.mkdir()
    candidate = source_root / "money.py"
    candidate.write_bytes(source_bytes)
    profile_path = root / "sandbox.sb"
    profile_path.write_text(specification["profile"])
    fixed_parameters = {
        "PYTHON": specification["python"],
        "PYTHON_REAL": specification["pythonReal"],
        "RUNTIME": specification["runtime"],
        "SOURCE": str(source_root),
    }
    cases = [(value, "value", answer) for value, answer in expected["cases"]] + [(value, "ValueError", None) for value in expected["invalid"]]
    if not cases:
        raise ValueError("Hidden suites must contain at least one case")
    outcomes = []
    case_parameters = []
    started = time.monotonic()
    for index, (value, wanted_kind, wanted_value) in enumerate(cases):
        if contract_violations:
            outcomes.append({"index": index, "pass": False, "reason": "candidate outside disclosed pure-function contract"})
            continue
        remaining = TOTAL_SECONDS - (time.monotonic() - started)
        if remaining <= 0:
            outcomes.append({"index": index, "pass": False, "reason": "total grading deadline"})
            continue
        private_temp = case_root / str(index)
        private_temp.mkdir()
        parameters = {**fixed_parameters, "TEMP": str(private_temp)}
        case_parameters.append(parameters)
        arguments = ["/usr/bin/sandbox-exec"]
        for name, parameter_value in parameters.items():
            arguments.extend(["-D", f"{name}={parameter_value}"])
        arguments.extend(["-p", specification["profile"], specification["python"], "-I", "-u", "-c", WORKER, str(candidate)])
        environment = {"HOME": str(private_temp), "TMPDIR": str(private_temp), "PATH": "/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1", "LANG": "en_US.UTF-8"}
        stdout_path, stderr_path = output_root / f"{index}.stdout", output_root / f"{index}.stderr"
        try:
            with stdout_path.open("xb") as stdout, stderr_path.open("xb") as stderr:
                completed = subprocess.run(arguments, input=json.dumps(value), stdout=stdout, stderr=stderr, text=True, env=environment, cwd=private_temp,
                                           timeout=min(CASE_SECONDS, remaining), preexec_fn=child_limits, start_new_session=True)
            try:
                actual = json.loads(stdout_path.read_bytes()[:MAX_OUTPUT_BYTES])
            except ValueError:
                actual = None
            passed = completed.returncode == 0 and isinstance(actual, dict) and actual.get("kind") == wanted_kind
            if wanted_kind == "value":
                passed = passed and actual.get("isInteger") is True and type(actual.get("value")) is int and actual["value"] == wanted_value
            outcomes.append({"index": index, "pass": bool(passed), "exitCode": completed.returncode, "actual": actual, "stderr": stderr_path.read_bytes()[:2000].decode(errors="replace")})
        except subprocess.TimeoutExpired:
            outcomes.append({"index": index, "pass": False, "reason": "case deadline"})
    preserved = sha_bytes(candidate.read_bytes()) == source_hash and sha_bytes(source.read_bytes()) == source_hash
    passed_count = sum(item["pass"] for item in outcomes)
    receipt = {
        "pass": passed_count == len(cases) and preserved,
        "sourceSha256": source_hash,
        "testSuiteSha256": suite_hash,
        "sandboxPolicySha256": specification["sandboxPolicySha256"],
        "concretePolicySha256": sha_bytes(json.dumps({"profile": specification["profile"], "caseParameters": case_parameters}, sort_keys=True).encode()),
        "exitCode": 0 if passed_count == len(cases) and preserved else 1,
        "casesPassed": passed_count,
        "casesTotal": len(cases),
        "sourcePreserved": preserved,
        "gradingElapsedMs": int((time.monotonic() - started) * 1000),
        "gradingOutsideInferenceBudget": True,
        "candidateContract": admission,
        "evidenceRoot": str(root),
        "isolation": {"profilePath": str(profile_path), "caseParameters": case_parameters, "definition": specification},
        "cases": outcomes,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x") as handle:
        json.dump(receipt, handle, indent=2)
        handle.write("\n")
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", nargs="?", type=Path)
    parser.add_argument("manifest", nargs="?", type=Path)
    parser.add_argument("output", nargs="?", type=Path)
    parser.add_argument("--policy-sha256", action="store_true")
    parser.add_argument("--contract-sha256", action="store_true")
    args = parser.parse_args()
    if args.contract_sha256:
        print(CONTRACT_SHA256)
    elif args.policy_sha256:
        print(runtime_spec()["sandboxPolicySha256"])
    elif args.source and args.manifest and args.output:
        result = check(args.source, args.manifest, args.output)
        print(json.dumps({key: result[key] for key in ["pass", "sourceSha256", "testSuiteSha256", "sandboxPolicySha256", "exitCode", "casesPassed", "casesTotal", "gradingElapsedMs"]}))
    else:
        parser.error("Supply source.py, private manifest.json and new receipt.json")
