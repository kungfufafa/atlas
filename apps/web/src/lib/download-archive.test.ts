import { describe, expect, test } from "bun:test";
import { scheduleArchiveDownloadCleanup } from "@/lib/download-archive";

describe("scheduleArchiveDownloadCleanup", () => {
  test("keeps the anchor and object URL alive until the browser consumes the download", () => {
    let scheduledCallback: (() => void) | undefined;
    let scheduledDelay: number | undefined;
    let anchorRemoved = false;
    const revokedUrls: string[] = [];

    scheduleArchiveDownloadCleanup(
      "blob:profile-pack",
      (callback, delayMs) => {
        scheduledCallback = callback;
        scheduledDelay = delayMs;
      },
      (url) => revokedUrls.push(url),
      () => {
        anchorRemoved = true;
      }
    );

    expect(anchorRemoved).toBe(false);
    expect(revokedUrls).toEqual([]);
    expect(scheduledDelay).toBeGreaterThan(0);

    scheduledCallback?.();

    expect(anchorRemoved).toBe(true);
    expect(revokedUrls).toEqual(["blob:profile-pack"]);
  });
});
