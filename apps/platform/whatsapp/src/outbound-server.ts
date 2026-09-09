import { timingSafeEqual } from "node:crypto";
import {
  ensureWhatsAppOutboundToken,
  loadWhatsAppConfigFile,
  resolveWhatsAppOutboundDestination,
  resolveWhatsAppOutboundListenPort,
  saveWhatsAppOutboundPort,
  verifyWhatsAppOutboundAuthorization,
  WHATSAPP_OUTBOUND_TOKEN_HEADER,
} from "@atlas/core";
import { splitWhatsAppMessage } from "./format";

const DEFAULT_MAX_BODY_BYTES = 32 * 1024;
const DEFAULT_MAX_TEXT_CHARS = 16_000;
const DEFAULT_MAX_CHUNKS = 40;
const DEFAULT_MAX_CONCURRENT_SENDS = 4;
const DEFAULT_MAX_QUEUED_SENDS = 16;
const DEFAULT_QUEUE_TIMEOUT_MS = 1000;
const DEFAULT_SEND_TIMEOUT_MS = 15_000;

class RequestBodyTooLargeError extends Error {}
class SendQueueFullError extends Error {}
class SendQueueTimeoutError extends Error {}
class SendServerStoppedError extends Error {}

type ReleaseSendSlot = () => void;

interface SendQueueWaiter {
  reject: (error: Error) => void;
  resolve: (release: ReleaseSendSlot) => void;
  timeout: ReturnType<typeof setTimeout> | null;
}

class SendConcurrencyLimiter {
  private active = 0;
  private closed = false;
  private readonly queue: SendQueueWaiter[] = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueued: number,
    private readonly queueTimeoutMs: number
  ) {}

  acquire(): Promise<ReleaseSendSlot> {
    if (this.closed) {
      return Promise.reject(new SendServerStoppedError());
    }
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve(this.createRelease());
    }
    if (this.queue.length >= this.maxQueued) {
      return Promise.reject(new SendQueueFullError());
    }

    return new Promise<ReleaseSendSlot>((resolve, reject) => {
      const waiter: SendQueueWaiter = {
        reject,
        resolve,
        timeout: null,
      };
      waiter.timeout = setTimeout(() => {
        const index = this.queue.indexOf(waiter);
        if (index < 0) {
          return;
        }
        this.queue.splice(index, 1);
        reject(new SendQueueTimeoutError());
      }, this.queueTimeoutMs);
      this.queue.push(waiter);
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const waiter of this.queue) {
      if (waiter.timeout) {
        clearTimeout(waiter.timeout);
      }
      waiter.reject(new SendServerStoppedError());
    }
    this.queue.length = 0;
  }

  private createRelease(): ReleaseSendSlot {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.release();
    };
  }

  private release(): void {
    if (!this.closed) {
      const waiter = this.queue.shift();
      if (waiter) {
        if (waiter.timeout) {
          clearTimeout(waiter.timeout);
        }
        waiter.resolve(this.createRelease());
        return;
      }
    }
    this.active = Math.max(0, this.active - 1);
  }
}

export interface WhatsAppOutboundSendHandle {
  /**
   * Revoke this socket generation before its timed-out send slot is reused.
   * Returns true only when later requests can no longer receive this handle.
   */
  invalidate: () => boolean;
  sendMessage: (jid: string, content: { text: string }) => Promise<unknown>;
}

export interface WhatsAppOutboundServerOptions {
  authorizationToken: string;
  getSendHandle: () => WhatsAppOutboundSendHandle | null;
  maxBodyBytes?: number;
  maxChunks?: number;
  maxConcurrentSends?: number;
  maxQueuedSends?: number;
  maxTextChars?: number;
  orgId?: string | null;
  queueTimeoutMs?: number;
  sendTimeoutMs?: number;
}

function resolvePositiveLimit(
  value: number | undefined,
  fallback: number
): number {
  const resolved = value ?? fallback;
  if (!(Number.isSafeInteger(resolved) && resolved > 0)) {
    throw new Error(
      "WhatsApp outbound request limits must be positive integers."
    );
  }
  return resolved;
}

function resolveNonNegativeLimit(
  value: number | undefined,
  fallback: number
): number {
  const resolved = value ?? fallback;
  if (!(Number.isSafeInteger(resolved) && resolved >= 0)) {
    throw new Error(
      "WhatsApp outbound queue limit must be a non-negative integer."
    );
  }
  return resolved;
}

async function readJsonBodyWithLimit(
  request: Request,
  maxBodyBytes: number
): Promise<unknown> {
  const contentLength = request.headers.get("content-length")?.trim();
  if (contentLength && Number(contentLength) > maxBodyBytes) {
    throw new RequestBodyTooLargeError();
  }

  const reader = request.body?.getReader();
  if (!reader) {
    throw new SyntaxError("Missing JSON body");
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    totalBytes += value.byteLength;
    if (totalBytes > maxBodyBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RequestBodyTooLargeError();
    }
    chunks.push(value);
  }

  return JSON.parse(
    new TextDecoder().decode(Buffer.concat(chunks, totalBytes))
  ) as unknown;
}

function isRequestBody(
  value: unknown
): value is { text?: unknown; to?: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type SendDeadlineResult =
  | { status: "failed"; error: unknown }
  | { status: "sent" }
  | { pending: Promise<unknown>; status: "timed-out" };

async function sendMessageWithDeadline(
  handle: WhatsAppOutboundSendHandle,
  jid: string,
  text: string,
  timeoutMs: number
): Promise<SendDeadlineResult> {
  const pending = Promise.resolve().then(() =>
    handle.sendMessage(jid, { text })
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    pending.then(
      () => ({ status: "sent" }) as const,
      (error: unknown) => ({ error, status: "failed" }) as const
    ),
    new Promise<{ status: "timed-out" }>((resolve) => {
      timeout = setTimeout(() => resolve({ status: "timed-out" }), timeoutMs);
    }),
  ]);
  if (timeout) {
    clearTimeout(timeout);
  }
  return result.status === "timed-out" ? { ...result, pending } : result;
}

function unavailableResponse(error: string): Response {
  return Response.json(
    { error },
    {
      headers: { "Retry-After": "1" },
      status: 503,
    }
  );
}

function tokenMatches(provided: string | null, expected: string): boolean {
  if (!provided) {
    return false;
  }

  const actual = Buffer.from(provided.trim());
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export async function startWhatsAppOutboundServer(
  options: WhatsAppOutboundServerOptions
): Promise<{ port: number; stop: () => void }> {
  const authorizationToken = options.authorizationToken.trim();
  if (!authorizationToken) {
    throw new Error("WhatsApp outbound authorization token is required.");
  }

  const maxBodyBytes = resolvePositiveLimit(
    options.maxBodyBytes,
    DEFAULT_MAX_BODY_BYTES
  );
  const maxTextChars = resolvePositiveLimit(
    options.maxTextChars,
    DEFAULT_MAX_TEXT_CHARS
  );
  const maxChunks = resolvePositiveLimit(options.maxChunks, DEFAULT_MAX_CHUNKS);
  const maxConcurrentSends = resolvePositiveLimit(
    options.maxConcurrentSends,
    DEFAULT_MAX_CONCURRENT_SENDS
  );
  const maxQueuedSends = resolveNonNegativeLimit(
    options.maxQueuedSends,
    DEFAULT_MAX_QUEUED_SENDS
  );
  const queueTimeoutMs = resolvePositiveLimit(
    options.queueTimeoutMs,
    DEFAULT_QUEUE_TIMEOUT_MS
  );
  const sendTimeoutMs = resolvePositiveLimit(
    options.sendTimeoutMs,
    DEFAULT_SEND_TIMEOUT_MS
  );
  const sendLimiter = new SendConcurrencyLimiter(
    maxConcurrentSends,
    maxQueuedSends,
    queueTimeoutMs
  );
  const config = await loadWhatsAppConfigFile(options.orgId);
  const port = resolveWhatsAppOutboundListenPort(config);
  await ensureWhatsAppOutboundToken(options.orgId);
  let stopped = false;

  const server = Bun.serve({
    async fetch(request) {
      if (stopped) {
        return new Response("Server stopped", { status: 503 });
      }

      const url = new URL(request.url);

      if (request.method === "POST" && url.pathname === "/send") {
        if (
          !verifyWhatsAppOutboundAuthorization(
            request.headers.get("authorization"),
            authorizationToken
          )
        ) {
          return Response.json(
            { error: "Unauthorized." },
            {
              headers: { "WWW-Authenticate": "Bearer" },
              status: 401,
            }
          );
        }

        const latestConfig = await loadWhatsAppConfigFile(options.orgId);
        const expectedToken =
          latestConfig?.outboundToken?.trim() ||
          (await ensureWhatsAppOutboundToken(options.orgId));

        if (
          !(
            expectedToken &&
            tokenMatches(
              request.headers.get(WHATSAPP_OUTBOUND_TOKEN_HEADER),
              expectedToken
            )
          )
        ) {
          return Response.json({ error: "Unauthorized." }, { status: 401 });
        }

        const pairedJid = latestConfig?.pairedJid?.trim();

        if (!(latestConfig && pairedJid)) {
          return Response.json(
            { error: "WhatsApp is not paired." },
            { status: 400 }
          );
        }

        let body: unknown;

        try {
          body = await readJsonBodyWithLimit(request, maxBodyBytes);
        } catch (error) {
          if (error instanceof RequestBodyTooLargeError) {
            return Response.json(
              { error: "Request body is too large." },
              { status: 413 }
            );
          }
          return Response.json(
            { error: "Invalid JSON body." },
            { status: 400 }
          );
        }

        if (!isRequestBody(body)) {
          return Response.json(
            { error: "JSON body must be an object." },
            { status: 400 }
          );
        }

        if (typeof body.text !== "string") {
          return Response.json({ error: "text is required." }, { status: 400 });
        }

        if (body.text.length > maxTextChars) {
          return Response.json(
            { error: "WhatsApp message text is too long." },
            { status: 413 }
          );
        }

        if (body.to !== undefined && typeof body.to !== "string") {
          return Response.json(
            { error: "to must be a string." },
            { status: 400 }
          );
        }

        const text = body.text.trim();

        if (!text) {
          return Response.json({ error: "text is required." }, { status: 400 });
        }

        const destination = resolveWhatsAppOutboundDestination(
          latestConfig,
          body.to
        );
        if ("error" in destination) {
          return Response.json({ error: destination.error }, { status: 400 });
        }

        const chunks = splitWhatsAppMessage(text);
        if (chunks.length > maxChunks) {
          return Response.json(
            { error: "WhatsApp message has too many chunks." },
            { status: 413 }
          );
        }

        let releaseSendSlot: ReleaseSendSlot;
        try {
          releaseSendSlot = await sendLimiter.acquire();
        } catch (error) {
          if (error instanceof SendQueueFullError) {
            return unavailableResponse("WhatsApp outbound queue is full.");
          }
          if (error instanceof SendQueueTimeoutError) {
            return unavailableResponse(
              "WhatsApp outbound queue wait timed out."
            );
          }
          return unavailableResponse("WhatsApp outbound server is stopping.");
        }

        let releaseOnExit = true;
        try {
          const handle = options.getSendHandle();

          if (!handle) {
            return unavailableResponse("WhatsApp socket is not ready.");
          }

          for (const [index, chunk] of chunks.entries()) {
            // Queued requests and later chunks must honor policy or credential
            // revocation that happened while an earlier send was in flight.
            const currentConfig = await loadWhatsAppConfigFile(options.orgId);
            if (
              !(
                currentConfig?.outboundToken &&
                tokenMatches(
                  request.headers.get(WHATSAPP_OUTBOUND_TOKEN_HEADER),
                  currentConfig.outboundToken
                )
              )
            ) {
              return Response.json({ error: "Unauthorized." }, { status: 401 });
            }
            if (currentConfig.pairedJid?.trim() !== pairedJid) {
              return Response.json(
                { error: "WhatsApp pairing changed before delivery." },
                { status: 409 }
              );
            }
            const currentDestination = resolveWhatsAppOutboundDestination(
              currentConfig,
              body.to
            );
            if (
              "error" in currentDestination ||
              currentDestination.jid !== destination.jid
            ) {
              return Response.json(
                { error: "WhatsApp destination is no longer authorized." },
                { status: 403 }
              );
            }
            const result = await sendMessageWithDeadline(
              handle,
              destination.jid,
              chunk,
              sendTimeoutMs
            );
            if (result.status === "timed-out") {
              let invalidated = false;
              try {
                invalidated = handle.invalidate();
              } catch {
                // Keep the slot pinned if the old socket could still be reused.
              }
              if (!invalidated) {
                releaseOnExit = false;
                void result.pending.then(
                  () => releaseSendSlot(),
                  () => releaseSendSlot()
                );
              }
              return Response.json(
                {
                  error: `WhatsApp send timed out after ${sendTimeoutMs}ms; delivery status is unknown.`,
                  sentChunks: index,
                  totalChunks: chunks.length,
                },
                { status: 504 }
              );
            }
            if (result.status === "failed") {
              const message =
                result.error instanceof Error
                  ? result.error.message
                  : String(result.error);
              return Response.json({ error: message }, { status: 500 });
            }
          }
          return Response.json({
            jid: destination.jid,
            ok: true,
            sender: pairedJid,
          });
        } finally {
          if (releaseOnExit) {
            releaseSendSlot();
          }
        }
      }

      return new Response("Not found", { status: 404 });
    },
    hostname: "127.0.0.1",
    port,
  });

  if (server.port) {
    await saveWhatsAppOutboundPort(server.port, options.orgId);
  }

  return {
    port: server.port ?? port,
    stop: () => {
      stopped = true;
      sendLimiter.close();
      server.stop(true);
    },
  };
}
