import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const BROWSER_SCENARIOS = [
  {
    display: "31250",
    id: "calculator",
    prompt: "Calculate (12500 * 17.5) / 7 using the calculator tool.",
  },
  {
    display: "e2e-test.txt",
    id: "text_file",
    prompt: "Create e2e-test.txt containing hello atlas.",
  },
  {
    display: "65536",
    id: "python",
    prompt: "Use python_execute to calculate and print 2**16.",
  },
  {
    display: "sales_report.xlsx",
    id: "spreadsheet",
    prompt: "Create sales_report.xlsx with columns Item, Qty, Price, Total.",
  },
  {
    display: "spreadsheet",
    id: "tool_search",
    prompt: "Use tool_search to find tools for spreadsheet analysis.",
  },
] as const;

export function loadBrowserFixtureConfig(
  env: Record<string, string | undefined>
) {
  const required = (key: string): string => {
    const value = env[key];
    if (!value?.trim()) {
      throw new Error(`Missing fixture prerequisite: ${key}`);
    }
    return value;
  };
  const url = new URL(required("ATLAS_TEST_BASE_URL"));
  if (
    !(url.protocol === "http:" || url.protocol === "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "ATLAS_TEST_BASE_URL must be an HTTP(S) origin without credentials, path, query or fragment."
    );
  }
  const chatPath = required("ATLAS_BROWSER_FIXTURE_CHAT_PATH");
  if (!/^\/chat\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(chatPath)) {
    throw new Error(
      "ATLAS_BROWSER_FIXTURE_CHAT_PATH must identify a prepared /chat/{profileId}/{sessionId} fixture."
    );
  }
  return {
    baseUrl: url.origin,
    chatPath,
    email: required("ATLAS_BROWSER_FIXTURE_EMAIL"),
    orgId: required("ATLAS_BROWSER_FIXTURE_ORG_ID"),
    password: required("ATLAS_BROWSER_FIXTURE_PASSWORD"),
  };
}

export async function createBrowserSmokeOutputDirectory(
  outputRoot?: string
): Promise<string> {
  const root = outputRoot || tmpdir();
  if (!path.isAbsolute(root)) {
    throw new Error(
      "ATLAS_BROWSER_OUTPUT_DIR must be an absolute output directory."
    );
  }
  await mkdir(root, { recursive: true });
  return mkdtemp(path.join(root, "atlas-browser-smoke-"));
}

/** Inputs are assistant markdown nodes only, never document.body or user bubbles. */
export function findNewAssistantDisplay(
  texts: string[],
  previousCount: number,
  expected: string
): string | undefined {
  return texts
    .slice(previousCount)
    .find((text) => text.toLowerCase().includes(expected.toLowerCase()));
}

export function buildBrowserSmokeReport(input: {
  browserErrors: string[];
  completed: string[];
  failure?: string;
  prerequisitesMissing?: boolean;
}) {
  const missing = BROWSER_SCENARIOS.map((scenario) => scenario.id).filter(
    (id) => !input.completed.includes(id)
  );
  const status = input.prerequisitesMissing
    ? "NOT_RUN"
    : input.failure || input.browserErrors.length || missing.length
      ? "FAIL"
      : "UI_SMOKE_PASSED";
  return {
    browserErrors: input.browserErrors,
    completedDisplayObservations: input.completed,
    failure: input.failure,
    fileContentAndFidelity: "NOT_VERIFIED",
    missingScenarios: missing,
    persistedToolExecution: "NOT_VERIFIED",
    providerInference: "NOT_VERIFIED",
    pythonIsolation: "NOT_VERIFIED",
    scope:
      "Fixture login, chat navigation and new assistant text/screenshot observations. Displayed filenames or numbers do not prove tool execution, saved bytes or sandboxing.",
    status,
  };
}
