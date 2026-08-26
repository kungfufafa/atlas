import { describe, expect, test } from "bun:test";
import {
  advanceCredentialRevision,
  resolveRemoteModelBrowseReadiness,
} from "./remote-models-browse.shared";

describe("remote discovery credential identity", () => {
  test("changes the non-secret revision whenever a credential changes", () => {
    expect(
      advanceCredentialRevision({
        currentCredential: "minimax-key",
        nextCredential: "minimax-key",
        revision: 2,
      })
    ).toBe(2);
    expect(
      advanceCredentialRevision({
        currentCredential: "minimax-key",
        nextCredential: "xai-key",
        revision: 2,
      })
    ).toBe(3);
  });

  test("keeps credential identity unique across browser unmounts", () => {
    const revisionWithKeyA = advanceCredentialRevision({
      currentCredential: "",
      nextCredential: "key-a",
      revision: 0,
    });
    const revisionWithKeyB = advanceCredentialRevision({
      currentCredential: "key-a",
      nextCredential: "key-b",
      revision: revisionWithKeyA,
    });

    expect(revisionWithKeyA).toBe(1);
    expect(revisionWithKeyB).toBe(2);
  });
});

describe("resolveRemoteModelBrowseReadiness", () => {
  test("waits for a key before discovering direct provider models", () => {
    expect(
      resolveRemoteModelBrowseReadiness({
        baseUrl: "https://api.x.ai/v1",
        provider: "xai",
      })
    ).toEqual({
      canFetch: false,
      idleMessage: "Enter an API key before browsing models.",
    });
    expect(
      resolveRemoteModelBrowseReadiness({
        apiKey: "xai-key",
        baseUrl: "https://api.x.ai/v1",
        provider: "xai",
      }).canFetch
    ).toBe(true);
  });

  test("keeps optional-key endpoints and stored providers browseable", () => {
    expect(
      resolveRemoteModelBrowseReadiness({
        baseUrl: "http://localhost:11434/v1",
        provider: "ollama",
      }).canFetch
    ).toBe(true);
    expect(
      resolveRemoteModelBrowseReadiness({
        baseUrl: "http://localhost:1234/v1",
        provider: "openai_compatible",
      }).canFetch
    ).toBe(true);
    expect(
      resolveRemoteModelBrowseReadiness({
        provider: "zhipu",
        providerId: "stored-zhipu",
      }).canFetch
    ).toBe(true);
  });
});
