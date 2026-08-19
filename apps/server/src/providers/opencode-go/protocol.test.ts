import { describe, expect, test } from "bun:test";
import { resolveOpenCodeGoApiKind } from "./protocol";

describe("resolveOpenCodeGoApiKind", () => {
  test("routes MiniMax and Qwen models to the Anthropic messages API", () => {
    expect(resolveOpenCodeGoApiKind("opencode-go/minimax-m3")).toBe("messages");
    expect(resolveOpenCodeGoApiKind("qwen3.8-max")).toBe("messages");
    expect(resolveOpenCodeGoApiKind("opencode-go/qwen3.9-max")).toBe(
      "messages"
    );
  });

  test("routes Grok, GPT, and Muse models to the Responses API", () => {
    expect(resolveOpenCodeGoApiKind("opencode-go/grok-4.5")).toBe("responses");
    expect(resolveOpenCodeGoApiKind("gpt-5.6-luna")).toBe("responses");
    expect(resolveOpenCodeGoApiKind("muse-spark-1.2")).toBe("responses");
  });

  test("routes other coding models to chat completions", () => {
    expect(resolveOpenCodeGoApiKind("opencode-go/kimi-k2.7-code")).toBe("chat");
    expect(resolveOpenCodeGoApiKind("glm-5.3")).toBe("chat");
    expect(resolveOpenCodeGoApiKind("hy3")).toBe("chat");
  });
});
