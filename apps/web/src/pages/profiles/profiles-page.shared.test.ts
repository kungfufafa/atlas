import { describe, expect, test } from "bun:test";
import {
  flushProfileSave,
  runExclusiveProfileExport,
  runProfileExport,
} from "@/pages/profiles/profiles-page.shared";

describe("flushProfileSave", () => {
  test("waits for an active save and flushes edits exposed by its completion", async () => {
    let completeActiveSave: (() => void) | undefined;
    let pendingEdits = false;
    let saveInProgress = true;
    let performSaveCount = 0;
    const activeSave = new Promise<void>((resolve) => {
      completeActiveSave = resolve;
    });

    const flush = flushProfileSave({
      clearScheduledSave: () => undefined,
      hasPendingEdits: () => pendingEdits,
      isSaving: () => saveInProgress,
      isValid: () => true,
      performSave: async () => {
        performSaveCount += 1;

        if (performSaveCount === 1) {
          await activeSave;
          saveInProgress = false;
          pendingEdits = true;
        } else {
          pendingEdits = false;
        }

        return true;
      },
    });

    await Promise.resolve();
    expect(performSaveCount).toBe(1);

    completeActiveSave?.();

    await expect(flush).resolves.toBe(true);
    expect(performSaveCount).toBe(2);
  });

  test("rejects an invalid draft instead of exporting stored data", async () => {
    let performSaveCount = 0;

    await expect(
      flushProfileSave({
        clearScheduledSave: () => undefined,
        hasPendingEdits: () => false,
        isSaving: () => false,
        isValid: () => false,
        performSave: async () => {
          performSaveCount += 1;
          return true;
        },
      })
    ).resolves.toBe(false);
    expect(performSaveCount).toBe(0);
  });
});

describe("runExclusiveProfileExport", () => {
  test("locks the whole workflow before its first await", async () => {
    let finishExport: (() => void) | undefined;
    let runCount = 0;
    const pendingChanges: boolean[] = [];
    const lock = { current: false };
    const exportGate = new Promise<void>((resolve) => {
      finishExport = resolve;
    });
    const options = {
      lock,
      onPendingChange: (pending: boolean) => pendingChanges.push(pending),
      run: async () => {
        runCount += 1;
        await exportGate;
      },
    };

    const firstExport = runExclusiveProfileExport(options);
    const duplicateExport = runExclusiveProfileExport(options);

    await expect(duplicateExport).resolves.toBe(false);
    expect(lock.current).toBe(true);
    expect(runCount).toBe(1);
    expect(pendingChanges).toEqual([true]);

    finishExport?.();

    await expect(firstExport).resolves.toBe(true);
    expect(lock.current).toBe(false);
    expect(pendingChanges).toEqual([true, false]);
  });
});

describe("runProfileExport", () => {
  test("saves pending edits before requesting and downloading the profile", async () => {
    const events: string[] = [];
    const archiveData = new ArrayBuffer(4);

    const exported = await runProfileExport({
      download: (filename, data) => {
        events.push(`download:${filename}:${data.byteLength}`);
      },
      exportProfile: async (profileId) => {
        events.push(`export:${profileId}`);
        return { data: archiveData, filename: "profile.zip" };
      },
      flushSave: async () => {
        events.push("save");
        return true;
      },
      isCurrentProfile: () => true,
      profileId: "profile-1",
    });

    expect(exported).toBe(true);
    expect(events).toEqual([
      "save",
      "export:profile-1",
      "download:profile.zip:4",
    ]);
  });

  test("does not export after a failed save or profile switch", async () => {
    let exportCount = 0;
    const exportProfile = async () => {
      exportCount += 1;
      return { data: new ArrayBuffer(0), filename: "profile.zip" };
    };
    const download = () => undefined;

    await expect(
      runProfileExport({
        download,
        exportProfile,
        flushSave: () => Promise.resolve(false),
        isCurrentProfile: () => true,
        profileId: "profile-1",
      })
    ).resolves.toBe(false);
    await expect(
      runProfileExport({
        download,
        exportProfile,
        flushSave: () => Promise.resolve(true),
        isCurrentProfile: () => false,
        profileId: "profile-1",
      })
    ).resolves.toBe(false);
    expect(exportCount).toBe(0);
  });
});
