"""Explicit offline test producer; never selected by a scored CLI run."""
import csv
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import time
import urllib.request

mode, harness = sys.argv[1:3]
request = json.load(sys.stdin)
root = Path(request["stateRoot"])
(root / "fixture-pid").write_text(str(os.getpid()))
if mode == "empty":
    sys.exit(0)
if mode == "broken":
    print("{broken")
    sys.exit(0)
if mode == "partial":
    print('{"framework":', end="", flush=True)
    sys.exit(0)
if mode == "timeout":
    print('{"framework":', end="", flush=True)
    time.sleep(60)
    sys.exit(0)
source = Path(request["sourceDirectory"])
workspace = root / "workspace"
shutil.copytree(source, workspace)
workspace.chmod(0o700)
(workspace / "artifacts").mkdir()
with (workspace / "input/customers.csv").open(newline="") as stream:
    customers = {r["customer_id"]: r["customer_name"] for r in csv.DictReader(stream)}
with (workspace / "input/orders.csv").open(newline="") as stream:
    orders = list(csv.DictReader(stream))
with (workspace / "artifacts/joined.csv").open("w", newline="") as stream:
    writer = csv.writer(stream)
    writer.writerow(["order_id", "customer_id", "total_cents", "customer_name"])
    for row in orders:
        writer.writerow([row["order_id"], row["customer_id"], row["total_cents"], customers.get(row["customer_id"], "")])
body = json.dumps({"messages": [{"role": "user", "content": "Explicit offline fixture"}], "model": request["model"], "stream": False}).encode()
http = urllib.request.Request(request["proxyBaseUrl"] + "/runs/" + request["runId"] + "/v1/chat/completions", data=body, headers={"Content-Type": "application/json"})
with urllib.request.urlopen(http, timeout=3) as response:
    response.read()
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
output = {
    "runId": request["runId"], "framework": harness, "status": "completed",
    "finalText": "[joined.csv](artifacts/joined.csv)", "workspaceRoot": str(workspace),
    "sourceCopies": [{"path": str(p.relative_to(source)), "sha256": sha(p)} for p in sorted(source.rglob("*")) if p.is_file()],
    "workspaceFiles": [{"path": str(p.relative_to(workspace)), "sha256": sha(p)} for p in sorted(workspace.rglob("*")) if p.is_file()],
    "nativeEvents": [{"name": "write_file", "result": {"success": True}}],
    "sessions": [{"id": "offline-fixture", "initialHistoryCount": 0, "turns": [{"input": t, "status": "completed"} for t in request["taskTurns"]]}],
    "evidence": {"artifactInspectionAllowed": True, "nativeCleanup": {"completed": True}, "supervisorCleanup": {"completed": True}},
}
if mode == "invalid-metadata":
    output["finalText"] = "No selected output"
    output["artifacts"] = {"bad": "noniterable"}
if mode == "duplicate-source":
    output["sourceCopies"].append(output["sourceCopies"][0])
if mode == "missing-id":
    del output["runId"]
if mode == "foreign-id":
    output["runId"] = "foreign-offline-fixture"
print(json.dumps(output, separators=(",", ":")))
if mode == "nonzero":
    sys.exit(7)
