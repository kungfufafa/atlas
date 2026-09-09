#!/usr/bin/env python3
"""Run one registered Hermes cell against OpenCode Go. Key from env only."""

from __future__ import annotations

import json
import os
import sys
import time
import traceback
from pathlib import Path


def redact(value: str, key: str) -> str:
    out = value
    if key:
        out = out.replace(key, "[REDACTED_KEY]")
    return out


def classify_hermes_reply(reply: object) -> dict[str, object]:
    if isinstance(reply, dict):
        payload = reply
        text = str(reply.get("final_response") or reply)
    else:
        text = str(reply)
        payload = None
        stripped = text.strip()
        if stripped.startswith("{") and stripped.endswith("}"):
            try:
                parsed = json.loads(stripped.replace("'", '"'))
            except json.JSONDecodeError:
                parsed = None
            if isinstance(parsed, dict):
                payload = parsed
                text = str(parsed.get("final_response") or text)

    blob = str(payload if payload is not None else text)
    failed = bool(payload.get("failed")) if isinstance(payload, dict) else False
    error = str(payload.get("error") or "") if isinstance(payload, dict) else ""
    auth_fail = (
        failed
        or "401" in blob
        or "Invalid API key" in blob
        or "AuthError" in blob
        or "401" in error
    )
    if auth_fail:
        return {"class": "auth", "ok": False, "reply": text}
    if not str(text).strip():
        return {"class": "empty", "ok": False, "reply": text}
    return {"class": "ok", "ok": True, "reply": text}


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: run-hermes-cell.py <request.json>", file=sys.stderr)
        return 2

    request_path = Path(sys.argv[1])
    request = json.loads(request_path.read_text())
    key = os.environ.get("OPENCODE_GO_API_KEY", "").strip()
    if not key:
        Path(request["resultPath"]).write_text(
            json.dumps(
                {
                    "class": "infra",
                    "error": "OPENCODE_GO_API_KEY missing",
                    "ok": False,
                },
                indent=2,
            )
            + "\n"
        )
        return 78

    hermes_root = Path(request["hermesRoot"])
    sys.path.insert(0, str(hermes_root))
    os.environ["HERMES_HOME"] = request["hermesHome"]
    Path(request["hermesHome"]).mkdir(parents=True, exist_ok=True)

    started = time.time()
    try:
        from run_agent import AIAgent
    except Exception as exc:
        Path(request["resultPath"]).write_text(
            json.dumps(
                {
                    "class": "infra",
                    "error": redact(f"hermes_import_failed: {exc}", key),
                    "ok": False,
                    "traceback": redact(traceback.format_exc(), key),
                },
                indent=2,
            )
            + "\n"
        )
        return 78

    try:
        agent = AIAgent(
            api_key=key,
            base_url=request["baseUrl"],
            model=request["apiId"],
            provider="custom",
        )
        reply = agent.run_conversation(request["prompt"])
        elapsed_ms = int((time.time() - started) * 1000)
        classified = classify_hermes_reply(reply)
        Path(request["resultPath"]).write_text(
            json.dumps(
                {
                    "class": classified["class"],
                    "elapsedMs": elapsed_ms,
                    "ok": classified["ok"],
                    "reply": redact(classified["reply"], key)[:8000],
                },
                indent=2,
            )
            + "\n"
        )
        return 0 if classified["ok"] else 1
    except Exception as exc:
        elapsed_ms = int((time.time() - started) * 1000)
        message = redact(str(exc), key)
        reserved = "web_search" in message or "search_files" in message
        Path(request["resultPath"]).write_text(
            json.dumps(
                {
                    "class": "infra" if reserved else "agent",
                    "elapsedMs": elapsed_ms,
                    "error": message,
                    "ok": False,
                    "reservedTool": reserved,
                    "traceback": redact(traceback.format_exc(), key),
                },
                indent=2,
            )
            + "\n"
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
