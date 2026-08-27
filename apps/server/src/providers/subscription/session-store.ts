import { AsyncLocalStorage } from "node:async_hooks";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { SubscriptionProviderKind } from "@atlas/core";
import {
  getUserConfigDir,
  readTextOrNull,
  writePrivateTextFile,
} from "@atlas/core";

export interface SubscriptionSessionBinding {
  historyFingerprint?: string;
  lastMessageCount: number;
  runtimeSessionId: string;
  updatedAt?: string;
}

interface SessionStoreFile {
  pendingDeletions: Record<string, SubscriptionSessionDeletionCandidate>;
  sessions: Record<string, SubscriptionSessionBinding>;
}

const MAX_SESSION_BINDINGS = 2000;
const MAX_PENDING_DELETIONS = 4000;
const PROVIDER_SESSION_DRAIN_TIMEOUT_MS = 10_000;
let mutationQueue: Promise<void> = Promise.resolve();
const leaseStorage = new AsyncLocalStorage<SubscriptionSessionLease>();
const providerLeaseStorage = new AsyncLocalStorage<
  ReadonlySet<SubscriptionProviderKind>
>();
const activeLeaseCounts = new Map<string, number>();
const activeLeaseWaiters = new Map<string, Set<() => void>>();
const activeProviderLeaseCounts = new Map<SubscriptionProviderKind, number>();
const activeProviderLeaseWaiters = new Map<
  SubscriptionProviderKind,
  Set<() => void>
>();
const deletionBlockCounts = new Map<string, number>();
const providerDeletionBlockCounts = new Map<SubscriptionProviderKind, number>();
const providerDeletionOperations = new Map<
  SubscriptionProviderKind,
  Promise<void>
>();
const sessionGenerations = new Map<string, number>();

interface SubscriptionSessionLease {
  cleanupHandler?: SubscriptionSessionCleanupHandler;
  generation: number;
  key: string;
}

export interface SubscriptionSessionDeletionCandidate {
  conversationId: string;
  kind: SubscriptionProviderKind;
  runtimeSessionId: string;
  updatedAt?: string;
}

export interface SubscriptionSessionDeletionBarrier {
  release: () => void;
  waitForIdle: (timeoutMs: number) => Promise<void>;
}

export type SubscriptionSessionCleanupHandler = (
  candidate: SubscriptionSessionDeletionCandidate
) => Promise<void>;

export type SubscriptionProviderPostDeletionHandler = () => Promise<void>;

export async function withSubscriptionProviderLease<T>(
  kind: SubscriptionProviderKind,
  operation: () => Promise<T>
): Promise<T> {
  const activeKinds = providerLeaseStorage.getStore();
  if (isProviderDeletionBlocked(kind)) {
    throw new Error("This subscription provider is currently being cleared.");
  }
  if (activeKinds?.has(kind)) {
    return await operation();
  }

  const nextActiveKinds = new Set(activeKinds);
  nextActiveKinds.add(kind);
  incrementActiveProviderLease(kind);
  try {
    return await providerLeaseStorage.run(nextActiveKinds, operation);
  } finally {
    decrementActiveProviderLease(kind);
  }
}

export async function withSubscriptionSessionLease<T>(
  kind: SubscriptionProviderKind,
  conversationId: string | undefined,
  operation: () => Promise<T>,
  cleanupHandler?: SubscriptionSessionCleanupHandler
): Promise<T> {
  return await withSubscriptionProviderLease(kind, async () => {
    const normalizedConversationId = conversationId?.trim();
    if (!normalizedConversationId) {
      return await operation();
    }

    const key = bindingKey(kind, normalizedConversationId);
    if (isConversationDeletionBlocked(normalizedConversationId)) {
      throw new Error("This conversation is currently being cleared.");
    }
    if (leaseStorage.getStore()?.key === key) {
      return await operation();
    }

    const lease: SubscriptionSessionLease = {
      ...(cleanupHandler ? { cleanupHandler } : {}),
      generation: sessionGenerations.get(key) ?? 0,
      key,
    };
    incrementActiveLease(normalizedConversationId);
    try {
      return await leaseStorage.run(lease, operation);
    } finally {
      decrementActiveLease(normalizedConversationId);
    }
  });
}

export function beginSubscriptionSessionDeletion(
  conversationId: string
): SubscriptionSessionDeletionBarrier {
  const normalizedConversationId = conversationId.trim();
  deletionBlockCounts.set(
    normalizedConversationId,
    (deletionBlockCounts.get(normalizedConversationId) ?? 0) + 1
  );
  invalidateSessionGeneration("chatgpt", normalizedConversationId);
  invalidateSessionGeneration("claude", normalizedConversationId);

  let released = false;
  return {
    release: () => {
      if (released) {
        return;
      }
      released = true;
      const remaining =
        (deletionBlockCounts.get(normalizedConversationId) ?? 1) - 1;
      if (remaining > 0) {
        deletionBlockCounts.set(normalizedConversationId, remaining);
      } else {
        deletionBlockCounts.delete(normalizedConversationId);
        cleanupGenerationIfIdle(normalizedConversationId);
      }
    },
    waitForIdle: (timeoutMs) =>
      waitForConversationIdle(normalizedConversationId, timeoutMs),
  };
}

export function subscriptionWorkspaceDir(
  kind: SubscriptionProviderKind
): string {
  return join(getUserConfigDir(), "subscription-workspaces", kind);
}

export async function readSubscriptionSession(
  kind: SubscriptionProviderKind,
  conversationId: string
): Promise<SubscriptionSessionBinding | null> {
  await mutationQueue;
  const store = await loadStore();
  return store.sessions[bindingKey(kind, conversationId)] ?? null;
}

export async function writeSubscriptionSession(
  kind: SubscriptionProviderKind,
  conversationId: string,
  binding: SubscriptionSessionBinding
): Promise<void> {
  const key = bindingKey(kind, conversationId);
  const lease = leaseStorage.getStore();
  const writeWasInvalidated =
    isConversationDeletionBlocked(conversationId) ||
    (lease?.key === key &&
      lease.generation !== (sessionGenerations.get(key) ?? 0));
  const cleanupCandidates: SubscriptionSessionDeletionCandidate[] = [];

  await mutateStore((store) => {
    if (writeWasInvalidated) {
      cleanupCandidates.push(
        queuePendingDeletion(
          store,
          kind,
          conversationId,
          binding.runtimeSessionId
        )
      );
      appendPendingCleanupCandidates(
        store,
        kind,
        conversationId,
        cleanupCandidates
      );
      return;
    }

    const existing = store.sessions[key];
    if (existing && existing.runtimeSessionId !== binding.runtimeSessionId) {
      cleanupCandidates.push(
        queuePendingDeletion(
          store,
          kind,
          conversationId,
          existing.runtimeSessionId
        )
      );
    }
    store.sessions[key] = {
      ...binding,
      updatedAt: new Date().toISOString(),
    };
    cleanupCandidates.push(...trimOldestBindings(store));
    enforcePendingDeletionCapacity(store);
    appendPendingCleanupCandidates(
      store,
      kind,
      conversationId,
      cleanupCandidates
    );
  });

  await cleanupQueuedCandidates(cleanupCandidates, lease?.cleanupHandler);
}

export async function clearSubscriptionSession(
  kind: SubscriptionProviderKind,
  conversationId: string
): Promise<void> {
  const cleanupCandidates: SubscriptionSessionDeletionCandidate[] = [];
  await mutateStore((store) => {
    const key = bindingKey(kind, conversationId);
    const existing = store.sessions[key];
    if (existing) {
      cleanupCandidates.push(
        queuePendingDeletion(
          store,
          kind,
          conversationId,
          existing.runtimeSessionId
        )
      );
      delete store.sessions[key];
    }
    enforcePendingDeletionCapacity(store);
  });
  await cleanupQueuedCandidates(
    cleanupCandidates,
    leaseStorage.getStore()?.cleanupHandler
  );
}

export async function clearSubscriptionSessionsForConversation(
  conversationId: string
): Promise<void> {
  const cleanupCandidates: SubscriptionSessionDeletionCandidate[] = [];
  await mutateStore((store) => {
    for (const kind of ["chatgpt", "claude"] as const) {
      const key = bindingKey(kind, conversationId);
      const existing = store.sessions[key];
      if (existing) {
        cleanupCandidates.push(
          queuePendingDeletion(
            store,
            kind,
            conversationId,
            existing.runtimeSessionId
          )
        );
        delete store.sessions[key];
      }
    }
    enforcePendingDeletionCapacity(store);
  });
  await cleanupQueuedCandidates(
    cleanupCandidates,
    leaseStorage.getStore()?.cleanupHandler
  );
}

export async function clearSubscriptionSessions(
  kind: SubscriptionProviderKind
): Promise<void> {
  await mutateStore((store) => {
    const prefix = `${kind}:`;
    for (const key of Object.keys(store.sessions)) {
      if (key.startsWith(prefix)) {
        const binding = store.sessions[key];
        const conversationId = key.slice(prefix.length);
        if (binding) {
          queuePendingDeletion(
            store,
            kind,
            conversationId,
            binding.runtimeSessionId
          );
        }
        delete store.sessions[key];
      }
    }
    enforcePendingDeletionCapacity(store);
  });
}

export async function deleteSubscriptionProviderSessions(
  kind: SubscriptionProviderKind,
  handler: SubscriptionSessionCleanupHandler,
  afterDelete?: SubscriptionProviderPostDeletionHandler
): Promise<void> {
  const existing = providerDeletionOperations.get(kind);
  if (existing) {
    return await existing;
  }

  const operation = performProviderSessionDeletion(kind, handler, afterDelete);
  providerDeletionOperations.set(kind, operation);
  try {
    await operation;
  } finally {
    if (providerDeletionOperations.get(kind) === operation) {
      providerDeletionOperations.delete(kind);
    }
  }
}

async function performProviderSessionDeletion(
  kind: SubscriptionProviderKind,
  handler: SubscriptionSessionCleanupHandler,
  afterDelete: SubscriptionProviderPostDeletionHandler | undefined
): Promise<void> {
  beginProviderDeletionBlock(kind);
  try {
    await waitForProviderIdle(kind, PROVIDER_SESSION_DRAIN_TIMEOUT_MS);
    const candidates = await listProviderDeletionCandidates(kind);
    const failures: Error[] = [];
    for (const candidate of candidates) {
      try {
        await handler(candidate);
      } catch (error) {
        if (isMissingSubscriptionSessionError(error)) {
          await confirmSubscriptionSessionDeletion(candidate);
          continue;
        }
        failures.push(
          error instanceof Error ? error : new Error(String(error))
        );
        continue;
      }
      await confirmSubscriptionSessionDeletion(candidate);
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Could not delete every native ${kind} subscription session. Retry logout.`
      );
    }
    await afterDelete?.();
  } finally {
    endProviderDeletionBlock(kind);
  }
}

export async function deleteUnpersistedSubscriptionSession(
  kind: SubscriptionProviderKind,
  conversationId: string,
  runtimeSessionId: string,
  handler: SubscriptionSessionCleanupHandler
): Promise<void> {
  const candidate = buildDeletionCandidate(
    kind,
    conversationId,
    runtimeSessionId
  );
  let retained = await tryRetainDeletionCandidate(candidate);
  try {
    await handler(candidate);
  } catch (error) {
    if (isMissingSubscriptionSessionError(error)) {
      await confirmSubscriptionSessionDeletion(candidate).catch(
        () => undefined
      );
      return;
    }
    if (!retained) {
      retained = await tryRetainDeletionCandidate(candidate);
    }
    throw error;
  }
  if (retained) {
    await confirmSubscriptionSessionDeletion(candidate).catch(() => undefined);
  }
}

export function isMissingSubscriptionSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  const identifiesNativeSession =
    normalized.includes("thread") || normalized.includes("session");
  const identifiesMissingResource =
    normalized.includes("not found") ||
    normalized.includes("does not exist") ||
    normalized.includes("already deleted") ||
    normalized.includes("unknown thread") ||
    normalized.includes("unknown session");
  return identifiesNativeSession && identifiesMissingResource;
}

export async function listSubscriptionSessionDeletionCandidates(
  conversationId: string
): Promise<SubscriptionSessionDeletionCandidate[]> {
  await mutationQueue;
  const store = await loadStore();
  const candidates = new Map<string, SubscriptionSessionDeletionCandidate>();
  for (const kind of ["chatgpt", "claude"] as const) {
    const binding = store.sessions[bindingKey(kind, conversationId)];
    if (binding) {
      const candidate = buildDeletionCandidate(
        kind,
        conversationId,
        binding.runtimeSessionId,
        binding.updatedAt
      );
      candidates.set(deletionKey(candidate), candidate);
    }
  }
  for (const candidate of Object.values(store.pendingDeletions)) {
    if (candidate.conversationId === conversationId) {
      candidates.set(deletionKey(candidate), candidate);
    }
  }
  return [...candidates.values()];
}

export async function confirmSubscriptionSessionDeletion(
  candidate: SubscriptionSessionDeletionCandidate
): Promise<void> {
  await mutateStore((store) => {
    const key = bindingKey(candidate.kind, candidate.conversationId);
    if (store.sessions[key]?.runtimeSessionId === candidate.runtimeSessionId) {
      delete store.sessions[key];
    }
    for (const [pendingKey, pending] of Object.entries(
      store.pendingDeletions
    )) {
      if (sameDeletionCandidate(pending, candidate)) {
        delete store.pendingDeletions[pendingKey];
      }
    }
  });
}

function bindingKey(
  kind: SubscriptionProviderKind,
  conversationId: string
): string {
  return `${kind}:${conversationId}`;
}

function parseBindingKey(value: string): {
  conversationId: string;
  kind: SubscriptionProviderKind;
} | null {
  for (const kind of ["chatgpt", "claude"] as const) {
    const prefix = `${kind}:`;
    if (value.startsWith(prefix) && value.length > prefix.length) {
      return { conversationId: value.slice(prefix.length), kind };
    }
  }
  return null;
}

function storePath(): string {
  return join(getUserConfigDir(), "subscription-sessions.json");
}

async function loadStore(): Promise<SessionStoreFile> {
  const raw = await readTextOrNull(storePath());
  if (!raw?.trim()) {
    return { pendingDeletions: {}, sessions: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw corruptedStoreError(error);
  }
  if (!(isRecord(parsed) && isRecord(parsed.sessions))) {
    throw corruptedStoreError();
  }

  const sessions: Record<string, SubscriptionSessionBinding> = {};
  for (const [key, value] of Object.entries(parsed.sessions)) {
    const binding = parseBinding(value);
    if (!(parseBindingKey(key) && binding)) {
      throw corruptedStoreError();
    }
    sessions[key] = binding;
  }

  const pendingDeletions: Record<string, SubscriptionSessionDeletionCandidate> =
    {};
  if (parsed.pendingDeletions !== undefined) {
    if (!isRecord(parsed.pendingDeletions)) {
      throw corruptedStoreError();
    }
    for (const [key, value] of Object.entries(parsed.pendingDeletions)) {
      const candidate = parseDeletionCandidate(value);
      if (!(candidate && key === deletionKey(candidate))) {
        throw corruptedStoreError();
      }
      pendingDeletions[key] = candidate;
    }
  }
  if (
    Object.keys(sessions).length > MAX_SESSION_BINDINGS ||
    Object.keys(pendingDeletions).length > MAX_PENDING_DELETIONS
  ) {
    throw corruptedStoreError();
  }
  return { pendingDeletions, sessions };
}

function corruptedStoreError(cause?: unknown): Error {
  return new Error(
    "The subscription session store is corrupted. Repair or remove it before retrying; Atlas will not overwrite it.",
    cause === undefined ? undefined : { cause }
  );
}

async function saveStore(store: SessionStoreFile): Promise<void> {
  const path = storePath();
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writePrivateTextFile(
      temporaryPath,
      `${JSON.stringify(store, null, 2)}\n`
    );
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function mutateStore(
  mutation: (store: SessionStoreFile) => void
): Promise<void> {
  const operation = mutationQueue.then(async () => {
    const store = await loadStore();
    mutation(store);
    await saveStore(store);
  });
  mutationQueue = operation.catch(() => undefined);
  await operation;
}

function parseBinding(value: unknown): SubscriptionSessionBinding | null {
  if (!isRecord(value)) {
    return null;
  }
  const { historyFingerprint, lastMessageCount, runtimeSessionId, updatedAt } =
    value;
  if (
    typeof runtimeSessionId !== "string" ||
    !runtimeSessionId.trim() ||
    typeof lastMessageCount !== "number" ||
    !Number.isSafeInteger(lastMessageCount) ||
    lastMessageCount < 0
  ) {
    return null;
  }
  return {
    lastMessageCount,
    runtimeSessionId,
    ...(typeof historyFingerprint === "string" && historyFingerprint
      ? { historyFingerprint }
      : {}),
    ...(typeof updatedAt === "string" && updatedAt ? { updatedAt } : {}),
  };
}

function parseDeletionCandidate(
  value: unknown
): SubscriptionSessionDeletionCandidate | null {
  if (!isRecord(value)) {
    return null;
  }
  const { conversationId, kind, runtimeSessionId, updatedAt } = value;
  if (
    (kind !== "chatgpt" && kind !== "claude") ||
    typeof conversationId !== "string" ||
    !conversationId.trim() ||
    typeof runtimeSessionId !== "string" ||
    !runtimeSessionId.trim()
  ) {
    return null;
  }
  return buildDeletionCandidate(
    kind,
    conversationId,
    runtimeSessionId,
    typeof updatedAt === "string" ? updatedAt : undefined
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function trimOldestBindings(
  store: SessionStoreFile
): SubscriptionSessionDeletionCandidate[] {
  const entries = Object.entries(store.sessions);
  if (entries.length <= MAX_SESSION_BINDINGS) {
    return [];
  }
  entries.sort((left, right) =>
    (left[1].updatedAt ?? "").localeCompare(right[1].updatedAt ?? "")
  );
  const excess = entries.length - MAX_SESSION_BINDINGS;
  const candidates: SubscriptionSessionDeletionCandidate[] = [];
  for (const [key] of entries.slice(0, excess)) {
    const parsedKey = parseBindingKey(key);
    const binding = store.sessions[key];
    if (parsedKey && binding) {
      candidates.push(
        queuePendingDeletion(
          store,
          parsedKey.kind,
          parsedKey.conversationId,
          binding.runtimeSessionId
        )
      );
    }
    delete store.sessions[key];
  }
  return candidates;
}

function enforcePendingDeletionCapacity(store: SessionStoreFile): void {
  if (Object.keys(store.pendingDeletions).length <= MAX_PENDING_DELETIONS) {
    return;
  }
  throw new Error(
    "Too many native subscription sessions are awaiting deletion. Retry cleanup before continuing."
  );
}

function buildDeletionCandidate(
  kind: SubscriptionProviderKind,
  conversationId: string,
  runtimeSessionId: string,
  updatedAt: string | undefined = new Date().toISOString()
): SubscriptionSessionDeletionCandidate {
  return {
    conversationId,
    kind,
    runtimeSessionId,
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function deletionKey(candidate: SubscriptionSessionDeletionCandidate): string {
  return JSON.stringify([
    candidate.kind,
    candidate.conversationId,
    candidate.runtimeSessionId,
  ]);
}

function queuePendingDeletion(
  store: SessionStoreFile,
  kind: SubscriptionProviderKind,
  conversationId: string,
  runtimeSessionId: string
): SubscriptionSessionDeletionCandidate {
  const candidate = buildDeletionCandidate(
    kind,
    conversationId,
    runtimeSessionId
  );
  store.pendingDeletions[deletionKey(candidate)] = candidate;
  return candidate;
}

function appendPendingCleanupCandidates(
  store: SessionStoreFile,
  kind: SubscriptionProviderKind,
  conversationId: string,
  candidates: SubscriptionSessionDeletionCandidate[]
): void {
  for (const candidate of Object.values(store.pendingDeletions)) {
    if (
      candidate.kind === kind &&
      candidate.conversationId === conversationId
    ) {
      candidates.push(candidate);
    }
  }
}

function sameDeletionCandidate(
  left: SubscriptionSessionDeletionCandidate,
  right: SubscriptionSessionDeletionCandidate
): boolean {
  return (
    left.kind === right.kind &&
    left.conversationId === right.conversationId &&
    left.runtimeSessionId === right.runtimeSessionId
  );
}

async function tryRetainDeletionCandidate(
  candidate: SubscriptionSessionDeletionCandidate
): Promise<boolean> {
  try {
    await mutateStore((store) => {
      store.pendingDeletions[deletionKey(candidate)] = candidate;
      enforcePendingDeletionCapacity(store);
    });
    return true;
  } catch {
    return false;
  }
}

async function cleanupQueuedCandidates(
  candidates: SubscriptionSessionDeletionCandidate[],
  handler: SubscriptionSessionCleanupHandler | undefined
): Promise<void> {
  if (!handler || candidates.length === 0) {
    return;
  }
  const uniqueCandidates = new Map<
    string,
    SubscriptionSessionDeletionCandidate
  >();
  for (const candidate of candidates) {
    uniqueCandidates.set(deletionKey(candidate), candidate);
  }
  for (const candidate of uniqueCandidates.values()) {
    try {
      await handler(candidate);
    } catch (error) {
      if (!isMissingSubscriptionSessionError(error)) {
        // The durable pending-deletion entry is retained for a later retry.
        continue;
      }
    }
    await confirmSubscriptionSessionDeletion(candidate);
  }
}

async function listProviderDeletionCandidates(
  kind: SubscriptionProviderKind
): Promise<SubscriptionSessionDeletionCandidate[]> {
  await mutationQueue;
  const store = await loadStore();
  const candidates = new Map<string, SubscriptionSessionDeletionCandidate>();
  for (const [key, binding] of Object.entries(store.sessions)) {
    const parsedKey = parseBindingKey(key);
    if (parsedKey?.kind !== kind) {
      continue;
    }
    const candidate = buildDeletionCandidate(
      kind,
      parsedKey.conversationId,
      binding.runtimeSessionId,
      binding.updatedAt
    );
    candidates.set(deletionKey(candidate), candidate);
  }
  for (const candidate of Object.values(store.pendingDeletions)) {
    if (candidate.kind === kind) {
      candidates.set(deletionKey(candidate), candidate);
    }
  }
  return [...candidates.values()];
}

function invalidateSessionGeneration(
  kind: SubscriptionProviderKind,
  conversationId: string
): void {
  const key = bindingKey(kind, conversationId);
  sessionGenerations.set(key, (sessionGenerations.get(key) ?? 0) + 1);
}

function isConversationDeletionBlocked(conversationId: string): boolean {
  return (deletionBlockCounts.get(conversationId) ?? 0) > 0;
}

function incrementActiveLease(conversationId: string): void {
  activeLeaseCounts.set(
    conversationId,
    (activeLeaseCounts.get(conversationId) ?? 0) + 1
  );
}

function incrementActiveProviderLease(kind: SubscriptionProviderKind): void {
  activeProviderLeaseCounts.set(
    kind,
    (activeProviderLeaseCounts.get(kind) ?? 0) + 1
  );
}

function decrementActiveLease(conversationId: string): void {
  const remaining = (activeLeaseCounts.get(conversationId) ?? 1) - 1;
  if (remaining > 0) {
    activeLeaseCounts.set(conversationId, remaining);
    return;
  }
  activeLeaseCounts.delete(conversationId);
  const waiters = activeLeaseWaiters.get(conversationId);
  if (waiters) {
    activeLeaseWaiters.delete(conversationId);
    for (const waiter of waiters) {
      waiter();
    }
  }
  cleanupGenerationIfIdle(conversationId);
}

function decrementActiveProviderLease(kind: SubscriptionProviderKind): void {
  const remaining = (activeProviderLeaseCounts.get(kind) ?? 1) - 1;
  if (remaining > 0) {
    activeProviderLeaseCounts.set(kind, remaining);
    return;
  }
  activeProviderLeaseCounts.delete(kind);
  const waiters = activeProviderLeaseWaiters.get(kind);
  if (!waiters) {
    return;
  }
  activeProviderLeaseWaiters.delete(kind);
  for (const waiter of waiters) {
    waiter();
  }
}

function beginProviderDeletionBlock(kind: SubscriptionProviderKind): void {
  providerDeletionBlockCounts.set(
    kind,
    (providerDeletionBlockCounts.get(kind) ?? 0) + 1
  );
}

function endProviderDeletionBlock(kind: SubscriptionProviderKind): void {
  const remaining = (providerDeletionBlockCounts.get(kind) ?? 1) - 1;
  if (remaining > 0) {
    providerDeletionBlockCounts.set(kind, remaining);
  } else {
    providerDeletionBlockCounts.delete(kind);
  }
}

function isProviderDeletionBlocked(kind: SubscriptionProviderKind): boolean {
  return (providerDeletionBlockCounts.get(kind) ?? 0) > 0;
}

function cleanupGenerationIfIdle(conversationId: string): void {
  if (
    (activeLeaseCounts.get(conversationId) ?? 0) > 0 ||
    isConversationDeletionBlocked(conversationId)
  ) {
    return;
  }
  sessionGenerations.delete(bindingKey("chatgpt", conversationId));
  sessionGenerations.delete(bindingKey("claude", conversationId));
}

async function waitForConversationIdle(
  conversationId: string,
  timeoutMs: number
): Promise<void> {
  if ((activeLeaseCounts.get(conversationId) ?? 0) === 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      activeLeaseWaiters.get(conversationId)?.delete(finish);
      resolve();
    };
    const waiters = activeLeaseWaiters.get(conversationId) ?? new Set();
    waiters.add(finish);
    activeLeaseWaiters.set(conversationId, waiters);
    timeout = setTimeout(() => {
      waiters.delete(finish);
      if (waiters.size === 0) {
        activeLeaseWaiters.delete(conversationId);
      }
      reject(
        new Error(
          "Timed out waiting for the active subscription turn to stop. Retry the request."
        )
      );
    }, timeoutMs);
  });
}

async function waitForProviderIdle(
  kind: SubscriptionProviderKind,
  timeoutMs: number
): Promise<void> {
  if ((activeProviderLeaseCounts.get(kind) ?? 0) === 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      activeProviderLeaseWaiters.get(kind)?.delete(finish);
      resolve();
    };
    const waiters = activeProviderLeaseWaiters.get(kind) ?? new Set();
    waiters.add(finish);
    activeProviderLeaseWaiters.set(kind, waiters);
    timeout = setTimeout(() => {
      waiters.delete(finish);
      if (waiters.size === 0) {
        activeProviderLeaseWaiters.delete(kind);
      }
      reject(
        new Error(
          `Timed out waiting for active ${kind} subscription turns to stop. Retry logout.`
        )
      );
    }, timeoutMs);
  });
}
