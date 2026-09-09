#!/usr/bin/env python3
"""Pinned native file/terminal Hermes, confined by one macOS process boundary.

JSON stdin/stdout. The supervisor owns source copying and evidence; the worker
has no provider credential, evaluator fixtures, expected values or sibling data.
This is the declared filesystem/Python slice, not the complete Hermes product.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import uuid
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path("/private/tmp/atlas-hermes-evaluation")
SOURCE = ROOT / "source"
PREPARED_PYTHON = Path("/Users/apriansyahrs/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3")
TOOLSETS = ["file", "terminal", "todo", "memory"]
COMMIT = "089bb32886c8c18f7fa20182c7bf8826d6935ac5"
SYSTEM_READ = ["/bin", "/usr/bin", "/usr/sbin", "/usr/lib", "/usr/share", "/System", "/opt/homebrew/Cellar", "/opt/homebrew/lib", "/private/etc/ssl", "/private/etc/hosts", "/private/etc/resolv.conf", "/private/etc/localtime", "/private/etc/apache2/mime.types", "/dev/null", "/dev/random", "/dev/urandom"]


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def temporary_path(value: str) -> Path:
    path = Path(value).resolve()
    if not path.is_relative_to(Path("/private/tmp")):
        raise ValueError("Native comparison data must remain in private temporary storage")
    return path


def check_request(payload: dict) -> None:
    if any(key in payload for key in ("expected", "history", "fixtures")):
        raise ValueError("Evaluator expectations and seeded history cannot enter the runner")
    if not payload.get("runId") or any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for char in payload["runId"]):
        raise ValueError("Invalid run ID")
    url = urlparse(payload["proxyBaseUrl"])
    if url.scheme != "http" or url.hostname not in {"localhost", "127.0.0.1"} or not url.port or url.username or url.password or url.path not in {"", "/"} or url.query or url.fragment:
        raise ValueError("A credential-free explicit loopback model listener is required")
    if not isinstance(payload.get("taskTurns"), list) or not payload["taskTurns"] or not all(isinstance(turn, str) and turn.strip() for turn in payload["taskTurns"]):
        raise ValueError("Nonempty user task turns required")
    for name in ("maxGeneratedTokens", "maxOutputTokens", "maxProviderRequests", "timeoutMs"):
        value = payload["budget"][name]
        if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
            raise ValueError("Invalid shared resource budget")
    if not Path(payload["pythonPath"]).is_absolute() or not Path(payload["pythonPath"]).is_file() or Path(payload["pythonPath"]).resolve() != PREPARED_PYTHON.resolve():
        raise ValueError("The task interpreter must be the declared prepared Python runtime")


def copy_sources(source: Path, workspace: Path) -> list[dict]:
    result = []
    for path in sorted(source.rglob("*")):
        if path.is_symlink():
            raise ValueError("Fixture sources cannot contain symlinks")
        relative = path.relative_to(source)
        if relative.parts[0] not in {"input", "app"}:
            raise ValueError("Only input/ and app/ fixture sources are accepted")
        target = workspace / relative
        if path.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        elif path.is_file() and path.stat().st_size <= 20_000_000:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
            result.append({"path": str(relative), "sha256": sha(target)})
        else:
            raise ValueError("Unsupported or oversized fixture file")
    if not result:
        raise ValueError("Fixture source directory is empty")
    return result


def policy(workspace: Path, native: Path, prepared_python: Path, worker: Path, port: int) -> str:
    # No evaluation root, parent temp directory, user home, or repo root grant.
    if prepared_python.resolve() != PREPARED_PYTHON.resolve():
        raise ValueError("Unexpected task interpreter")
    roots = [Path(value).resolve() for value in SYSTEM_READ if Path(value).exists()]
    roots += [SOURCE.resolve(), (ROOT / "venv").resolve(), PREPARED_PYTHON.parent.parent.resolve()]
    reads = "\n".join(f"(subpath {json.dumps(str(root))})" for root in roots)
    return f'''(version 1)
(deny default)
(import "system.sb")
(allow process-exec process-fork)
(allow signal (target same-sandbox))
(allow file-read-metadata file-test-existence)
(allow file-read-data {reads} (literal {json.dumps(str(worker))}))
(allow file-read* file-write* (subpath {json.dumps(str(workspace))}) (subpath {json.dumps(str(native))}))
(allow file-read* file-write* (literal "/dev/null"))
(allow sysctl-read mach-lookup)
(allow network-outbound (remote tcp "localhost:{port}"))
'''


class SharedDeadline(BaseException):
    """Unwind stock tool execution through finally without an API retry."""


class OwnedProcesses:
    """Track actual worker descendants, including observed detached terminals.

    This is cleanup evidence, not a process namespace: an adversarial double fork
    entirely between samples is outside this bounded observer's guarantee.
    psutil Process objects check creation times before signalling reused PIDs.
    """

    def __init__(self, pid: int):
        import psutil
        self.psutil = psutil
        self.owner = psutil.Process(pid)
        self.observed = {}
        self.errors = []
        self.lock = threading.RLock()
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._watch, daemon=True)
        self.thread.start()

    def _sample(self):
        with self.lock:
            for parent in [self.owner, *self.observed.values()]:
                try:
                    for child in parent.children(recursive=True):
                        self.observed[(child.pid, child.create_time())] = child
                except (self.psutil.NoSuchProcess, self.psutil.ZombieProcess):
                    pass
                except self.psutil.AccessDenied:
                    self.errors.append({"pid": parent.pid, "operation": "children"})

    def _watch(self):
        while not self.stop.is_set():
            self._sample()
            self.stop.wait(0.02)

    def _alive(self, proc):
        try:
            return proc.is_running() and proc.status() != self.psutil.STATUS_ZOMBIE
        except self.psutil.NoSuchProcess:
            return False
        except self.psutil.AccessDenied:
            return True

    def finish(self):
        self._sample()
        self.stop.set()
        self.thread.join(timeout=1)
        targets = list(self.observed.values())
        terminated = []
        for proc in reversed(targets):
            if self._alive(proc):
                try:
                    proc.terminate()
                    terminated.append(proc.pid)
                except self.psutil.NoSuchProcess:
                    pass
                except self.psutil.AccessDenied:
                    self.errors.append({"pid": proc.pid, "operation": "terminate"})
        deadline = time.monotonic() + 2
        while any(self._alive(proc) for proc in targets) and time.monotonic() < deadline:
            time.sleep(0.02)
        for proc in targets:
            if self._alive(proc):
                try:
                    proc.kill()
                except self.psutil.NoSuchProcess:
                    pass
                except self.psutil.AccessDenied:
                    self.errors.append({"pid": proc.pid, "operation": "kill"})
        deadline = time.monotonic() + 1
        while any(self._alive(proc) for proc in targets) and time.monotonic() < deadline:
            time.sleep(0.02)
        remaining = [proc.pid for proc in targets if self._alive(proc)]
        return {"completed": not remaining and not self.errors and not self.thread.is_alive(), "observedPids": [proc.pid for proc in targets], "terminatedPids": terminated, "remainingPids": remaining, "errors": self.errors, "scope": "Native close plus sampled descendants; not a hostile double-fork containment proof."}


def drain(deadline: float) -> dict:
    import threading
    from agent.review_idle_queue import QUEUE
    while time.monotonic() < deadline:
        threads = [thread for thread in threading.enumerate() if thread.name in {"bg-review", "auto-title"} and thread.is_alive()]
        if not threads and QUEUE.pending_count() == 0:
            return {"completed": True}
        if threads:
            threads[0].join(timeout=min(0.1, max(0, deadline - time.monotonic())))
        else:
            time.sleep(0.02)
    return {"completed": False, "reason": "shared deadline"}


def worker(payload: dict) -> dict:
    started = time.monotonic()
    deadline = started + payload["remainingMs"] / 1000
    workspace, native = Path(payload["workspaceRoot"]), Path(payload["nativeStateRoot"])
    base = f"{payload['proxyBaseUrl'].rstrip('/')}/runs/{payload['runId']}/v1"
    os.environ.update({"HERMES_HOME": str(native), "TERMINAL_CWD": str(workspace), "TERMINAL_ENV": "local", "OPENAI_API_KEY": "benchmark-local", "OPENAI_BASE_URL": base, "PYTHONDONTWRITEBYTECODE": "1", "NO_COLOR": "1"})
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(SOURCE))
    os.chdir(workspace)
    events, turns = [], []
    session_id = f"session-{uuid.uuid4()}"
    output = {"framework": "hermes", "runId": payload["runId"], "model": payload["model"], "workspaceRoot": str(workspace), "nativeStateRoot": str(native), "status": "failed", "finalText": "", "nativeEvents": events, "sessions": [{"id": session_id, "initialHistoryCount": 0, "turns": turns}], "evidence": {"hermesCommit": COMMIT, "declaredToolsets": TOOLSETS}}
    turn_index = -1
    agent, db, registry = None, None, None
    history = []

    def checkpoint():
        # Diagnostic fallback only: native state is model-writable and cannot
        # certify a run. Successful output still comes from the worker pipe.
        try:
            pending = native / "partial-output.pending"
            pending.write_text(json.dumps(output, default=str))
            pending.replace(native / "partial-output.json")
        except Exception as error:
            print(f"Checkpoint failed: {type(error).__name__}", file=sys.stderr)

    def timeout(_signum, _frame):
        raise SharedDeadline("Shared trial deadline")

    def completed(call_id, name, arguments, result):
        events.append({"callId": call_id, "name": name, "arguments": arguments, "result": result, "turnIndex": turn_index, "at": time.time()})
        checkpoint()

    checkpoint()
    signal.signal(signal.SIGTERM, timeout)
    signal.signal(signal.SIGALRM, timeout)
    signal.setitimer(signal.ITIMER_REAL, max(0.01, deadline - time.monotonic()))
    try:
        from run_agent import AIAgent
        from hermes_state import SessionDB
        from model_tools import get_tool_definitions
        from tools.process_registry import process_registry
        registry = process_registry
        db = SessionDB(native / "state.db")
        output["sessions"][0]["initialHistoryCount"] = len(db.get_messages(session_id))
        agent = AIAgent(model=payload["model"], provider="custom", api_mode="chat_completions", api_key="benchmark-local", base_url=base,
                    max_iterations=payload["budget"]["maxProviderRequests"], max_tokens=payload["budget"]["maxOutputTokens"], request_overrides={"temperature": 0.2},
                    run_budget_seconds=max(0.1, deadline - time.monotonic()), enabled_toolsets=TOOLSETS, quiet_mode=True, save_trajectories=False,
                    skip_context_files=True, skip_memory=False, session_id=session_id, session_db=db, tool_complete_callback=completed)
        output["evidence"].update({"toolCatalog": agent.tools, "expandedToolCatalog": get_tool_definitions(TOOLSETS, quiet_mode=True, skip_tool_search_assembly=True), "contextResolution": {"resolved": agent.context_compressor.context_length, "providerAdvertisedContextUnknown": True}, "skipBackgroundReview": agent.skip_background_review})
        for index, turn in enumerate(payload["taskTurns"]):
            turn_index = index
            if time.monotonic() >= deadline:
                raise TimeoutError("Shared trial deadline")
            at = time.monotonic()
            result = agent.run_conversation(turn, conversation_history=history)
            status = "completed" if result.get("completed") and not result.get("failed") and not result.get("interrupted") else "failed"
            turns.append({"index": index, "input": turn, "status": status, "elapsedMs": int((time.monotonic() - at) * 1000), "finalText": result.get("final_response", ""), "nativeResult": result})
            output["finalText"] = result.get("final_response", "")
            history = result.get("messages") or []
            checkpoint()
            if status != "completed":
                break
        output["evidence"]["backgroundDrain"] = drain(deadline)
        output["status"] = "completed" if len(turns) == len(payload["taskTurns"]) and all(turn["status"] == "completed" for turn in turns) and output["evidence"]["backgroundDrain"]["completed"] else "failed"
    except SharedDeadline as error:
        output["status"] = "budget_exceeded"
        output["error"] = str(error)
    except Exception as error:
        output["error"] = f"{type(error).__name__}: {error}"
        traceback.print_exc(file=sys.stderr)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        output["sessions"][0]["history"] = history
        checkpoint()
        try:
            if agent is not None:
                agent.close()
            # Stock local terminals use the environment key "default", while
            # close() filters the agent session ID. This disposable worker owns
            # the entire registry; clean any remaining entries through its
            # public API, without changing stock task/tool routing.
            leftovers = registry.list_sessions() if registry else []
            killed = registry.kill_all(source="native_file_worker_shutdown") if registry else 0
            active = registry.has_any_active() if registry else False
            output["evidence"]["nativeCleanup"] = {"completed": not active, "afterAgentClose": leftovers, "isolatedRegistryKilled": killed, "sessions": registry.list_sessions() if registry else []}
            if active:
                output["status"] = "failed"
        except Exception as error:
            output["evidence"]["nativeCleanup"] = {"completed": False, "error": f"{type(error).__name__}: {error}"}
            output["status"] = "failed"
        finally:
            if db is not None:
                try:
                    output["sessions"][0]["persistedMessages"] = db.get_messages(session_id)
                finally:
                    db.close()
    output["elapsedMs"] = int((time.monotonic() - started) * 1000)
    checkpoint()
    return output


def run(payload: dict) -> dict:
    check_request(payload)
    if sys.platform != "darwin":
        raise RuntimeError("This native file supervisor requires the verified macOS OS sandbox")
    started = time.monotonic()
    parent = temporary_path(payload.get("stateRoot", str(ROOT / "native-file-state")))
    parent.mkdir(parents=True, exist_ok=True)
    directory = Path(tempfile.mkdtemp(prefix="hermes-native-files-", dir=parent))
    workspace, native = directory / "workspace", directory / "native-state"
    workspace.mkdir()
    native.mkdir()
    (native / "tmp").mkdir()
    sources = copy_sources(temporary_path(payload["sourceDirectory"]), workspace)
    worker_path = directory / "worker.py"
    shutil.copyfile(Path(__file__), worker_path)
    base = f"{payload['proxyBaseUrl'].rstrip('/')}/runs/{payload['runId']}/v1"
    config = {"model": {"provider": "custom", "default": payload["model"], "base_url": base, "streaming": False}, "security": {"allow_lazy_installs": False}, "mcp_servers": {}}
    (native / "config.yaml").write_text(json.dumps(config))
    profile = policy(workspace, native, Path(payload["pythonPath"]), worker_path, urlparse(base).port)
    (directory / "sandbox.sb").write_text(profile)
    request = {key: payload[key] for key in ("runId", "proxyBaseUrl", "model", "budget", "taskTurns")}
    request.update({"workspaceRoot": str(workspace), "nativeStateRoot": str(native), "remainingMs": max(1, payload["budget"]["timeoutMs"] - int((time.monotonic() - started) * 1000))})
    import certifi
    ca_bundle = Path(certifi.where()).resolve()
    if not ca_bundle.is_relative_to((ROOT / "venv").resolve()) or not ca_bundle.is_file():
        raise ValueError("Expected the pinned Hermes environment's public CA bundle")
    environment = {"PATH": "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(native / "tmp"), "TMPDIR": str(native / "tmp"), "PYTHONDONTWRITEBYTECODE": "1", "NO_COLOR": "1", "LANG": "en_US.UTF-8", "SSL_CERT_FILE": str(ca_bundle)}
    timed_out = False
    hard_killed = False
    stdout_path, stderr_path = directory / "worker-stdout.json", directory / "worker-stderr.log"
    # Files avoid hanging communicate() when a detached terminal inherits pipes.
    with stdout_path.open("w") as stdout_file, stderr_path.open("w") as stderr_file:
        process = subprocess.Popen(["/usr/bin/sandbox-exec", "-p", profile, sys.executable, str(worker_path), "--worker"], stdin=subprocess.PIPE, stdout=stdout_file, stderr=stderr_file, text=True, cwd=workspace, env=environment, start_new_session=True)
        owned = OwnedProcesses(process.pid)
        try:
            process.communicate(json.dumps(request), timeout=request["remainingMs"] / 1000)
        except subprocess.TimeoutExpired:
            timed_out = True
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                hard_killed = True
                process.kill()
                process.wait(timeout=3)
        finally:
            # Only observed children (PID + creation time), never unrelated host
            # processes or identities supplied through model-writable files.
            cleanup = owned.finish()
    stdout = stdout_path.read_text()
    try:
        output = json.loads(stdout)
        if not isinstance(output, dict) or not isinstance(output.get("evidence"), dict):
            raise ValueError("Invalid worker output shape")
    except (ValueError, TypeError):
        output = {"framework": "hermes", "runId": payload["runId"], "model": payload["model"], "status": "failed", "finalText": "", "sessions": [], "nativeEvents": [], "evidence": {"workerOutputInvalid": True}}
        partial_path = native / "partial-output.json"
        if partial_path.is_file() and not partial_path.is_symlink() and partial_path.stat().st_size <= 20_000_000:
            try:
                partial = json.loads(partial_path.read_text())
                for key in ("sessions", "nativeEvents"):
                    if isinstance(partial.get(key), list):
                        output[key] = partial[key]
                output["evidence"]["partialEvidence"] = {"recovered": True, "trustedForCertification": False, "source": str(partial_path)}
            except (ValueError, TypeError, AttributeError):
                pass
    if timed_out or process.returncode:
        output["status"] = "budget_exceeded" if timed_out else "failed"
    safe_to_inspect = cleanup["completed"] and not hard_killed and output["evidence"].get("nativeCleanup", {}).get("completed") is True
    if not safe_to_inspect:
        output["status"] = "budget_exceeded" if timed_out else "failed"
    files = []
    for path in sorted(workspace.rglob("*")) if safe_to_inspect else []:
        if path.is_symlink():
            files.append({"path": str(path.relative_to(workspace)), "symlink": True})
        elif path.is_file() and path.stat().st_size <= 20_000_000:
            files.append({"path": str(path.relative_to(workspace)), "bytes": path.stat().st_size, "sha256": sha(path)})
    output.update({"workspaceRoot": str(workspace), "nativeStateRoot": str(native), "sourceCopies": sources, "workspaceFiles": files, "elapsedMs": int((time.monotonic() - started) * 1000)})
    output.setdefault("evidence", {}).update({"sandboxPolicySha256": hashlib.sha256(profile.encode()).hexdigest(), "sandboxProfile": str(directory / "sandbox.sb"), "workerExitCode": process.returncode, "workerStderr": str(stderr_path), "workerStdout": str(stdout_path), "configuration": config, "caBundle": {"path": str(ca_bundle), "sha256": sha(ca_bundle), "verificationDisabled": False}, "supervisorCleanup": cleanup, "workerHardKilled": hard_killed, "artifactInspectionAllowed": safe_to_inspect, "scope": "Native filesystem/terminal/Python tools on prepared dependencies; not the full default catalog or UI attachment flows."})
    return output


if __name__ == "__main__":
    try:
        payload = json.load(sys.stdin)
        with contextlib.redirect_stdout(sys.stderr):
            output = worker(payload) if "--worker" in sys.argv else run(payload)
        print(json.dumps(output, default=str))
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"framework": "hermes", "status": "failed", "error": f"{type(error).__name__}: {error}"}))
        sys.exit(1)
