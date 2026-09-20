import { describe, expect, test } from "bun:test";
import {
  DEFAULT_OPENCODE_GO_SESSION_ID,
  OPENCODE_GO_SESSION_HEADER,
  resolveOpenCodeGoSessionId,
  runWithOpenCodeGoSession,
  wrapFetchWithOpenCodeGoSession,
} from "./session";

describe("resolveOpenCodeGoSessionId", () => {
  test("prefers the Atlas conversation id", () => {
    expect(
      resolveOpenCodeGoSessionId({
        conversationId: "sess_abc",
        providerInstanceId: "ignored",
      })
    ).toBe("sess_abc");
  });

  test("falls back to a stable provider-instance session", () => {
    expect(
      resolveOpenCodeGoSessionId({ providerInstanceId: "harness-eval" })
    ).toBe("atlas-opencode-go-harness-eval");
  });

  test("uses the default id when nothing is supplied", () => {
    expect(resolveOpenCodeGoSessionId()).toBe(DEFAULT_OPENCODE_GO_SESSION_ID);
  });

  test("strips characters the gateway would not treat as a session id", () => {
    expect(
      resolveOpenCodeGoSessionId({ conversationId: "sess/abc space" })
    ).toBe("sess-abc-space");
  });
});

describe("wrapFetchWithOpenCodeGoSession", () => {
  test("injects the fallback session header", async () => {
    let captured: string | null = null;
    const wrapped = wrapFetchWithOpenCodeGoSession("atlas-eval", ((
      _input,
      init
    ) => {
      captured = new Headers(init?.headers).get(OPENCODE_GO_SESSION_HEADER);
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch);

    await wrapped("https://example.test/chat/completions", { method: "POST" });
    expect(captured).toBe("atlas-eval");
  });

  test("overrides the fallback with the active conversation session", async () => {
    let captured: string | null = null;
    const wrapped = wrapFetchWithOpenCodeGoSession("atlas-eval", ((
      _input,
      init
    ) => {
      captured = new Headers(init?.headers).get(OPENCODE_GO_SESSION_HEADER);
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch);

    await runWithOpenCodeGoSession("sess_live", () =>
      wrapped("https://example.test/chat/completions")
    );
    expect(captured).toBe("sess_live");
  });
});
