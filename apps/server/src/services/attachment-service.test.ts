import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistInlineAttachmentsInContent } from "@atlas/core";
import { getAttachmentDir } from "@atlas/core/attachments/store";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import {
  createAttachmentLoader,
  createAttachmentSaver,
  createTurnAttachmentSaver,
} from "./attachment-service";

const originalConfigDir = process.env.ATLAS_CONFIG_DIR;
let tempConfigDir = "";

afterEach(() => {
  if (tempConfigDir) {
    rmSync(tempConfigDir, { force: true, recursive: true });
    tempConfigDir = "";
  }

  if (originalConfigDir === undefined) {
    delete process.env.ATLAS_CONFIG_DIR;
  } else {
    process.env.ATLAS_CONFIG_DIR = originalConfigDir;
  }
});

describe("attachment service", () => {
  test("persists metadata and round-trips bytes through loader", async () => {
    tempConfigDir = mkdtempSync(join(tmpdir(), "atlas-att-svc-"));
    process.env.ATLAS_CONFIG_DIR = tempConfigDir;

    const db = createInMemoryDatabaseAdapter();
    const context = {
      channel: "telegram" as const,
      orgId: "org_1",
      profileId: "profile_1",
      sessionId: "session_1",
    };
    const save = createAttachmentSaver(db, context);
    const load = createAttachmentLoader(db, {
      orgId: context.orgId,
      profileId: context.profileId,
    });

    const refs = await persistInlineAttachmentsInContent(
      [
        {
          data: Buffer.from("jpeg").toString("base64"),
          mediaType: "image/jpeg",
          type: "image",
        },
      ],
      save
    );

    expect(refs).toEqual([
      {
        attachmentId: expect.stringMatching(/^att_/),
        mediaType: "image/jpeg",
        size: 4,
        type: "image_ref",
      },
    ]);

    const attachmentId = (refs as Array<{ attachmentId: string }>)[0]!
      .attachmentId;
    const record = await db.getAttachment(attachmentId);

    expect(record).toMatchObject({
      channel: "telegram",
      kind: "image",
      mediaType: "image/jpeg",
      orgId: "org_1",
      profileId: "profile_1",
      sessionId: "session_1",
      sizeBytes: 4,
    });

    const loaded = await load(attachmentId);
    expect(loaded?.bytes.toString()).toBe("jpeg");

    const crossOrgLoad = createAttachmentLoader(db, {
      orgId: "org_2",
      profileId: context.profileId,
    });
    expect(await crossOrgLoad(attachmentId)).toBeNull();
  });

  test("removes bytes when the metadata insert fails", async () => {
    tempConfigDir = mkdtempSync(join(tmpdir(), "atlas-att-svc-"));
    process.env.ATLAS_CONFIG_DIR = tempConfigDir;

    const db = createInMemoryDatabaseAdapter();
    db.insertAttachment = async () => {
      throw new Error("database unavailable");
    };
    const context = {
      channel: "web" as const,
      orgId: "org_1",
      profileId: "profile_1",
      sessionId: "session_1",
    };
    const save = createAttachmentSaver(db, context);

    await expect(
      save({
        bytes: Buffer.from("data"),
        kind: "document",
        mediaType: "text/plain",
      })
    ).rejects.toThrow("database unavailable");
    expect(
      await readdir(getAttachmentDir(context.orgId, context.profileId))
    ).toEqual([]);
  });

  test("rolls back attachments saved before a later preprocessing failure", async () => {
    tempConfigDir = mkdtempSync(join(tmpdir(), "atlas-att-svc-"));
    process.env.ATLAS_CONFIG_DIR = tempConfigDir;

    const db = createInMemoryDatabaseAdapter();
    const insertAttachment = db.insertAttachment.bind(db);
    const insertedIds: string[] = [];
    let insertCount = 0;
    db.insertAttachment = async (record) => {
      insertCount += 1;
      if (insertCount === 2) {
        throw new Error("second attachment failed");
      }
      insertedIds.push(record.id);
      await insertAttachment(record);
    };
    const context = {
      channel: "web" as const,
      orgId: "org_1",
      profileId: "profile_1",
      sessionId: "session_1",
    };
    const turnAttachments = createTurnAttachmentSaver(db, context);
    const turnId = turnAttachments.beginTurn();

    await expect(
      turnAttachments.runTurn(turnId, () =>
        persistInlineAttachmentsInContent(
          [
            {
              data: Buffer.from("first").toString("base64"),
              filename: "first.txt",
              mediaType: "text/plain",
              type: "document",
            },
            {
              data: Buffer.from("second").toString("base64"),
              filename: "second.txt",
              mediaType: "text/plain",
              type: "document",
            },
          ],
          turnAttachments.save
        )
      )
    ).rejects.toThrow("second attachment failed");

    await turnAttachments.rollbackTurn(turnId);
    expect(insertedIds).toHaveLength(1);
    expect(await db.getAttachment(insertedIds[0]!)).toBeNull();
    expect(
      await readdir(getAttachmentDir(context.orgId, context.profileId))
    ).toEqual([]);
  });

  test("commit keeps successful turn attachments out of later rollback", async () => {
    tempConfigDir = mkdtempSync(join(tmpdir(), "atlas-att-svc-"));
    process.env.ATLAS_CONFIG_DIR = tempConfigDir;

    const db = createInMemoryDatabaseAdapter();
    const context = {
      channel: "web" as const,
      orgId: "org_1",
      profileId: "profile_1",
      sessionId: "session_1",
    };
    const turnAttachments = createTurnAttachmentSaver(db, context);
    const turnId = turnAttachments.beginTurn();
    const saved = await turnAttachments.runTurn(turnId, () =>
      turnAttachments.save({
        bytes: Buffer.from("kept"),
        kind: "document",
        mediaType: "text/plain",
      })
    );

    turnAttachments.commitTurn(turnId);
    await turnAttachments.rollbackTurn(turnId);

    expect(await db.getAttachment(saved.attachmentId)).not.toBeNull();
    expect(
      await readdir(getAttachmentDir(context.orgId, context.profileId))
    ).toEqual([saved.attachmentId]);
  });

  test("a delayed rejection cannot delete a newer turn attachment", async () => {
    tempConfigDir = mkdtempSync(join(tmpdir(), "atlas-att-svc-"));
    process.env.ATLAS_CONFIG_DIR = tempConfigDir;

    const db = createInMemoryDatabaseAdapter();
    const context = {
      channel: "web" as const,
      orgId: "org_1",
      profileId: "profile_1",
      sessionId: "session_1",
    };
    const turnAttachments = createTurnAttachmentSaver(db, context);
    const oldTurnId = turnAttachments.beginTurn();
    const oldAttachment = await turnAttachments.runTurn(oldTurnId, () =>
      turnAttachments.save({
        bytes: Buffer.from("old"),
        kind: "document",
        mediaType: "text/plain",
      })
    );
    const newTurnId = turnAttachments.beginTurn();
    const newAttachment = await turnAttachments.runTurn(newTurnId, () =>
      turnAttachments.save({
        bytes: Buffer.from("new"),
        kind: "document",
        mediaType: "text/plain",
      })
    );

    await turnAttachments.rollbackTurn(oldTurnId);

    expect(await db.getAttachment(oldAttachment.attachmentId)).toBeNull();
    expect(await db.getAttachment(newAttachment.attachmentId)).not.toBeNull();
    expect(
      await readdir(getAttachmentDir(context.orgId, context.profileId))
    ).toEqual([newAttachment.attachmentId]);
  });
});
