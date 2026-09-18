import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CesaEngineError } from "./errors";
import { validateCesaMessageKey, validateCesaSessionId } from "./ids";
import {
  type CesaJournalEntry,
  type CesaSendJournal,
  cesaMessageFingerprint,
  createCesaSendJournal,
} from "./journal";
import { formatCesaWhatsAppPhone, isCesaWhatsAppPhone } from "./phone";

export type CesaSessionStatus =
  | "disconnected"
  | "connecting"
  | "qr"
  | "pairing"
  | "connected"
  | "unknown";

export interface CesaPublicSession {
  error: string | null;
  id: string;
  mode: string | null;
  ok: true;
  pairing_code: string | null;
  phone: string | null;
  qr: string | null;
  reconnect_attempt: number;
  status: CesaSessionStatus;
}

export interface CesaSendResult {
  error_code?: string;
  id?: string;
  message?: string;
  ok: boolean;
  retryable?: boolean;
  status: "sent" | "unknown" | "failed";
}

export interface CesaAuthState {
  saveCreds: () => Promise<void>;
  state: {
    creds: {
      account?: unknown;
      me?: { id?: string };
      registered?: boolean;
    };
    keys: unknown;
  };
}

export interface CesaSocket {
  end: (error?: unknown) => void;
  ev: {
    off: (event: string, listener: (...args: never[]) => void) => void;
    on: (event: string, listener: (...args: never[]) => void) => void;
  };
  logout?: () => Promise<void>;
  requestPairingCode?: (phone: string) => Promise<string>;
  sendMessage: (
    jid: string,
    content: { text: string },
    options: { messageId: string }
  ) => Promise<unknown>;
  user?: { id?: string };
  ws?: { close?: () => void };
}

export interface CesaEngineDisconnectReasons {
  connectionReplaced: number;
  forbidden: number;
  loggedOut: number;
  multideviceMismatch: number;
  restartRequired: number;
}

export interface CesaWhatsAppEngineOptions {
  disconnectReasons: CesaEngineDisconnectReasons;
  fetchVersion: () => Promise<{ version?: number[] } | null>;
  journal?: CesaSendJournal;
  journalRoot?: string;
  logger?: {
    error: (fields: Record<string, unknown>, message: string) => void;
    info?: (fields: Record<string, unknown>, message: string) => void;
    warn: (fields: Record<string, unknown>, message: string) => void;
  };
  logoutTimeoutMs?: number;
  makeSocket: (options: {
    auth: { creds: CesaAuthState["state"]["creds"]; keys: unknown };
    version?: number[];
  }) => CesaSocket;
  maxReconnect?: number;
  pairingTimeoutMs?: number;
  qrToDataURL: (qr: string) => Promise<string>;
  reconnectDelay?: (attempt: number) => number;
  sendTimeoutMs?: number;
  sessionRoot: string;
  useAuthState: (directory: string) => Promise<CesaAuthState>;
  versionTimeoutMs?: number;
}

interface CesaSessionRecord {
  error: string | null;
  generation: number;
  handlers: {
    connection: (update: CesaConnectionUpdate) => void;
    credentials: () => void;
  } | null;
  id: string;
  mode: string | null;
  pairingCode: string | null;
  pairingPhone: string | null;
  pairingRequested: boolean;
  phone: string | null;
  qr: string | null;
  qrSequence: number;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  saveQueue: Promise<void>;
  sock: CesaSocket | null;
  status: CesaSessionStatus;
  stopping: boolean;
}

interface CesaConnectionUpdate {
  connection?: string;
  lastDisconnect?: { error?: unknown };
  qr?: string;
}

const DEFAULT_REASONS: CesaEngineDisconnectReasons = {
  connectionReplaced: 440,
  forbidden: 403,
  loggedOut: 401,
  multideviceMismatch: 411,
  restartRequired: 515,
};

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function registered(state: CesaAuthState["state"]): boolean {
  return (
    state.creds.registered === true ||
    Boolean(state.creds.account && state.creds.me?.id)
  );
}

function disconnectStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return;
  }
  const output = Reflect.get(error, "output");
  if (output && typeof output === "object") {
    const code = Reflect.get(output, "statusCode");
    if (typeof code === "number") {
      return code;
    }
  }
  const code = Reflect.get(error, "statusCode");
  return typeof code === "number" ? code : undefined;
}

function failure(
  message: string,
  errorCode: string,
  retryable = false
): CesaSendResult {
  return {
    error_code: errorCode,
    message,
    ok: false,
    retryable,
    status: "failed",
  };
}

function journalResult(entry: CesaJournalEntry): CesaSendResult {
  if (entry.status === "pending") {
    return {
      error_code: "delivery_unknown",
      id: entry.messageId,
      message:
        "Hasil pengiriman WhatsApp belum dapat dipastikan. Pesan tidak dikirim ulang otomatis.",
      ok: false,
      retryable: false,
      status: "unknown",
    };
  }
  return {
    id: entry.messageId,
    ok: entry.status === "sent",
    retryable: entry.retryable === true,
    status: entry.status === "sent" ? "sent" : entry.status,
    ...(entry.message ? { message: entry.message } : {}),
    ...(entry.error_code ? { error_code: entry.error_code } : {}),
  };
}

function publicSession(record: CesaSessionRecord): CesaPublicSession {
  return {
    error: record.error,
    id: record.id,
    mode: record.mode,
    ok: true,
    pairing_code: record.pairingCode,
    phone: record.phone,
    qr: record.qr,
    reconnect_attempt: record.reconnectAttempt,
    status: record.status,
  };
}

export function createCesaWhatsAppEngine(options: CesaWhatsAppEngineOptions) {
  const sessionRoot = options.sessionRoot;
  const journal =
    options.journal ??
    createCesaSendJournal(
      options.journalRoot ?? join(sessionRoot, "..", "whatsapp-messages")
    );
  const logger = options.logger ?? {
    error() {},
    warn() {},
  };
  const reasons = options.disconnectReasons ?? DEFAULT_REASONS;
  const maxReconnect = options.maxReconnect ?? 8;
  const versionTimeoutMs = options.versionTimeoutMs ?? 5000;
  const pairingTimeoutMs = options.pairingTimeoutMs ?? 10_000;
  const logoutTimeoutMs = options.logoutTimeoutMs ?? 5000;
  const sendTimeoutMs = options.sendTimeoutMs ?? 30_000;
  const reconnectDelay =
    options.reconnectDelay ??
    ((attempt: number) => Math.min(30_000, 1000 * 2 ** attempt));

  const sessions = new Map<string, CesaSessionRecord>();
  const operations = new Map<string, Promise<unknown>>();
  const epochs = new Map<string, number>();
  const sends = new Map<
    string,
    { fingerprint: string; promise: Promise<CesaSendResult> }
  >();
  let versionPromise: Promise<number[] | null> | undefined;
  let shuttingDown = false;

  const sessionDirectory = (id: string) =>
    join(sessionRoot, validateCesaSessionId(id));
  const epoch = (id: string) => epochs.get(id) || 0;

  function serialize<T>(
    id: string,
    operation: () => Promise<T> | T
  ): Promise<T> {
    const pending = (operations.get(id) || Promise.resolve())
      .catch(() => undefined)
      .then(operation);
    operations.set(id, pending);
    void pending.finally(() => {
      if (operations.get(id) === pending) {
        operations.delete(id);
      }
    });
    return pending;
  }

  function recordFor(id: string): CesaSessionRecord {
    const existing = sessions.get(id);
    if (existing) {
      return existing;
    }
    const record: CesaSessionRecord = {
      error: null,
      generation: 0,
      handlers: null,
      id,
      mode: null,
      pairingCode: null,
      pairingPhone: null,
      pairingRequested: false,
      phone: null,
      qr: null,
      qrSequence: 0,
      reconnectAttempt: 0,
      reconnectTimer: null,
      saveQueue: Promise.resolve(),
      sock: null,
      status: "disconnected",
      stopping: false,
    };
    sessions.set(id, record);
    return record;
  }

  function invalidatePairing(record: CesaSessionRecord): void {
    record.qrSequence += 1;
    record.qr = null;
    record.pairingCode = null;
    record.pairingRequested = false;
  }

  function cancelReconnect(record: CesaSessionRecord): void {
    if (record.reconnectTimer) {
      clearTimeout(record.reconnectTimer);
    }
    record.reconnectTimer = null;
  }

  async function closeSocket(
    record: CesaSessionRecord,
    logout = false
  ): Promise<boolean> {
    const sock = record.sock;
    let logoutConfirmed = false;
    if (sock) {
      if (logout && typeof sock.logout === "function") {
        try {
          await withTimeout(
            Promise.resolve().then(() => sock.logout?.()),
            logoutTimeoutMs,
            "Logout WhatsApp melewati batas waktu."
          );
          logoutConfirmed = true;
        } catch (error) {
          logger.warn(
            {
              err: error instanceof Error ? error.message : String(error),
              id: record.id,
            },
            "Logout perangkat WhatsApp gagal."
          );
        }
      }
      if (record.handlers) {
        sock.ev.off("connection.update", record.handlers.connection);
        sock.ev.off("creds.update", record.handlers.credentials);
      }
      try {
        sock.end(undefined);
      } catch (error) {
        logger.warn(
          {
            err: error instanceof Error ? error.message : String(error),
            id: record.id,
          },
          "Socket WhatsApp gagal ditutup."
        );
      }
      try {
        sock.ws?.close?.();
      } catch (error) {
        logger.warn(
          {
            err: error instanceof Error ? error.message : String(error),
            id: record.id,
          },
          "WebSocket WhatsApp gagal ditutup."
        );
      }
    }
    record.sock = null;
    record.handlers = null;
    await record.saveQueue;
    return logoutConfirmed;
  }

  async function version(): Promise<number[] | null> {
    if (!versionPromise) {
      versionPromise = withTimeout(
        Promise.resolve().then(() => options.fetchVersion()),
        versionTimeoutMs,
        "Pengambilan versi WhatsApp melewati batas waktu."
      )
        .then((result) => {
          if (
            Array.isArray(result?.version) &&
            result.version.length === 3 &&
            result.version.every(Number.isInteger)
          ) {
            return result.version;
          }
          return null;
        })
        .catch((error) => {
          logger.warn(
            { err: error instanceof Error ? error.message : String(error) },
            "Menggunakan versi bawaan Baileys."
          );
          return null;
        });
    }
    return versionPromise;
  }

  function assertActive(
    id: string,
    expectedEpoch: number,
    record?: CesaSessionRecord
  ): void {
    if (
      shuttingDown ||
      epoch(id) !== expectedEpoch ||
      (record && (record.stopping || sessions.get(id) !== record))
    ) {
      throw new CesaEngineError(
        "Permintaan koneksi WhatsApp dibatalkan.",
        409,
        "session_cancelled",
        true
      );
    }
  }

  async function startUnlocked(
    id: string,
    mode: string,
    phone: string | null,
    expectedEpoch: number,
    resetRetries: boolean
  ): Promise<CesaPublicSession> {
    assertActive(id, expectedEpoch);
    const record = recordFor(id);
    assertActive(id, expectedEpoch, record);

    if (record.sock && record.status === "connected") {
      return publicSession(record);
    }

    const sameRequest = record.mode === mode && record.pairingPhone === phone;
    if (
      record.sock &&
      !record.error &&
      (sameRequest || mode === "restore") &&
      ["qr", "pairing", "connecting"].includes(record.status)
    ) {
      return publicSession(record);
    }

    cancelReconnect(record);
    record.generation += 1;
    const generation = record.generation;
    invalidatePairing(record);
    await closeSocket(record);
    assertActive(id, expectedEpoch, record);

    record.mode = mode;
    record.pairingPhone = phone;
    record.status = mode === "pairing" ? "pairing" : "connecting";
    record.error = null;
    if (resetRetries) {
      record.reconnectAttempt = 0;
    }

    mkdirSync(sessionDirectory(id), { mode: 0o700, recursive: true });
    let auth = await options.useAuthState(sessionDirectory(id));
    assertActive(id, expectedEpoch, record);

    if (mode === "restore" && !registered(auth.state)) {
      record.status = "disconnected";
      record.error =
        "Nomor WhatsApp belum terhubung. Scan QR atau minta kode pairing baru.";
      return publicSession(record);
    }

    if (!registered(auth.state) && auth.state.creds.me) {
      rmSync(sessionDirectory(id), { force: true, recursive: true });
      mkdirSync(sessionDirectory(id), { mode: 0o700, recursive: true });
      auth = await options.useAuthState(sessionDirectory(id));
      assertActive(id, expectedEpoch, record);
    }

    if (registered(auth.state)) {
      record.status = "connecting";
    }

    const selectedVersion = await version();
    assertActive(id, expectedEpoch, record);
    const sock = options.makeSocket({
      auth: { creds: auth.state.creds, keys: auth.state.keys },
      ...(selectedVersion ? { version: selectedVersion } : {}),
    });
    record.sock = sock;
    record.phone = registered(auth.state)
      ? auth.state.creds.me?.id?.split("@")[0]?.split(":")[0] || record.phone
      : phone;
    const isCurrent = () =>
      !shuttingDown &&
      epoch(id) === expectedEpoch &&
      sessions.get(id) === record &&
      !record.stopping &&
      record.generation === generation &&
      record.sock === sock;

    const requestPairing = async () => {
      if (
        !isCurrent() ||
        mode !== "pairing" ||
        registered(auth.state) ||
        record.pairingRequested ||
        record.pairingCode ||
        !phone
      ) {
        return;
      }
      record.pairingRequested = true;
      try {
        const code = await withTimeout(
          Promise.resolve().then(() => sock.requestPairingCode?.(phone)),
          pairingTimeoutMs,
          "Pembuatan kode pairing melewati batas waktu."
        );
        if (!isCurrent() || record.status === "connected") {
          return;
        }
        const raw = String(code || "")
          .replace(/[^A-Za-z0-9]/g, "")
          .toUpperCase();
        record.pairingCode =
          raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
        record.status = "pairing";
        record.error = null;
      } catch (error) {
        if (isCurrent()) {
          record.error = error instanceof Error ? error.message : String(error);
          record.pairingRequested = false;
        }
      }
    };

    const onConnection = (update: CesaConnectionUpdate) => {
      if (!isCurrent()) {
        return;
      }
      const { connection, qr, lastDisconnect } = update;
      if (connection === "open") {
        invalidatePairing(record);
        cancelReconnect(record);
        record.status = "connected";
        record.phone =
          sock.user?.id?.split("@")[0]?.split(":")[0] || record.phone;
        record.error = null;
        record.reconnectAttempt = 0;
        return;
      }
      if (connection === "close") {
        invalidatePairing(record);
        sock.ev.off("connection.update", onConnection);
        sock.ev.off("creds.update", onCredentials);
        record.sock = null;
        record.handlers = null;
        const code = disconnectStatusCode(lastDisconnect?.error);
        const clearAuth =
          code !== undefined &&
          [
            reasons.loggedOut,
            reasons.forbidden,
            reasons.multideviceMismatch,
          ].includes(code);
        const canReconnect = !clearAuth && code !== reasons.connectionReplaced;
        record.error = clearAuth
          ? "Sesi WhatsApp berakhir. Scan QR atau minta kode pairing baru."
          : "Koneksi WhatsApp terputus.";
        if (!canReconnect) {
          record.status = "disconnected";
          record.reconnectAttempt = 0;
          if (clearAuth) {
            void serialize(id, async () => {
              await record.saveQueue;
              if (
                epoch(id) === expectedEpoch &&
                record.generation === generation
              ) {
                rmSync(sessionDirectory(id), { force: true, recursive: true });
              }
            }).catch((error) =>
              logger.error(
                {
                  err: error instanceof Error ? error.message : String(error),
                  id,
                },
                "Gagal menghapus sesi WhatsApp."
              )
            );
          }
          return;
        }
        record.reconnectAttempt += 1;
        if (record.reconnectAttempt > maxReconnect) {
          record.status = "disconnected";
          record.error = "Koneksi putus berulang. Hubungkan ulang WhatsApp.";
          return;
        }
        record.status = "connecting";
        const wait =
          code === reasons.restartRequired
            ? 500
            : reconnectDelay(record.reconnectAttempt);
        record.reconnectTimer = setTimeout(() => {
          if (
            epoch(id) !== expectedEpoch ||
            record.stopping ||
            record.generation !== generation ||
            shuttingDown
          ) {
            return;
          }
          void startSession(id, { mode, phone, resetRetries: false }).catch(
            (error) => {
              if (epoch(id) === expectedEpoch && !record.stopping) {
                record.status = "disconnected";
                record.error =
                  error instanceof Error ? error.message : String(error);
              }
            }
          );
        }, wait);
        return;
      }
      if (qr && mode === "pairing") {
        void requestPairing().catch((error) =>
          logger.error(
            {
              err: error instanceof Error ? error.message : String(error),
              id,
            },
            "Gagal meminta pairing."
          )
        );
      } else if (qr && mode === "qr") {
        const sequence = ++record.qrSequence;
        void Promise.resolve()
          .then(() => options.qrToDataURL(qr))
          .then((image) => {
            if (
              isCurrent() &&
              record.qrSequence === sequence &&
              record.status !== "connected"
            ) {
              record.qr = image;
              record.status = "qr";
              record.error = null;
            }
          })
          .catch((error) => {
            if (
              isCurrent() &&
              record.qrSequence === sequence &&
              record.status !== "connected"
            ) {
              record.error =
                error instanceof Error ? error.message : String(error);
            }
          });
      }
    };

    const onCredentials = () => {
      if (!isCurrent()) {
        return;
      }
      record.saveQueue = record.saveQueue
        .then(() => auth.saveCreds())
        .catch((error) => {
          logger.error(
            {
              err: error instanceof Error ? error.message : String(error),
              id,
            },
            "Gagal menyimpan kredensial WhatsApp."
          );
          record.error = "Kredensial WhatsApp tidak dapat disimpan.";
        });
    };

    record.handlers = { connection: onConnection, credentials: onCredentials };
    sock.ev.on("creds.update", onCredentials);
    sock.ev.on("connection.update", onConnection);
    return publicSession(record);
  }

  function startSession(
    id: string,
    {
      mode,
      phone = null,
      resetRetries = true,
    }: { mode: string; phone?: string | null; resetRetries?: boolean }
  ): Promise<CesaPublicSession> {
    validateCesaSessionId(id);
    if (!["qr", "pairing", "restore"].includes(mode)) {
      throw new CesaEngineError(
        "Pilih mode QR atau pairing WhatsApp.",
        422,
        "invalid_mode"
      );
    }
    if (mode === "pairing" && !isCesaWhatsAppPhone(phone)) {
      throw new CesaEngineError(
        "Nomor HP pairing WhatsApp tidak valid.",
        422,
        "invalid_phone"
      );
    }
    const expectedEpoch = epoch(id);
    return serialize(id, () =>
      startUnlocked(
        id,
        mode,
        mode === "pairing" && phone ? formatCesaWhatsAppPhone(phone) : null,
        expectedEpoch,
        resetRetries
      )
    ).catch((error) => {
      const record = sessions.get(id);
      if (record && epoch(id) === expectedEpoch && !record.stopping) {
        record.status = "disconnected";
        record.error = error instanceof Error ? error.message : String(error);
      }
      throw error;
    });
  }

  function stopSession(
    id: string,
    logout = true
  ): Promise<{
    logout_confirmed?: boolean;
    message?: string;
    ok: true;
    status: "disconnected";
  }> {
    validateCesaSessionId(id);
    epochs.set(id, epoch(id) + 1);
    const record = sessions.get(id);
    if (record) {
      record.stopping = true;
      record.generation += 1;
      cancelReconnect(record);
      invalidatePairing(record);
    }
    return serialize(id, async () => {
      let logoutConfirmed = false;
      if (record) {
        logoutConfirmed = await closeSocket(record, logout);
        record.status = "disconnected";
      }
      if (logout) {
        rmSync(sessionDirectory(id), { force: true, recursive: true });
      }
      if (sessions.get(id) === record) {
        sessions.delete(id);
      }
      return {
        ok: true as const,
        status: "disconnected" as const,
        ...(logout
          ? {
              logout_confirmed: logoutConfirmed,
              message: logoutConfirmed
                ? "Nomor WhatsApp berhasil diputuskan."
                : "Sesi lokal sudah diputuskan, tetapi logout dari WhatsApp belum terkonfirmasi. Hapus perangkat CESA dari menu Perangkat tertaut di HP bila masih tercantum.",
            }
          : {}),
      };
    });
  }

  function connectedRecord(id: string): CesaSessionRecord {
    const record = sessions.get(id);
    if (!record?.sock || record.stopping || record.status !== "connected") {
      if (
        !(shuttingDown || record?.stopping || record?.sock) &&
        existsSync(join(sessionDirectory(id), "creds.json"))
      ) {
        void startSession(id, { mode: "restore" }).catch((error) => {
          logger.warn(
            {
              err: error instanceof Error ? error.message : String(error),
              id,
            },
            "Pemulihan sesi sebelum pengiriman gagal."
          );
        });
      }
      throw new CesaEngineError(
        "Nomor WhatsApp belum terhubung. Scan QR atau minta kode pairing baru.",
        409,
        "not_connected",
        true
      );
    }
    return record;
  }

  async function performSend(
    id: string,
    phone: string,
    text: string,
    key: string,
    fingerprint: string
  ): Promise<CesaSendResult> {
    const existing = journal.read(id, key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new CesaEngineError(
          "Kunci pengiriman sudah digunakan untuk pesan berbeda.",
          409,
          "idempotency_conflict"
        );
      }
      return journalResult(existing);
    }

    let record: CesaSessionRecord;
    try {
      record = connectedRecord(id);
    } catch (error) {
      return failure(
        error instanceof Error ? error.message : String(error),
        error instanceof CesaEngineError
          ? error.errorCode
          : "connection_failed",
        true
      );
    }

    const messageId = `3EB0${randomBytes(18).toString("hex").toUpperCase()}`;
    const sock = record.sock;
    if (!sock) {
      return failure("Nomor WhatsApp belum terhubung.", "not_connected", true);
    }
    const entry: CesaJournalEntry = {
      createdAt: new Date().toISOString(),
      fingerprint,
      key,
      messageId,
      retryable: false,
      sessionId: id,
      status: "pending",
      updatedAt: new Date().toISOString(),
      version: 1,
    };
    try {
      journal.write(entry);
    } catch (error) {
      return failure(
        error instanceof Error ? error.message : String(error),
        "journal_unavailable",
        true
      );
    }

    let sentPersisted = false;
    const sending = Promise.resolve()
      .then(() =>
        sock.sendMessage(`${phone}@s.whatsapp.net`, { text }, { messageId })
      )
      .then(() => {
        entry.status = "sent";
        entry.updatedAt = new Date().toISOString();
        delete entry.message;
        delete entry.error_code;
        try {
          journal.write(entry);
          sentPersisted = true;
        } catch (error) {
          logger.error(
            {
              err: error instanceof Error ? error.message : String(error),
              id,
              messageId,
            },
            "Konfirmasi pengiriman WhatsApp belum tersimpan."
          );
          throw error;
        }
        return journalResult(entry);
      });

    try {
      return await withTimeout(
        sending,
        sendTimeoutMs,
        "Pengiriman WhatsApp melewati batas waktu."
      );
    } catch (error) {
      if (sentPersisted) {
        return journalResult(entry);
      }
      entry.status = "unknown";
      entry.message =
        "Hasil pengiriman WhatsApp belum dapat dipastikan. Pesan tidak dikirim ulang otomatis.";
      entry.error_code = "delivery_unknown";
      entry.updatedAt = new Date().toISOString();
      try {
        journal.write(entry);
      } catch (journalError) {
        logger.error(
          {
            err:
              journalError instanceof Error
                ? journalError.message
                : String(journalError),
            id,
          },
          "Hasil pengiriman WhatsApp belum tersimpan."
        );
      }
      logger.warn(
        {
          err: error instanceof Error ? error.message : String(error),
          id,
          messageId,
        },
        "Hasil pengiriman WhatsApp tidak pasti."
      );
      return journalResult(entry);
    }
  }

  function sendText(
    id: string,
    payload: { idempotency_key?: unknown; phone?: unknown; text?: unknown }
  ): Promise<CesaSendResult> {
    validateCesaSessionId(id);
    const key = validateCesaMessageKey(payload.idempotency_key);
    if (!isCesaWhatsAppPhone(payload.phone)) {
      throw new CesaEngineError(
        "Nomor tujuan WhatsApp tidak valid.",
        422,
        "invalid_phone"
      );
    }
    if (
      typeof payload.text !== "string" ||
      payload.text.trim() === "" ||
      payload.text.length > 65_536
    ) {
      throw new CesaEngineError(
        "Isi pesan WhatsApp tidak valid.",
        422,
        "invalid_text"
      );
    }
    const digits = formatCesaWhatsAppPhone(payload.phone);
    const fingerprint = cesaMessageFingerprint(digits, payload.text);
    const operationKey = `${id}\u0000${key}`;
    const pending = sends.get(operationKey);
    if (pending) {
      if (pending.fingerprint !== fingerprint) {
        throw new CesaEngineError(
          "Kunci pengiriman sudah digunakan untuk pesan berbeda.",
          409,
          "idempotency_conflict"
        );
      }
      return pending.promise;
    }
    const promise = Promise.resolve().then(() =>
      performSend(id, digits, payload.text as string, key, fingerprint)
    );
    sends.set(operationKey, { fingerprint, promise });
    void promise.finally(() => {
      if (sends.get(operationKey)?.promise === promise) {
        sends.delete(operationKey);
      }
    });
    return promise;
  }

  function messageStatus(id: string, key: string): CesaSendResult {
    const entry = journal.read(
      validateCesaSessionId(id),
      validateCesaMessageKey(key)
    );
    if (!entry) {
      throw new CesaEngineError(
        "Pengiriman WhatsApp belum tercatat.",
        404,
        "message_not_found",
        true
      );
    }
    return journalResult(entry);
  }

  async function restoreSessions(): Promise<void> {
    mkdirSync(sessionRoot, { mode: 0o700, recursive: true });
    const entries = readdirSync(sessionRoot, { withFileTypes: true });
    await Promise.allSettled(
      entries
        .filter(
          (entry) =>
            entry.isDirectory() && /^rekrutmen-[1-9][0-9]*$/.test(entry.name)
        )
        .map(async (entry) => {
          if (existsSync(join(sessionDirectory(entry.name), "creds.json"))) {
            try {
              await startSession(entry.name, { mode: "restore" });
            } catch (error) {
              logger.error(
                {
                  err: error instanceof Error ? error.message : String(error),
                  id: entry.name,
                },
                "Gagal memulihkan sesi WhatsApp."
              );
            }
          }
        })
    );
  }

  async function shutdown(): Promise<void> {
    shuttingDown = true;
    await Promise.allSettled(
      [...sessions.keys()].map((id) => stopSession(id, false))
    );
  }

  return {
    health() {
      const records = [...sessions.values()];
      return {
        connected: records.filter((record) => record.status === "connected")
          .length,
        ok: true,
        sessions: records.length,
      };
    },
    messageStatus,
    restoreSessions,
    sendText,
    session(id: string): CesaPublicSession {
      validateCesaSessionId(id);
      return publicSession(recordFor(id));
    },
    shutdown,
    startSession,
    stopSession,
  };
}

export type CesaWhatsAppEngine = ReturnType<typeof createCesaWhatsAppEngine>;
