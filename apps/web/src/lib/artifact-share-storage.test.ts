import { afterEach, describe, expect, test } from "bun:test";
import {
  artifactShareStorageKey,
  readStoredArtifactShare,
  readStoredArtifactShareIfActive,
  writeStoredArtifactShare,
} from "./artifact-share-storage";

const input = {
  artifactPath: "notes.md",
  orgId: "org_1",
  profileId: "profile_1",
};

function installMemoryLocalStorage() {
  const store = new Map<string, string>();
  const previous = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      removeItem: (key: string) => {
        store.delete(key);
      },
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    },
  });
  return () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: previous,
    });
  };
}

describe("readStoredArtifactShareIfActive", () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
  });

  test("clears a cached URL once the server reports the share inactive", () => {
    restore = installMemoryLocalStorage();
    writeStoredArtifactShare({
      ...input,
      shareId: "share_1",
      shareUrl: "http://localhost:3000/s/dead",
    });

    expect(
      readStoredArtifactShareIfActive({ ...input, serverActive: false })
    ).toBeNull();
    expect(readStoredArtifactShare(input)).toBeNull();
    expect(
      globalThis.localStorage.getItem(
        artifactShareStorageKey(
          input.orgId,
          input.profileId,
          input.artifactPath
        )
      )
    ).toBeNull();
  });

  test("keeps the cached URL until status has loaded", () => {
    restore = installMemoryLocalStorage();
    writeStoredArtifactShare({
      ...input,
      shareId: "share_1",
      shareUrl: "http://localhost:3000/s/live",
    });

    expect(
      readStoredArtifactShareIfActive({ ...input, serverActive: null })
    ).toEqual({
      shareId: "share_1",
      shareUrl: "http://localhost:3000/s/live",
    });
  });
});
