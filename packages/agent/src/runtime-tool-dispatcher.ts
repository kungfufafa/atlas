import {
  computeActionHash,
  type GenerateChatInput,
  type ProviderToolExecutionResult,
  type ToolCall,
} from "@atlas/core";
import { validateToolCallIds } from "./tool-progress";

/** One provider turn may ask for tools while its completion is still pending. */
export function createRuntimeToolDispatcher(options: {
  execute: NonNullable<GenerateChatInput["executeToolCall"]>;
  signal?: AbortSignal;
}) {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const receipts = new Map<
    string,
    { hash: string; result: Promise<ProviderToolExecutionResult> }
  >();
  let queue = Promise.resolve();
  let closed = false;
  let failure: unknown;

  const execute: NonNullable<GenerateChatInput["executeToolCall"]> = (
    input,
    runtimeSignal
  ) => {
    try {
      if (closed) {
        throw new Error("The provider tool dispatch window is closed.");
      }
      signal.throwIfAborted();
      validateToolCallIds([input]);
      if (
        typeof input.name !== "string" ||
        !input.name.trim() ||
        !input.arguments ||
        typeof input.arguments !== "object" ||
        Array.isArray(input.arguments)
      ) {
        throw new Error("The provider returned an invalid tool request.");
      }
      const call: ToolCall = structuredClone(input);
      const hash = computeActionHash({ args: call.arguments, tool: call.name });
      const existing = receipts.get(call.id);
      if (existing) {
        if (existing.hash !== hash) {
          throw new Error(
            "A provider tool call ID was reused with different arguments."
          );
        }
        return existing.result;
      }
      const callSignal = runtimeSignal
        ? AbortSignal.any([signal, runtimeSignal])
        : signal;
      const result = queue.then(async () => {
        if (failure !== undefined) {
          throw failure;
        }
        callSignal.throwIfAborted();
        return await options.execute(call, callSignal);
      });
      queue = result.then(
        () => undefined,
        (error: unknown) => {
          failure ??= error;
        }
      );
      receipts.set(call.id, { hash, result });
      return result;
    } catch (error) {
      failure ??= error;
      const rejected = Promise.reject<ProviderToolExecutionResult>(error);
      void rejected.catch(() => undefined);
      return rejected;
    }
  };

  return {
    close(reason?: unknown) {
      closed = true;
      if (reason !== undefined) {
        controller.abort(reason);
      }
    },
    execute,
    async settle() {
      await queue;
      if (failure !== undefined) {
        throw failure;
      }
    },
  };
}
