import { describe, expect, test } from "bun:test";
import {
  withProfileSoulMutationLock,
  withProfileSoulMutationLocks,
} from "./mutation-lock";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

describe("profile soul mutation lock", () => {
  test("serializes the same profile while allowing another profile to proceed", async () => {
    const releaseFirst = deferred();
    const firstStarted = deferred();
    const events: string[] = [];

    const first = withProfileSoulMutationLock(
      "org_lock",
      "profile_a",
      async () => {
        events.push("first:start");
        firstStarted.resolve();
        await releaseFirst.promise;
        events.push("first:end");
      }
    );
    await firstStarted.promise;

    const second = withProfileSoulMutationLock(
      "org_lock",
      "profile_a",
      async () => {
        events.push("second");
      }
    );
    const unrelated = withProfileSoulMutationLock(
      "org_lock",
      "profile_b",
      async () => {
        events.push("unrelated");
      }
    );

    await unrelated;
    expect(events).toEqual(["first:start", "unrelated"]);
    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "unrelated", "first:end", "second"]);
  });

  test("stable multi-profile acquisition cannot deadlock in reverse order", async () => {
    const events: string[] = [];
    const first = withProfileSoulMutationLocks(
      [
        { orgId: "org_multi", profileId: "a" },
        { orgId: "org_multi", profileId: "b" },
      ],
      async () => {
        events.push("first");
      }
    );
    const second = withProfileSoulMutationLocks(
      [
        { orgId: "org_multi", profileId: "b" },
        { orgId: "org_multi", profileId: "a" },
      ],
      async () => {
        events.push("second");
      }
    );

    await Promise.all([first, second]);
    expect(events).toEqual(["first", "second"]);
  });
});
