#!/usr/bin/env python3
"""Two native Hermes sessions, isolated disk memory, and one caller-owned budget.

The supervisor starts a fresh Python process for each real AIAgent session. Warm
recall reopens the training HERMES_HOME/state.db; cold recall gets an empty home.
Only the supplied user turns can teach facts. No Hermes source, prompt, tool
handler, review trigger, or memory policy is replaced. JSON stdin/stdout interface;
the localhost proxy is the authoritative ledger for all main and auxiliary calls.
"""

from __future__ import annotations

import contextlib
import datetime
import hashlib
import ipaddress
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.parse
from pathlib import Path
from typing import Any

HERMES_COMMIT = "089bb32886c8c18f7fa20182c7bf8826d6935ac5"
EVALUATION_ROOT = Path("/private/tmp/atlas-hermes-evaluation")
SOURCE = EVALUATION_ROOT / "source"
LOCAL_TOKEN = "benchmark-local"
TOOLSETS = ["memory", "session_search", "todo"]
ENV_KEEP = {"PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "SYSTEMROOT"}
DUMP_LOCK = threading.RLock()


def isolated_path(raw: str, *, exists: bool = False) -> Path:
    value = Path(raw).resolve()
    if not value.is_relative_to(Path("/private/tmp")):
        raise ValueError("Product evaluation state and workspace must be under /private/tmp.")
    if exists and not value.is_dir():
        raise ValueError(f"Missing evaluation directory: {value}")
    return value


def provider_url(origin: str, run_id: str) -> str:
    parsed = urllib.parse.urlparse(origin)
    if parsed.scheme != "http" or parsed.username or parsed.password or not parsed.port:
        raise ValueError("proxyBaseUrl must be plain HTTP on loopback with an explicit port.")
    if parsed.hostname != "localhost" and not ipaddress.ip_address(parsed.hostname or "").is_loopback:
        raise ValueError("Only a loopback evaluation proxy is permitted.")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise ValueError("proxyBaseUrl must be the proxy origin, without a path/query.")
    return f"{origin.rstrip('/')}/runs/{urllib.parse.quote(run_id, safe='')}/v1"


def clean_environment() -> dict[str, str]:
    return {key: value for key, value in os.environ.items() if key in ENV_KEEP}


def dump(path: Path, value: Any) -> None:
    # A separate evidence directory is never offered through Hermes's tools.
    with DUMP_LOCK:
        temporary = path.with_suffix(".pending")
        temporary.write_text(json.dumps(value, ensure_ascii=False, default=str), encoding="utf-8")
        temporary.replace(path)


def memory_snapshot(home: Path) -> dict[str, Any]:
    files = {}
    for name in ("MEMORY.md", "USER.md"):
        path = home / "memories" / name
        content = path.read_text(encoding="utf-8") if path.exists() else None
        files[name] = {
            "exists": content is not None, "content": content,
            "sha256": hashlib.sha256(content.encode()).hexdigest() if content is not None else None,
        }
    return {"home": str(home), "files": files, "atUnixMs": int(time.time() * 1000)}


def install_worker_isolation(port: int, home: Path, events: list, denied: list) -> None:
    """Block process/network escape and host-user configuration reads.

    This is supplementary Python auditing, not a claim of a hostile-code sandbox.
    No shell/filesystem/browser/plugin tools are exposed to the model.
    """
    os.environ.clear()
    # Parent already supplied only this small environment; executable paths are
    # never usable by the model because every subprocess creation is denied.
    os.environ.update({"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8"})

    def audit(event: str, args: tuple[Any, ...]) -> None:
        if event in {"subprocess.Popen", "os.system", "os.posix_spawn", "os.exec"}:
            denied.append({"event": event, "target": Path(str(args[0])).name})
            raise PermissionError("Subprocesses are disabled inside the native memory session.")
        if event == "socket.getaddrinfo" and args[0] not in {"localhost", "127.0.0.1", "::1", None}:
            denied.append({"event": event, "target": str(args[0])})
            raise PermissionError("External DNS is disabled in this evaluation.")
        if event == "socket.connect":
            address = args[1]
            permitted = False
            if isinstance(address, tuple) and len(address) >= 2:
                with contextlib.suppress(ValueError):
                    permitted = ipaddress.ip_address(address[0]).is_loopback and address[1] == port
            if not permitted:
                denied.append({"event": event, "target": str(address)})
                raise PermissionError("Only the declared localhost proxy may be contacted.")
        if event in {"open", "os.listdir", "os.scandir", "sqlite3.connect"}:
            raw = args[0]
            if isinstance(raw, (str, bytes, os.PathLike)):
                path = os.path.abspath(os.fsdecode(raw))
                if path == "/Users" or path.startswith("/Users/"):
                    denied.append({"event": event, "target": "host user directory"})
                    raise PermissionError("Host user directories are excluded from evaluation.")
                if event == "open" and path.startswith(str(home / "memories") + "/"):
                    flags = args[2] if len(args) > 2 else 0
                    if isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT):
                        events.append({"event": "native-memory-file-open-for-write", "path": path,
                                       "thread": threading.current_thread().name,
                                       "atUnixMs": int(time.time() * 1000)})

    sys.addaudithook(audit)


def drain_background(deadline: float) -> dict[str, Any]:
    """Let stock review threads finish; do not force a review or lower its interval."""
    from agent.review_idle_queue import QUEUE

    started = time.monotonic()
    seen = set()
    while True:
        threads = [thread for thread in threading.enumerate()
                   if thread.name in {"bg-review", "auto-title"} and thread.is_alive()]
        seen.update(id(thread) for thread in threads)
        pending = QUEUE.pending_count()
        if not threads and pending == 0:
            return {"completed": True, "observedThreads": len(seen), "pendingDeferred": 0,
                    "wallSeconds": time.monotonic() - started}
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return {"completed": False, "observedThreads": len(seen), "pendingDeferred": pending,
                    "liveThreads": len(threads), "wallSeconds": time.monotonic() - started}
        if threads:
            threads[0].join(timeout=min(0.1, remaining))
        else:
            time.sleep(min(0.1, remaining))


def native_status(result: dict[str, Any]) -> str:
    return "completed" if result.get("completed") and not result.get("failed") and not result.get("interrupted") else "failed"


def worker(payload: dict[str, Any]) -> dict[str, Any]:
    started = time.monotonic()
    deadline = started + payload["remainingMs"] / 1000
    home = isolated_path(payload["nativeHome"], exists=True)
    workspace = isolated_path(payload["workspaceRoot"], exists=True)
    evidence = isolated_path(payload["evidenceRoot"], exists=True)
    output_path = evidence / f"{payload['phase']}.json"
    base_url = provider_url(payload["proxyBaseUrl"], payload["runId"])
    events: list[dict[str, Any]] = []
    denied: list[dict[str, Any]] = []
    install_worker_isolation(urllib.parse.urlparse(base_url).port, home, events, denied)
    os.environ.update({"HERMES_HOME": str(home), "TERMINAL_CWD": str(workspace),
                       "OPENAI_API_KEY": LOCAL_TOKEN, "OPENAI_BASE_URL": base_url,
                       "PYTHONDONTWRITEBYTECODE": "1", "NO_COLOR": "1"})
    sys.dont_write_bytecode = True
    os.chdir(workspace)
    sys.path.insert(0, str(SOURCE))
    session_id = f"memory-product-{payload['runId']}-{payload['phase']}"
    output: dict[str, Any] = {
        "id": session_id, "phase": payload["phase"], "processId": os.getpid(),
        "home": str(home), "databasePath": str(home / "state.db"),
        "nativeStateRoot": str(home),
        "initialHistoryCount": 0,
        "turns": [], "nativeEvents": events, "deniedIO": denied, "status": "failed",
        "snapshots": {"beforeAgent": memory_snapshot(home)}, "providerRequestTrace": [],
        "requestedTurns": len(payload["turns"]), "finalText": "",
    }
    dump(output_path, output)
    turn_index = -1

    def observe_request(request):
        if request.method != "POST" or not request.url.path.endswith("/chat/completions"):
            return
        body = json.loads(request.content)
        messages = body.get("messages", [])
        trace = {"atUnixMs": int(time.time() * 1000), "url": str(request.url),
                 "messagesSha256": hashlib.sha256(json.dumps(messages, sort_keys=True).encode()).hexdigest(),
                 "roles": [message.get("role") for message in messages], "model": body.get("model"),
                 "thread": threading.current_thread().name, "hasTools": bool(body.get("tools"))}
        output["providerRequestTrace"].append(trace)
        if "firstProviderRequest" not in output:
            output["firstProviderRequest"] = {**trace, "messages": messages, "memory": memory_snapshot(home)}
        if body.get("tools") and "firstMainProviderRequest" not in output:
            output["firstMainProviderRequest"] = {**trace, "messages": messages, "memory": memory_snapshot(home)}
        try:
            dump(output_path, output)
        except Exception as exc:
            # An evidence write failure must not alter provider retry decisions.
            output.setdefault("observationErrors", []).append(f"{type(exc).__name__}: {exc}")

    # Hermes creates per-request clients, so observing its initial client alone
    # misses real traffic. Add HTTPX's supported request hook as each client is
    # constructed. This dependency instrumentation passes every original client
    # argument unchanged except appending the passive hook; no harness decisions,
    # request bytes, responses, retry behavior or tool handlers are replaced.
    import httpx
    original_client_init = httpx.Client.__init__

    def observed_client_init(client, *args, **kwargs):
        hooks = {key: list(value) for key, value in (kwargs.get("event_hooks") or {}).items()}
        hooks.setdefault("request", []).append(observe_request)
        original_client_init(client, *args, **{**kwargs, "event_hooks": hooks})

    httpx.Client.__init__ = observed_client_init
    from run_agent import AIAgent
    from hermes_state import SessionDB
    from agent.background_review import load_background_review_settings
    from model_tools import get_tool_definitions

    db = SessionDB(home / "state.db")
    output["initialPersistedMessageCount"] = len(db.get_messages(session_id))

    def tool_start(call_id, name, arguments):
        events.append({"event": "tool-start", "id": call_id, "name": name, "arguments": arguments,
                       "turnIndex": turn_index,
                       "atUnixMs": int(time.time() * 1000)})

    def tool_complete(call_id, name, arguments, result):
        events.append({"event": "tool-complete", "id": call_id, "name": name,
                       "turnIndex": turn_index,
                       "arguments": arguments, "result": result, "atUnixMs": int(time.time() * 1000)})

    kwargs: dict[str, Any] = {}
    reasoning = payload.get("reasoning", payload.get("thinking"))
    if reasoning is not None:
        kwargs["reasoning_config"] = reasoning
    agent = AIAgent(
        model=payload["model"], provider="custom", api_mode="chat_completions",
        api_key=LOCAL_TOKEN, base_url=base_url,
        max_iterations=payload["budget"]["maxProviderRequests"],
        max_tokens=payload["budget"]["maxOutputTokens"], request_overrides={"temperature": 0.2},
        run_budget_seconds=max(0.01, deadline - time.monotonic()), enabled_toolsets=TOOLSETS,
        quiet_mode=True, save_trajectories=False, skip_context_files=True, skip_memory=False,
        session_id=session_id, session_db=db,
        tool_start_callback=tool_start, tool_complete_callback=tool_complete, **kwargs,
    )
    agent.background_review_callback = lambda summary: events.append(
        {"event": "background-review-summary", "summary": summary, "atUnixMs": int(time.time() * 1000)})
    review_enabled, review_config = load_background_review_settings()
    output.update({
        "toolCatalog": agent.tools,
        "expandedToolCatalog": get_tool_definitions(TOOLSETS, quiet_mode=True, skip_tool_search_assembly=True),
        "nativeSettings": {"reviewEnabled": review_enabled, "reviewConfig": review_config,
                           "skipBackgroundReview": agent.skip_background_review,
                           "memoryNudgeInterval": agent._memory_nudge_interval,
                           "memoryEnabled": agent._memory_enabled,
                           "userProfileEnabled": agent._user_profile_enabled},
        "contextResolution": {"resolved": agent.context_compressor.context_length,
                              "configured": None, "providerAdvertisedContextUnknown": True,
                              "policy": "Unmodified Hermes endpoint/model-name/fallback resolver; this is not provider evidence."},
    })

    history: list[dict[str, Any]] = []
    try:
        for index, turn in enumerate(payload["turns"]):
            turn_index = index
            if time.monotonic() >= deadline:
                output["error"] = "Shared session lifecycle deadline reached before next turn."
                break
            turn_started = time.monotonic()
            result = agent.run_conversation(turn, conversation_history=history)
            status = native_status(result)
            output["turns"].append({"index": index, "input": turn, "finalText": result.get("final_response", ""),
                                    "elapsedMs": int((time.monotonic() - turn_started) * 1000),
                                    "status": status, "nativeResult": result})
            output["finalText"] = result.get("final_response", "")
            history = result.get("messages") or []
            dump(output_path, output)
            if status != "completed":
                break
        output["backgroundDrain"] = drain_background(deadline)
        output["status"] = "completed" if (
            len(output["turns"]) == len(payload["turns"])
            and all(turn["status"] == "completed" for turn in output["turns"])
            and output["backgroundDrain"]["completed"]
        ) else "failed"
    except Exception as exc:
        output["error"] = f"{type(exc).__name__}: {exc}"
        traceback.print_exc(file=sys.stderr)
        output["backgroundDrain"] = drain_background(deadline)
    finally:
        output["snapshots"]["afterTurnsAndDrain"] = memory_snapshot(home)
        output["foregroundUsage"] = {key: getattr(agent, f"session_{key}", None) for key in (
            "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens",
            "api_calls", "estimated_cost_usd", "cost_status", "cost_source")}
        output["systemPrompt"] = str(getattr(agent, "_cached_system_prompt", "") or "")
        output["systemPromptSha256"] = hashlib.sha256(output["systemPrompt"].encode()).hexdigest()
        output["lifecycleErrors"] = []
        for stage, close_action in [
            ("agent.close", agent.close),
            ("database.end_session", lambda: db.end_session(session_id, "product-evaluation-session-ended")),
            ("database.close", db.close),
        ]:
            try:
                close_action()
            except Exception as exc:
                output["lifecycleErrors"].append({"stage": stage, "error": f"{type(exc).__name__}: {exc}"})
        output["backgroundDrainAfterClose"] = drain_background(deadline)
        output["snapshots"]["afterCloseAndDrain"] = memory_snapshot(home)
        if output["lifecycleErrors"] or not output["backgroundDrainAfterClose"]["completed"]:
            output["status"] = "failed"
        with sqlite3.connect(home / "state.db") as connection:
            connection.row_factory = sqlite3.Row
            output["databaseUsage"] = [dict(row) for row in connection.execute(
                "SELECT * FROM session_model_usage WHERE session_id = ?", (session_id,))]
        output["wallSeconds"] = time.monotonic() - started
        output["elapsedMs"] = int(output["wallSeconds"] * 1000)
        dump(output_path, output)
    return output


def run(payload: dict[str, Any]) -> dict[str, Any]:
    started = time.monotonic()
    run_id = payload["runId"]
    if not isinstance(run_id, str) or not run_id or any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for char in run_id):
        raise ValueError("runId must contain only letters, numbers, hyphens, and underscores.")
    if payload["condition"] not in {"native-default", "explicit-memory"}:
        raise ValueError("Unknown native memory condition.")
    recall_identity = payload.get("recallIdentity", "same-owner")
    if recall_identity not in {"same-owner", "different-user", "different-organization"}:
        raise ValueError("Unknown recallIdentity.")
    for key in ("trainingTurns", "recallTurns"):
        if not isinstance(payload[key], list) or not payload[key] or not all(isinstance(turn, str) and turn for turn in payload[key]):
            raise ValueError(f"{key} must be nonempty user turns.")
    for key in ("maxProviderRequests", "maxGeneratedTokens", "maxOutputTokens", "timeoutMs"):
        value = payload["budget"][key]
        if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
            raise ValueError(f"budget.{key} must be a positive integer.")
    base_url = provider_url(payload["proxyBaseUrl"], run_id)
    parent = isolated_path(payload.get("stateRoot") or str(EVALUATION_ROOT / "product-memory-runs"))
    parent.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix=f"hermes-{run_id}-", dir=parent))
    workspace = isolated_path(payload["workspaceRoot"], exists=True) if payload.get("workspaceRoot") else root / "workspace"
    workspace.mkdir(exist_ok=True)
    evidence = root / "runner-evidence"
    evidence.mkdir()
    # JSON is a valid YAML subset, so no dependency is needed in the supervisor.
    config = {"model": {"provider": "custom", "default": payload["model"], "base_url": base_url, "streaming": False},
              "security": {"allow_lazy_installs": False}, "mcp_servers": {}}
    training_home = root / "native-state"
    training_home.mkdir()
    (training_home / "config.yaml").write_text(json.dumps(config), encoding="utf-8")
    recall_home = training_home
    if payload.get("coldControl") or recall_identity != "same-owner":
        recall_home = root / "cold-native-state"
        recall_home.mkdir()
        (recall_home / "config.yaml").write_text(json.dumps(config), encoding="utf-8")
    output = {
        "framework": "hermes", "harness": "hermes", "hermesCommit": HERMES_COMMIT, "runId": run_id,
        "stateRoot": str(root),
        "condition": payload["condition"], "coldControl": bool(payload.get("coldControl")),
        "recallIdentity": recall_identity,
        "identityIsolation": "Same persistent home" if recall_home == training_home else "Separate empty native home/installation; not a Hermes in-product tenant ACL",
        "model": payload["model"], "providerBaseUrl": base_url, "budget": payload["budget"],
        "configuration": config, "sessions": [], "status": "failed", "finalText": "",
        "declaredDeviations": [
            "Memory product slice: native memory, session_search and todo tools only; other tools excluded.",
            "Fresh isolated Hermes home and worker process; host configuration/environment and project context absent.",
            "Native memory and background review defaults retained in both conditions; only supplied user turns differ.",
            "The end of each session drains stock review threads within the remaining shared wall-clock budget.",
            "Native automatic session titles remain enabled and are drained; their auxiliary calls share the same budget.",
            "Main and auxiliary traffic share one proxy runId/model/budget; the proxy ledger is authoritative usage.",
            "Python auditing blocks subprocesses, external sockets/DNS and host user directory reads.",
            "HTTPX client construction is instrumented only to append passive request hooks, recording actual sync requests without replacing inference or the loop.",
            "Nonstreaming requests, temperature 0.2, supplied per-call output/iteration/wall limits.",
        ],
    }
    deadline = started + payload["budget"]["timeoutMs"] / 1000
    for phase, home, turns in (("training", training_home, payload["trainingTurns"]),
                               ("recall", recall_home, payload["recallTurns"])):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            output["error"] = f"Shared lifecycle deadline expired before {phase}."
            break
        worker_payload = {**payload, "phase": phase, "nativeHome": str(home), "turns": turns,
                          "workspaceRoot": str(workspace), "evidenceRoot": str(evidence),
                          "remainingMs": int(remaining * 1000)}
        log_path = evidence / f"{phase}.stderr.log"
        with log_path.open("w", encoding="utf-8") as stderr:
            process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--session-worker"],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr,
                                       text=True, env=clean_environment(), cwd=str(workspace))
            timed_out = False
            try:
                stdout, _ = process.communicate(json.dumps(worker_payload), timeout=remaining)
            except subprocess.TimeoutExpired:
                timed_out = True
                process.kill()
                stdout, _ = process.communicate()
        saved = evidence / f"{phase}.json"
        session = json.loads(saved.read_text()) if saved.exists() else {
            "id": f"memory-product-{run_id}-{phase}", "phase": phase, "initialHistoryCount": 0,
            "nativeStateRoot": str(home),
            "turns": [], "status": "failed", "finalText": ""}
        if timed_out or process.returncode != 0:
            session["status"] = "failed"
            session["workerError"] = "Shared lifecycle deadline exceeded." if timed_out else f"Worker exited {process.returncode}."
            session["workerErrorOutput"] = stdout[-4000:]
        session["stderrPath"] = str(log_path)
        output["sessions"].append(session)
        if phase == "recall":
            output["finalText"] = session.get("finalText", "")
        dump(evidence / "supervisor.json", output)
    if len(output["sessions"]) == 2 and all(session["status"] == "completed" for session in output["sessions"]):
        output["status"] = "completed"
    output["wallSeconds"] = time.monotonic() - started
    output["elapsedMs"] = int(output["wallSeconds"] * 1000)
    output["nativeEvents"] = []
    output["snapshots"] = []
    for session in output["sessions"]:
        for event in session.get("nativeEvents", []):
            output["nativeEvents"].append({**event, "sessionId": session["id"], "phase": session["phase"],
                "turnIndex": event.get("turnIndex", -1), "name": event.get("name", event["event"]), "callId": event.get("id", ""),
                "arguments": event.get("arguments"), "result": event.get("result", event.get("summary")),
                "observedAt": datetime.datetime.fromtimestamp(event["atUnixMs"] / 1000, datetime.timezone.utc).isoformat()})
        for label, snapshot in session.get("snapshots", {}).items():
            output["snapshots"].append({"label": f"{session['phase']}:{label}",
                                      "nativeStateRoot": session["nativeStateRoot"], "state": snapshot})
        if session.get("firstProviderRequest"):
            output["snapshots"].append({"label": f"{session['phase']}:first-provider-request",
                                      "nativeStateRoot": session["nativeStateRoot"],
                                      "state": session["firstProviderRequest"]})
        if session.get("firstMainProviderRequest"):
            output["snapshots"].append({"label": f"{session['phase']}:first-main-provider-request",
                                      "nativeStateRoot": session["nativeStateRoot"],
                                      "state": session["firstMainProviderRequest"]})
    output["evidence"] = {"hermesCommit": HERMES_COMMIT, "configuration": config,
                          "declaredDeviations": output["declaredDeviations"],
                          "identityIsolation": output["identityIsolation"],
                          "suppliedModelMetadata": payload.get("modelMetadata"),
                          "aggregateUsageAuthority": "Caller proxy ledger includes all main/aux requests and failures.",
                          "runnerEvidenceRoot": str(evidence)}
    dump(evidence / "supervisor.json", output)
    return output


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        with contextlib.redirect_stdout(sys.stderr):
            output = worker(payload) if sys.argv[1:] == ["--session-worker"] else run(payload)
        exit_code = 0
    except Exception as exc:
        output = {"status": "failed", "finalText": "", "error": f"{type(exc).__name__}: {exc}"}
        traceback.print_exc(file=sys.stderr)
        exit_code = 1
    sys.__stdout__.write(json.dumps(output, ensure_ascii=False, default=str) + "\n")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
