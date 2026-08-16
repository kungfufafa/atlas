import { AsyncLocalStorage } from "node:async_hooks";
import { nanoid } from "../ids";

export interface TraceContext {
  attributes: Record<string, string | number | boolean>;
  conversationId?: string;
  executionAttemptId: string;
  orgId?: string;
  parentSpanId?: string;
  profileId?: string;
  spanId: string;
  startedAt: number;
  traceId: string;
  userId?: string;
}

export interface Span {
  attributes: Record<string, unknown>;
  durationMs?: number;
  endedAt?: number;
  error?: string;
  executionAttemptId: string;
  name: string;
  parentSpanId?: string;
  spanId: string;
  startedAt: number;
  status: "ok" | "error" | "cancelled";
  traceId: string;
}

const traceStorage = new AsyncLocalStorage<TraceContext>();

export function createTraceContext(options: {
  conversationId?: string;
  executionAttemptId?: string;
  orgId?: string;
  parentSpanId?: string;
  profileId?: string;
  traceId?: string;
  userId?: string;
  attributes?: Record<string, string | number | boolean>;
}): TraceContext {
  const traceId = options.traceId || `trc_${nanoid(16)}`;
  const executionAttemptId = options.executionAttemptId || `exec_${nanoid(16)}`;
  const spanId = `spn_${nanoid(12)}`;

  return {
    attributes: { ...(options.attributes || {}) },
    conversationId: options.conversationId,
    executionAttemptId,
    orgId: options.orgId,
    parentSpanId: options.parentSpanId,
    profileId: options.profileId,
    spanId,
    startedAt: Date.now(),
    traceId,
    userId: options.userId,
  };
}

export function runWithTraceContext<T>(context: TraceContext, fn: () => T): T {
  return traceStorage.run(context, fn);
}

export function getActiveTraceContext(): TraceContext | undefined {
  return traceStorage.getStore();
}

export function createChildTraceContext(
  name: string,
  attributes?: Record<string, string | number | boolean>
): TraceContext {
  const current = getActiveTraceContext();
  if (!current) {
    return createTraceContext({ attributes: { name, ...(attributes || {}) } });
  }

  return {
    ...current,
    attributes: { ...current.attributes, name, ...(attributes || {}) },
    parentSpanId: current.spanId,
    spanId: `spn_${nanoid(12)}`,
    startedAt: Date.now(),
  };
}

export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attributes?: Record<string, unknown>
): Promise<T> {
  const current = getActiveTraceContext();
  const spanId = `spn_${nanoid(12)}`;
  const traceId = current?.traceId || `trc_${nanoid(16)}`;
  const executionAttemptId =
    current?.executionAttemptId || `exec_${nanoid(16)}`;
  const startedAt = Date.now();

  const span: Span = {
    attributes: { ...(attributes || {}) },
    executionAttemptId,
    name,
    parentSpanId: current?.spanId,
    spanId,
    startedAt,
    status: "ok",
    traceId,
  };

  const childContext: TraceContext = {
    attributes: { ...(current?.attributes || {}), name },
    conversationId: current?.conversationId,
    executionAttemptId,
    orgId: current?.orgId,
    parentSpanId: current?.spanId,
    profileId: current?.profileId,
    spanId,
    startedAt,
    traceId,
    userId: current?.userId,
  };

  try {
    const result = await traceStorage.run(childContext, async () => fn(span));
    span.endedAt = Date.now();
    span.durationMs = span.endedAt - span.startedAt;
    span.status = "ok";
    return result;
  } catch (error) {
    span.endedAt = Date.now();
    span.durationMs = span.endedAt - span.startedAt;
    span.status = "error";
    span.error = error instanceof Error ? error.message : String(error);
    throw error;
  }
}
