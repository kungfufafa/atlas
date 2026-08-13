import type { ToolDetail } from "@atlas/core/contract";
import { useState } from "react";
import { useAppNavigation } from "@/hooks/use-app-navigation";
import { client, formatError } from "@/lib/client";
import { buildSuperAgentFixDraft } from "@/lib/tool-playground-draft";
import { buildExampleParametersJson } from "@/lib/tool-playground-params";

export type ToolPlaygroundRunState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "success"; result: unknown; parameters: Record<string, unknown> }
  | { status: "error"; error: string; parameters: Record<string, unknown> };

export interface ToolPlaygroundRunControls {
  actionError: string | null;
  assistPrompt: string;
  handleAssist: () => Promise<void>;
  handleFixWithSuperAgent: () => void;
  handleReset: () => void;
  handleRun: () => Promise<void>;
  jsonError: string | null;
  parametersJson: string;
  running: boolean;
  runState: ToolPlaygroundRunState;
  setAssistPrompt: (value: string) => void;
  setParametersJson: (value: string) => void;
  suggesting: boolean;
}

function parseParametersJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }

  return null;
}

export function useToolPlaygroundRun(
  tool: ToolDetail,
  superAgentProfileId: string | null
): ToolPlaygroundRunControls {
  const { navigateToNewChat } = useAppNavigation();
  const [parametersJson, setParametersJsonState] = useState(() =>
    buildExampleParametersJson(tool.parameters)
  );
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [assistPrompt, setAssistPrompt] = useState("");
  const [suggesting, setSuggesting] = useState(false);
  const [runState, setRunState] = useState<ToolPlaygroundRunState>({
    status: "idle",
  });
  const [actionError, setActionError] = useState<string | null>(null);

  const running = runState.status === "running";

  async function handleRun() {
    setActionError(null);
    const parsed = parseParametersJson(parametersJson);

    if (!parsed) {
      setJsonError("Invalid JSON object");
      return;
    }

    setJsonError(null);
    setRunState({ status: "running" });

    try {
      const response = await client.runToolPlayground(tool.id, parsed);

      if (response.error) {
        setRunState({
          error: response.error,
          parameters: parsed,
          status: "error",
        });
      } else {
        setRunState({
          parameters: parsed,
          result: response.result,
          status: "success",
        });
      }
    } catch (error) {
      setRunState({
        error: formatError(error),
        parameters: parsed,
        status: "error",
      });
    }
  }

  function handleReset() {
    setActionError(null);
    setJsonError(null);
    setRunState({ status: "idle" });
    setParametersJsonState(buildExampleParametersJson(tool.parameters));
  }

  async function handleAssist() {
    if (!assistPrompt.trim()) {
      return;
    }

    setActionError(null);
    setSuggesting(true);

    try {
      const response = await client.suggestToolPlaygroundParams(
        tool.id,
        assistPrompt.trim()
      );
      setParametersJsonState(JSON.stringify(response.parameters, null, 2));
      setJsonError(null);
    } catch (error) {
      setActionError(formatError(error));
    } finally {
      setSuggesting(false);
    }
  }

  function handleFixWithSuperAgent() {
    if (runState.status !== "error" || !superAgentProfileId) {
      return;
    }

    const draft = buildSuperAgentFixDraft({
      error: runState.error,
      parameters: runState.parameters,
      toolName: tool.name,
    });

    navigateToNewChat(superAgentProfileId, { draft });
  }

  function setParametersJson(value: string) {
    setParametersJsonState(value);
    setJsonError(null);
  }

  return {
    actionError,
    assistPrompt,
    handleAssist,
    handleFixWithSuperAgent,
    handleReset,
    handleRun,
    jsonError,
    parametersJson,
    running,
    runState,
    setAssistPrompt,
    setParametersJson,
    suggesting,
  };
}

export function formatToolPlaygroundResult(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
