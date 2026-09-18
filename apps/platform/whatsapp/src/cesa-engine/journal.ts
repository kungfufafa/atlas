import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { CesaEngineError } from "./errors";
import { validateCesaMessageKey, validateCesaSessionId } from "./ids";

export type CesaJournalStatus = "pending" | "sent" | "unknown" | "failed";

export interface CesaJournalEntry {
  createdAt: string;
  error_code?: string;
  fingerprint: string;
  key: string;
  message?: string;
  messageId: string;
  retryable: boolean;
  sessionId: string;
  status: CesaJournalStatus;
  updatedAt: string;
  version: 1;
}

export function cesaMessageFingerprint(phone: string, text: string): string {
  return createHash("sha256")
    .update(JSON.stringify([phone, text]))
    .digest("hex");
}

export function createCesaSendJournal(root: string) {
  function filename(id: string, key: string): string {
    validateCesaSessionId(id);
    validateCesaMessageKey(key);
    return join(
      root,
      id,
      `${createHash("sha256").update(key).digest("hex")}.json`
    );
  }

  return {
    read(id: string, key: string): CesaJournalEntry | null {
      const file = filename(id, key);
      let content: string;
      try {
        content = readFileSync(file, "utf8");
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return null;
        }
        throw new CesaEngineError(
          "Jurnal pengiriman WhatsApp tidak dapat dibaca.",
          503,
          "journal_unavailable"
        );
      }

      try {
        const entry = JSON.parse(content) as CesaJournalEntry;
        if (
          entry.version !== 1 ||
          entry.sessionId !== id ||
          entry.key !== key ||
          typeof entry.fingerprint !== "string" ||
          typeof entry.messageId !== "string" ||
          !["pending", "sent", "unknown", "failed"].includes(entry.status)
        ) {
          throw new Error("Invalid journal entry");
        }
        return entry;
      } catch {
        throw new CesaEngineError(
          "Jurnal pengiriman WhatsApp rusak; pengiriman tidak diulang.",
          409,
          "journal_corrupt"
        );
      }
    },

    write(entry: CesaJournalEntry): void {
      const file = filename(entry.sessionId, entry.key);
      const directory = dirname(file);
      const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
      let descriptor: number | undefined;
      try {
        mkdirSync(directory, { mode: 0o700, recursive: true });
        descriptor = openSync(temporary, "wx", 0o600);
        writeFileSync(descriptor, JSON.stringify(entry));
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        renameSync(temporary, file);
        if (process.platform !== "win32") {
          descriptor = openSync(directory, "r");
          fsyncSync(descriptor);
          closeSync(descriptor);
          descriptor = undefined;
        }
      } catch {
        throw new CesaEngineError(
          "Jurnal pengiriman WhatsApp tidak dapat disimpan.",
          503,
          "journal_unavailable",
          true
        );
      } finally {
        if (descriptor !== undefined) {
          closeSync(descriptor);
        }
        if (existsSync(temporary)) {
          rmSync(temporary, { force: true });
        }
      }
    },
  };
}

export type CesaSendJournal = ReturnType<typeof createCesaSendJournal>;
