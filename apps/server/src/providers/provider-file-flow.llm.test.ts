import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type RecordedFileFlow,
  replayRecordedFileFlow,
} from "../testing/recorded-provider-file-flow";

// Replay only. No config/credential discovery, auto-record mode or network
// fallback. The manifest explicitly separates actual failed/unrecorded cases.
const fixtureDirectory = join(
  import.meta.dir,
  "../testing/cassettes/live-provider-proof"
);
const manifest = (await Bun.file(
  join(fixtureDirectory, "manifest.json")
).json()) as {
  recordings: RecordedFileFlow[];
};
if (manifest.recordings.length === 0) {
  throw new Error(
    "No actual provider HTTP recordings are available for replay."
  );
}

for (const fixture of manifest.recordings) {
  test(`recorded ${fixture.provider} ${fixture.model} ${fixture.kind} HTTP executes protected dependent file tools`, async () => {
    const proof = await replayRecordedFileFlow(fixtureDirectory, fixture);
    expect(proof.httpExchanges).toBe(3);
    expect(proof.guardedCalls).toBe(2);
    expect(proof.fileSha256).toBe(fixture.fileSha256);
  });
}

test("a missing actual recording fails without a network fallback", async () => {
  const fixture = manifest.recordings[0]!;
  await expect(
    replayRecordedFileFlow(fixtureDirectory, {
      ...fixture,
      cassette: "missing-recording.json",
    })
  ).rejects.toThrow();
});

test("a modified recording fails its capture hash before replay", async () => {
  const fixture = manifest.recordings[0]!;
  await expect(
    replayRecordedFileFlow(fixtureDirectory, {
      ...fixture,
      cassetteSha256: "0".repeat(64),
    })
  ).rejects.toThrow();
});

test("a modified original archive fails before decompression or replay", async () => {
  const fixture = manifest.recordings[0]!;
  await expect(
    replayRecordedFileFlow(fixtureDirectory, {
      ...fixture,
      cassetteArchiveSha256: "0".repeat(64),
    })
  ).rejects.toThrow();
});

test("rehashing altered replay JSON cannot change the preserved original recording", async () => {
  const fixture = manifest.recordings[0]!;
  const directory = await mkdtemp(join(tmpdir(), "atlas-cassette-semantic-"));
  try {
    const recorded = JSON.parse(
      await readFile(join(fixtureDirectory, fixture.cassette), "utf8")
    );
    const altered = JSON.stringify({ ...recorded, recordedAt: "changed" });
    await writeFile(join(directory, fixture.cassette), altered);
    await copyFile(
      join(fixtureDirectory, fixture.cassetteArchive),
      join(directory, fixture.cassetteArchive)
    );
    await expect(
      replayRecordedFileFlow(directory, {
        ...fixture,
        cassetteFormattedSha256: createHash("sha256")
          .update(altered)
          .digest("hex"),
      })
    ).rejects.toMatchObject({ code: "ERR_ASSERTION" });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
