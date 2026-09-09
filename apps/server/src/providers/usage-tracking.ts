import type {
  ChatCompletionResult,
  ChatMessage,
  GenerateChatInput,
  GenerateTextInput,
  GenerateTextResult,
  LlmToolDefinition,
  ProviderClient,
  StreamChatHandlers,
} from "@atlas/core";
import { estimateUserContentTokens } from "@atlas/core";
import type {
  LlmInvocationUsage,
  LlmUsageTracker,
} from "../services/llm-usage-tracker";
import { reportedProviderFailureUsage } from "./failure-evidence";
import type { PricingContext } from "./pricing";

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export type ToolTokenEstimate = {
  name: string;
  chars: number;
  tokens: number;
  descriptionChars: number;
  parametersChars: number;
};

export type SystemSectionEstimate = {
  title: string;
  chars: number;
  tokens: number;
};

export type ChatTokenEstimateBreakdown = {
  systemChars: number;
  systemTokens: number;
  systemSections: SystemSectionEstimate[];
  toolsChars: number;
  toolsTokens: number;
  toolsCount: number;
  toolsBySize: ToolTokenEstimate[];
  messagesTokens: number;
  messageCount: number;
  messagesByRole: {
    user: number;
    assistant: number;
    tool: number;
    other: number;
  };
  totalEstimatedInputTokens: number;
};

function estimateMessageTokens(message: ChatMessage): number {
  if (message.role === "user") {
    return estimateUserContentTokens(message.content);
  }

  if (message.role === "assistant") {
    let total = estimateTokens(message.content);

    if (message.toolCalls?.length) {
      total += estimateTokens(JSON.stringify(message.toolCalls));
    }

    if (message.thinking) {
      total += estimateTokens(message.thinking);
    }

    return total;
  }

  return estimateTokens(message.content);
}

export function estimateToolToken(tool: LlmToolDefinition): ToolTokenEstimate {
  const serialized = JSON.stringify(tool);
  const descriptionChars = tool.description.length;
  const parametersChars = JSON.stringify(tool.parameters).length;

  return {
    chars: serialized.length,
    descriptionChars,
    name: tool.name,
    parametersChars,
    tokens: estimateTokens(serialized),
  };
}

/** Split system prompt on markdown `#` headings for a coarse section cost map. */
export function estimateSystemSections(
  system: string
): SystemSectionEstimate[] {
  const lines = system.split("\n");
  const sections: { title: string; body: string[] }[] = [
    { body: [], title: "(preamble)" },
  ];

  for (const line of lines) {
    if (line.startsWith("# ")) {
      sections.push({
        body: [line],
        title: line.slice(2).trim() || "(untitled)",
      });
      continue;
    }

    sections[sections.length - 1]?.body.push(line);
  }

  return sections
    .map((section) => {
      const text = section.body.join("\n").trim();
      if (!text) {
        return null;
      }

      return {
        chars: text.length,
        title: section.title,
        tokens: estimateTokens(text),
      };
    })
    .filter((section): section is SystemSectionEstimate => section !== null)
    .sort(
      (left, right) =>
        right.tokens - left.tokens || left.title.localeCompare(right.title)
    );
}

export function estimateChatInputBreakdown(
  input: GenerateChatInput
): ChatTokenEstimateBreakdown {
  const systemChars = input.system.length;
  const systemTokens = estimateTokens(input.system);
  const systemSections = estimateSystemSections(input.system);
  const toolsBySize = (input.tools ?? [])
    .map(estimateToolToken)
    .sort(
      (left, right) =>
        right.tokens - left.tokens || left.name.localeCompare(right.name)
    );
  const toolsJson = input.tools?.length ? JSON.stringify(input.tools) : "";
  const toolsChars = toolsJson.length;
  const toolsTokens = toolsChars > 0 ? estimateTokens(toolsJson) : 0;
  const toolsCount = input.tools?.length ?? 0;

  const messagesByRole = {
    assistant: 0,
    other: 0,
    tool: 0,
    user: 0,
  };
  let messagesTokens = 0;

  for (const message of input.messages) {
    messagesTokens += estimateMessageTokens(message);

    if (message.role === "user") {
      messagesByRole.user += 1;
    } else if (message.role === "assistant") {
      messagesByRole.assistant += 1;
    } else if (message.role === "tool") {
      messagesByRole.tool += 1;
    } else {
      messagesByRole.other += 1;
    }
  }

  return {
    messageCount: input.messages.length,
    messagesByRole,
    messagesTokens,
    systemChars,
    systemSections,
    systemTokens,
    toolsBySize,
    toolsChars,
    toolsCount,
    toolsTokens,
    totalEstimatedInputTokens: systemTokens + toolsTokens + messagesTokens,
  };
}

function estimateChatInputTokens(input: GenerateChatInput): number {
  return estimateChatInputBreakdown(input).totalEstimatedInputTokens;
}

function estimateTextInputTokens(input: GenerateTextInput): number {
  return estimateTokens(`${input.system}\n${input.prompt}`);
}

function estimateChatOutputTokens(result: ChatCompletionResult): number {
  let total = estimateTokens(result.content);

  if (result.toolCalls.length > 0) {
    total += estimateTokens(JSON.stringify(result.toolCalls));
  }

  const thinking = result.assistantMessage.thinking;
  if (thinking) {
    total += estimateTokens(thinking);
  }

  return total;
}

export function wrapProviderWithUsageTracking(
  provider: ProviderClient,
  tracker: LlmUsageTracker,
  modelId: string,
  pricingContext: PricingContext = {}
): ProviderClient {
  async function preserveFailedUsage<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      const usage = reportedProviderFailureUsage(error);
      tracker.recordInvocation(
        modelId,
        usage ? { ...usage, source: "reported" } : { source: "unknown" },
        pricingContext
      );
      throw error;
    }
  }

  function resolveUsage(
    usage: ChatCompletionResult["usage"],
    estimateInput: () => number,
    estimateOutput: () => number
  ): LlmInvocationUsage {
    const valid = (value: number | undefined): value is number =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    const inputTokens = usage?.inputTokens;
    const outputTokens = usage?.outputTokens;
    if (valid(inputTokens) && valid(outputTokens)) {
      return {
        inputTokens,
        outputTokens,
        source: usage?.estimated ? "estimated" : "reported",
      };
    }
    // Visible outer messages cannot describe native runtime-owned context and tools.
    if (provider.managesContext) {
      return { source: "unknown" };
    }
    return {
      inputTokens: valid(inputTokens) ? inputTokens : estimateInput(),
      outputTokens: valid(outputTokens) ? outputTokens : estimateOutput(),
      source: "estimated",
    };
  }

  function withRecordedUsage(
    input: GenerateChatInput,
    result: ChatCompletionResult
  ): ChatCompletionResult {
    const usage = resolveUsage(
      result.usage,
      () => estimateChatInputTokens(input),
      () => estimateChatOutputTokens(result)
    );
    tracker.recordInvocation(modelId, usage, pricingContext);
    if (usage.source === "unknown") {
      return result;
    }
    return {
      ...result,
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.inputTokens + usage.outputTokens,
        ...(usage.source === "estimated" ? { estimated: true } : {}),
      },
    };
  }

  return {
    ...provider,
    async generateChat(
      input: GenerateChatInput
    ): Promise<ChatCompletionResult> {
      const result = await preserveFailedUsage(() =>
        provider.generateChat(input)
      );
      return withRecordedUsage(input, result);
    },
    async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
      const result = await preserveFailedUsage(() =>
        provider.generateText(input)
      );
      tracker.recordInvocation(
        modelId,
        resolveUsage(
          result.usage,
          () => estimateTextInputTokens(input),
          () => estimateTokens(result.content)
        ),
        pricingContext
      );
      return result;
    },
    async streamChat(
      input: GenerateChatInput,
      handlers: StreamChatHandlers
    ): Promise<ChatCompletionResult> {
      const result = await preserveFailedUsage(() =>
        provider.streamChat(input, handlers)
      );
      return withRecordedUsage(input, result);
    },
  };
}
