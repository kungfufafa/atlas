#!/usr/bin/env python3
"""Run pinned, unmodified Hermes AIAgent against the evaluation's local proxy.

Read one JSON object from stdin and write one JSON object to stdout. Diagnostics
go to stderr. Required input: run_id, base_url, model, prompt or turns, workspace.
The caller owns the actual provider credential and budgets; this process only
knows the non-secret ``benchmark-local`` proxy credential.

This measures the production Hermes loop and prompt with shared external task
capabilities plus Hermes's intrinsic memory/todo tools. It is neither an exact
tool-catalog match nor an out-of-box product comparison. No Hermes source or
loop is patched. All isolation/configuration differences are returned in JSON.
"""

from __future__ import annotations

import contextlib
import hashlib
import ipaddress
import json
import os
import sys
import time
import traceback
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


HERMES_COMMIT = "089bb32886c8c18f7fa20182c7bf8826d6935ac5"
EVALUATION_ROOT = Path("/private/tmp/atlas-hermes-evaluation")
COMMON_TOOL_NAMES = frozenset(
    {"read_file", "write_file", "list_files", "calculate", "fetch_document"}
)
LOCAL_TOKEN = "benchmark-local"


def local_url(value: str) -> str:
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme != "http" or parsed.username or parsed.password:
        raise ValueError("The evaluation proxy must be plain HTTP on loopback.")
    host = parsed.hostname or ""
    if host != "localhost" and not ipaddress.ip_address(host).is_loopback:
        raise ValueError("The evaluation proxy must use a loopback host.")
    if not parsed.port:
        raise ValueError("The evaluation proxy must specify its local port.")
    return value.rstrip("/")


def isolated_path(raw: str, *, must_exist: bool = False) -> Path:
    path = Path(raw).resolve()
    if not path.is_relative_to(Path("/private/tmp")):
        raise ValueError("Evaluation source, workspace, and state must be in /private/tmp.")
    if must_exist and not path.is_dir():
        raise ValueError(f"Missing evaluation directory: {path}")
    return path


def install_isolation(allowed_ports: set[int], denied: list[dict[str, str]]) -> None:
    """Keep Python I/O local without replacing any harness behavior."""
    keep = {"PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "SYSTEMROOT"}
    for name in list(os.environ):
        if name not in keep:
            del os.environ[name]

    def audit(event: str, args: tuple[Any, ...]) -> None:
        if event == "subprocess.Popen" or event == "os.system":
            denied.append({"event": event, "target": Path(str(args[0])).name})
            raise PermissionError("Subprocesses are disabled in this shared-tool evaluation.")
        if event == "socket.getaddrinfo":
            host = args[0]
            if host not in {"localhost", "127.0.0.1", "::1", None}:
                denied.append({"event": event, "target": str(host)})
                raise PermissionError("External DNS is disabled in this evaluation.")
        if event == "socket.connect":
            address = args[1]
            if not isinstance(address, tuple) or len(address) < 2:
                denied.append({"event": event, "target": "non-IP socket"})
                raise PermissionError("Only the evaluation proxy may be contacted.")
            host, port = address[:2]
            try:
                permitted = ipaddress.ip_address(host).is_loopback and port in allowed_ports
            except ValueError:
                permitted = False
            if not permitted:
                denied.append({"event": event, "target": f"{host}:{port}"})
                raise PermissionError("Only the evaluation proxy may be contacted.")

    sys.addaudithook(audit)


def request_json(url: str, body: dict[str, Any] | None = None) -> Any:
    encoded = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=encoded,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {LOCAL_TOKEN}"},
        method="GET" if body is None else "POST",
    )
    # Never inherit system proxy configuration for the localhost boundary.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=30) as response:
        return json.loads(response.read())


def register_common_tools(schemas: list[dict[str, Any]], tool_base: str, events: list) -> None:
    from tools.registry import registry

    names = set()
    for item in schemas:
        schema = item.get("function", item)
        name = schema["name"]
        if name not in COMMON_TOOL_NAMES or name in names:
            raise ValueError(f"Unexpected or duplicate shared task tool: {name}")
        names.add(name)

        def handler(arguments: dict[str, Any], *, _name: str = name, **_context: Any) -> str:
            started = time.monotonic()
            result = request_json(f"{tool_base}/tools/{_name}", arguments)
            events.append({"name": _name, "arguments": arguments, "result": result,
                           "wall_seconds": time.monotonic() - started})
            return result if isinstance(result, str) else json.dumps(result, ensure_ascii=False)

        registry.register(
            name=name,
            toolset="atlas-evaluation-shared",
            schema=schema,
            handler=handler,
            override=True,
        )
    if names != COMMON_TOOL_NAMES:
        raise ValueError(f"Missing shared tools: {sorted(COMMON_TOOL_NAMES - names)}")


def run(payload: dict[str, Any]) -> dict[str, Any]:
    started = time.monotonic()
    source = isolated_path(str(payload.get("source", EVALUATION_ROOT / "source")), must_exist=True)
    workspace = isolated_path(payload["workspace"], must_exist=True)
    run_id = str(payload["run_id"])
    if not run_id or any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for char in run_id):
        raise ValueError("run_id must contain only letters, numbers, hyphens, and underscores.")
    state = isolated_path(str(payload.get("hermes_home", EVALUATION_ROOT / "runs" / run_id)))
    if (state / "config.yaml").exists():
        raise ValueError("Use a fresh run_id/hermes_home; evaluation state already exists.")
    state.mkdir(parents=True, exist_ok=True)
    base_url = local_url(payload["base_url"])
    tool_base = local_url(payload.get("tool_base_url", base_url.removesuffix("/v1")))
    schema_url = local_url(payload.get("tool_schema_url", tool_base + "/tool-schemas"))
    denied: list[dict[str, str]] = []
    install_isolation({urllib.parse.urlparse(url).port for url in (base_url, tool_base, schema_url)}, denied)
    os.environ["HERMES_HOME"] = str(state)
    os.environ["TERMINAL_CWD"] = str(workspace)
    os.environ["OPENAI_API_KEY"] = LOCAL_TOKEN
    os.environ["OPENAI_BASE_URL"] = base_url
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    sys.dont_write_bytecode = True
    os.environ["NO_COLOR"] = "1"
    os.chdir(workspace)
    sys.path.insert(0, str(source))

    import yaml

    model_settings: dict[str, Any] = {
        "provider": "custom", "default": payload["model"], "base_url": base_url,
    }
    if payload.get("context_length") is not None:
        model_settings["context_length"] = int(payload["context_length"])
    if payload.get("streaming") is not None:
        model_settings["streaming"] = bool(payload["streaming"])
    cfg = {
        "model": model_settings,
        "memory": {"memory_enabled": True, "user_profile_enabled": True},
        "auxiliary": {"background_review": {"enabled": False}},
        "security": {"allow_lazy_installs": False},
        "display": {"quiet": True},
        "curator": {"enabled": False},
        "mcp_servers": {},
    }
    (state / "config.yaml").write_text(yaml.safe_dump(cfg), encoding="utf-8")

    from run_agent import AIAgent

    events: list[dict[str, Any]] = []
    schemas = payload.get("tool_schemas") or request_json(schema_url)
    if isinstance(schemas, dict):
        schemas = schemas.get("tools", schemas.get("schemas"))
    if not isinstance(schemas, list):
        raise ValueError("Tool schema response must be a list of OpenAI function schemas.")
    register_common_tools(schemas, tool_base, events)
    toolsets = ["atlas-evaluation-shared", "memory", "todo"]
    agent = AIAgent(
        model=payload["model"], provider="custom", api_mode="chat_completions",
        api_key=LOCAL_TOKEN, base_url=base_url,
        max_iterations=int(payload.get("max_iterations", 12)),
        max_tokens=int(payload.get("max_tokens", 4096)),
        request_overrides={"temperature": float(payload.get("temperature", 0.2))},
        run_budget_seconds=float(payload.get("timeout_seconds", 180)),
        enabled_toolsets=toolsets, quiet_mode=True, save_trajectories=False,
        skip_context_files=True, skip_memory=False, skip_background_review=True,
        session_id=f"atlas-eval-{run_id}",
    )
    from model_tools import get_tool_definitions

    expanded_catalog = get_tool_definitions(toolsets, quiet_mode=True, skip_tool_search_assembly=True)
    output: dict[str, Any] = {
        "harness": "hermes", "hermes_commit": HERMES_COMMIT, "run_id": run_id,
        "model": payload["model"], "workspace": str(workspace), "hermes_home": str(state),
        "tool_catalog": agent.tools, "expanded_tool_catalog": expanded_catalog, "shared_tool_events": events,
        "configuration": cfg, "initial_context_length": agent.context_compressor.context_length,
        "declared_deviations": [
            "Only shared task capabilities plus intrinsic Hermes memory and todo tools are enabled.",
            "Shared external tools use the evaluation HTTP service through the stock tool registry.",
            "Fresh isolated HERMES_HOME; host environment, project context files, external memory integrations absent.",
            "Background skill/memory review and curator disabled for the controlled single-task comparison.",
            "No subprocesses, external DNS, or Python sockets outside the declared proxy ports.",
            "Explicit per-run iteration, output-token, and wall-clock limits; caller owns aggregate proxy budget.",
            "Production system prompt and conversation loop remain unchanged.",
        ],
    }
    try:
        if payload.get("probe"):
            output["probe"] = True
        else:
            turns = payload.get("turns", [payload.get("prompt", "")])
            if not isinstance(turns, list) or not turns or not all(isinstance(turn, str) and turn for turn in turns):
                raise ValueError("Supply a nonempty prompt or nonempty turns array of strings.")
            output["turn_results"] = []
            history = None
            for turn in turns:
                result = agent.run_conversation(turn, conversation_history=history)
                output["turn_results"].append(result)
                output["result"] = result
                history = result.get("messages")
                if result.get("failed") or result.get("interrupted") or not result.get("completed"):
                    break
            output["requested_turns"] = len(turns)
            output["completed_turns"] = sum(bool(result.get("completed")) for result in output["turn_results"])
        prompt = str(getattr(agent, "_cached_system_prompt", "") or "")
        output["system_prompt_sha256"] = hashlib.sha256(prompt.encode()).hexdigest() if prompt else None
    except Exception as exc:
        output["runner_error"] = f"{type(exc).__name__}: {exc}"
        traceback.print_exc(file=sys.stderr)
    finally:
        output["usage"] = {
            name: getattr(agent, f"session_{name}", None)
            for name in ("prompt_tokens", "completion_tokens", "total_tokens", "input_tokens", "output_tokens",
                         "cache_read_tokens", "cache_write_tokens", "reasoning_tokens", "api_calls",
                         "estimated_cost_usd", "cost_status", "cost_source")
        }
        try:
            agent.close()
        except Exception as exc:
            output["close_error"] = f"{type(exc).__name__}: {exc}"
        output["context_resolution"] = {
            "resolved": agent.context_compressor.context_length,
            "configured": payload.get("context_length"),
            "policy": "Unmodified Hermes resolver: endpoint probes then model-name catalog and fallback when metadata is absent.",
            "source_log": str(state / "logs" / "agent.log"),
            "provider_advertised_context_unknown": payload.get("context_length") is None,
        }
        try:
            context_log = (state / "logs" / "agent.log").read_text(encoding="utf-8")
            output["context_resolution"]["source_log_excerpt"] = [
                line for line in context_log.splitlines()
                if "context length" in line or "context_length" in line
            ][-10:]
        except OSError:
            pass
        output["denied_io"] = denied
        output["wall_seconds"] = time.monotonic() - started
    return output


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        with contextlib.redirect_stdout(sys.stderr):
            output = run(payload)
        exit_code = 0
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        output = {"harness": "hermes", "hermes_commit": HERMES_COMMIT,
                  "setup_or_runner_error": f"{type(exc).__name__}: {exc}"}
        exit_code = 1
    sys.__stdout__.write(json.dumps(output, ensure_ascii=False, default=str) + "\n")
    sys.__stdout__.flush()
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
