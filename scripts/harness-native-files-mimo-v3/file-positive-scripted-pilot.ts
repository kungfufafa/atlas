import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { filePython, runFileBatch } from "./file-run";

// Exact Python payloads retained from the previously bound offline native pilot.
const reconciliation = `from pathlib import Path
from decimal import Decimal
from openpyxl import load_workbook, Workbook
wb = load_workbook('input/invoices.xlsx', data_only=False)
rows = list(wb['Transactions'].values)
totals = {}
count = 0
for invoice, vendor, kind, status, amount in rows[1:]:
 totals.setdefault(vendor, 0)
 if status == 'settled':
  totals[vendor] += int(Decimal(amount) * 100) * (-1 if kind == 'refund' else 1)
  count += 1
out = Workbook()
summary = out.active
summary.title = 'Summary'
summary.append(['vendor', 'net_cents'])
for vendor in sorted(totals):
 summary.append([vendor, totals[vendor]])
summary.append(['TOTAL', sum(totals.values())])
audit = out.create_sheet('Audit')
audit.append(['metric', 'value'])
audit.append(['settled_count', count])
Path('artifacts').mkdir(exist_ok=True)
out.save('artifacts/reconciliation.xlsx')
print('created artifacts/reconciliation.xlsx')`;
const joined = `import csv
from pathlib import Path
with open('input/customers.csv', newline='') as source:
 customers = {row['customer_id']: row['customer_name'] for row in csv.DictReader(source)}
with open('input/orders.csv', newline='') as source:
 orders = list(csv.DictReader(source))
Path('artifacts').mkdir(exist_ok=True)
with open('artifacts/joined.csv', 'w', newline='', encoding='utf-8') as output:
 writer = csv.writer(output)
 writer.writerow(['order_id', 'customer_id', 'total_cents', 'customer_name'])
 for row in orders:
  writer.writerow([row['order_id'], row['customer_id'], row['total_cents'], customers.get(row['customer_id'], '')])
print('created artifacts/joined.csv')`;

interface ToolCall {
  function: { name: string };
}
interface Message {
  content?: unknown;
  role: string;
  tool_calls?: ToolCall[];
}
interface RequestBody {
  messages: Message[];
  model: string;
  tools?: ToolCall[];
}
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** Explicit offline driver: no real upstream fetch exists in this path. */
export async function runPositiveScriptedFilePilot(
  parent: string
): Promise<string> {
  const root = await mkdtemp(join(parent, "native-positive-"));
  const keyFile = join(root, "synthetic-offline-token");
  await writeFile(keyFile, "offline-scripted-token-not-a-provider-credential", {
    flag: "wx",
    mode: 0o600,
  });
  let requestIndex = 0;
  const requests: unknown[] = [];
  const fetchUpstream = async (
    _url: string,
    init: RequestInit
  ): Promise<Response> => {
    if (
      new Headers(init.headers).get("user-agent") !==
      "Atlas-Hermes-Compatibility-Probe/1.0 (nonstreaming)"
    ) {
      throw new Error("Unexpected probe User-Agent");
    }
    const body = JSON.parse(String(init.body)) as RequestBody;
    if (body.model !== "mimo-v2.5") {
      throw new Error("Unexpected scripted model");
    }
    requests.push(body);
    requestIndex += 1;
    const names = new Set((body.tools ?? []).map((tool) => tool.function.name));
    const invoiceTask = body.messages.some(
      (message) =>
        message.role === "user" &&
        typeof message.content === "string" &&
        message.content.includes("input/invoices.xlsx")
    );
    const code = invoiceTask ? reconciliation : joined;
    const done = body.messages.some(
      (message) =>
        message.role === "assistant" &&
        (message.tool_calls ?? []).some((tool) =>
          ["python_execute", "terminal"].includes(tool.function.name)
        )
    );
    let tool: { name: string; arguments: string } | null = null;
    if (names.size && !done) {
      if (names.has("python_execute")) {
        tool = {
          arguments: JSON.stringify({ code, timeout: 30_000 }),
          name: "python_execute",
        };
      } else if (names.has("terminal")) {
        tool = {
          arguments: JSON.stringify({
            command: [filePython, "-I", "-c", code].map(quote).join(" "),
            timeout: 30,
          }),
          name: "terminal",
        };
      } else {
        tool = {
          arguments: JSON.stringify({ query: "terminal" }),
          name: "tool_search",
        };
      }
    }
    const path = invoiceTask
      ? "artifacts/reconciliation.xlsx"
      : "artifacts/joined.csv";
    const delivered = invoiceTask
      ? `[Result](${path})`
      : `Saved file: \`${path}\`\n\n\`\`\`csv\norder_id,customer_id,total_cents,customer_name\n\`\`\`\n\n[Result](${path})\n\nFile again: \`${path}\`.`;
    const message = tool
      ? {
          content: "",
          role: "assistant",
          tool_calls: [
            { function: tool, id: `offline-${requestIndex}`, type: "function" },
          ],
        }
      : {
          content: names.size ? delivered : "Synthetic native file proof",
          role: "assistant",
        };
    return Response.json({
      choices: [
        { finish_reason: tool ? "tool_calls" : "stop", index: 0, message },
      ],
      id: `offline-${requestIndex}`,
      model: body.model,
      object: "chat.completion",
      usage: {
        completion_tokens: 10,
        prompt_tokens: 20,
        prompt_tokens_details: { cached_tokens: 0 },
        total_tokens: 30,
      },
    });
  };
  try {
    const directory = await runFileBatch({
      candidateLabel: "offline-c9-native-positive-tools-only",
      fetchUpstream,
      keyFile,
      phase: "pilot",
      studyRoot: root,
    });
    await writeFile(
      join(root, "offline-requests.json"),
      JSON.stringify(requests),
      { flag: "wx" }
    );
    await writeFile(
      join(root, "pilot-result.json"),
      JSON.stringify({
        directory,
        paidInference: false,
        requestCount: requests.length,
      }),
      { flag: "wx" }
    );
    process.stdout.write(
      `${JSON.stringify({ directory, offlinePilotRoot: root, requests: requests.length })}\n`
    );
    return directory;
  } catch (error) {
    await writeFile(
      join(root, "offline-requests.json"),
      JSON.stringify(requests),
      { flag: "wx" }
    );
    process.stdout.write(
      `${JSON.stringify({ error: String(error), offlinePilotRoot: root, requests: requests.length })}\n`
    );
    throw error;
  }
}
if (import.meta.main) {
  const parent = process.argv[2];
  if (!parent?.startsWith("/private/tmp/")) {
    throw new Error("Provide an existing private offline evidence directory");
  }
  await runPositiveScriptedFilePilot(parent);
}
