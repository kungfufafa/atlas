import { randomUUID } from "node:crypto";
import type { ToolExecutionLifecycle } from "@atlas/agent";
import type { ToolContext } from "@atlas/core";
import type {
  ArtifactPublicationIdentity,
  ArtifactPublicationProducer,
} from "@atlas/core/artifact-publication";
import { createToolArtifactPublisher } from "@atlas/core/artifact-publication";
import { waitForAbortable } from "@atlas/core/download-deadline";
import {
  MAX_PUBLICATION_BYTES,
  MAX_PUBLICATION_OUTPUTS,
  validatePublicationPath,
} from "@atlas/db";
import type {
  ArtifactPublicationExecution,
  ArtifactPublicationService,
  PublicationFinalization,
} from "./artifact-publication-service";

function required(value: string | undefined, field: string): string {
  const result = value?.trim();
  if (!result) {
    throw new Error(`Artifact publication requires ${field}.`);
  }
  return result;
}

/** Diagnostic observer only. A slow or failed observer cannot erase a tool receipt. */
function observe(observer: (() => void | Promise<void>) | undefined): void {
  try {
    Promise.resolve(observer?.()).catch(() => {
      // The completed tool and committed publication retain their own outcomes.
    });
  } catch {
    // Synchronous observers have the same isolation as asynchronous observers.
  }
}

/**
 * Host adapter for the common API/native tool loop. Production admission and
 * publication-backed consumers must be wired together before a strict cutover.
 */
export function createArtifactPublicationLifecycle(options: {
  /** Must include the actual admitted workspace, runtime and temporary roots. */
  admittedToolRoots(context: Readonly<ToolContext>): Promise<readonly string[]>;
  onFinalized?(
    identity: ArtifactPublicationIdentity,
    result: PublicationFinalization
  ): void | Promise<void>;
  onError?: ToolExecutionLifecycle["onError"];
  service: ArtifactPublicationService;
}): ToolExecutionLifecycle {
  return {
    begin(call, context) {
      // Freeze trusted identity before tool code can mutate its own context/call.
      const identity: ArtifactPublicationIdentity = {
        actorId: required(context.userId, "actor"),
        executionId: randomUUID(),
        orgId: required(context.orgId, "organization"),
        profileId: required(context.profileId, "profile"),
        runId: required(context.runId, "run"),
        sessionId: required(context.sessionId, "session"),
        toolCallId: required(call.id, "tool call"),
      };
      const capturedContext = Object.freeze({ ...context });
      const publicationAbort = new AbortController();
      const signal = context.signal
        ? AbortSignal.any([context.signal, publicationAbort.signal])
        : publicationAbort.signal;
      let execution: Promise<ArtifactPublicationExecution> | undefined;
      let closed = false;
      let stageError: unknown;
      let stagingFailed = false;
      let completion: Promise<void> | undefined;
      const pending = new Set<Promise<void>>();
      const producer: ArtifactPublicationProducer = {
        stageBytes(input) {
          if (closed) {
            return Promise.reject(new Error("Tool publication is closed."));
          }
          if (stagingFailed) {
            return Promise.reject(stageError);
          }
          // Copy before asynchronous authorization or root inventory resolution.
          let bytes: Buffer;
          let sourcePath: string;
          let outputOrdinal: number;
          try {
            signal.throwIfAborted();
            const supplied = input.bytes;
            if (
              !(supplied instanceof Uint8Array) ||
              supplied.byteLength > MAX_PUBLICATION_BYTES ||
              pending.size >= MAX_PUBLICATION_OUTPUTS
            ) {
              throw new Error(
                "Invalid or oversized artifact publication input."
              );
            }
            sourcePath = input.sourcePath;
            validatePublicationPath(sourcePath);
            outputOrdinal = input.outputOrdinal;
            if (
              !Number.isSafeInteger(outputOrdinal) ||
              outputOrdinal < 0 ||
              outputOrdinal >= MAX_PUBLICATION_OUTPUTS
            ) {
              throw new Error("Invalid publication output ordinal.");
            }
            bytes = Buffer.from(supplied);
          } catch (error) {
            stagingFailed = true;
            stageError = error;
            publicationAbort.abort(error);
            return Promise.reject(error);
          }
          if (!execution) {
            const initializing = (async () => {
              const roots = await options.admittedToolRoots(capturedContext);
              signal.throwIfAborted();
              return await options.service.beginExecution(
                identity,
                roots,
                signal
              );
            })();
            // A resolver can abort synchronously before waitForAbortable attaches.
            // Observe detached rejection without changing the promise's outcome.
            initializing.catch(() => {});
            execution = waitForAbortable(initializing, signal);
          }
          const activeExecution = execution;
          const staged = (async () => {
            try {
              const active = await activeExecution;
              await active.producer.stageBytes({
                bytes,
                outputOrdinal,
                sourcePath,
              });
            } catch (error) {
              stagingFailed = true;
              stageError = error;
              publicationAbort.abort(error);
              throw error;
            }
          })();
          pending.add(staged);
          return staged;
        },
      };
      return {
        complete(result) {
          if (completion) {
            return completion;
          }
          closed = true;
          completion = (async () => {
            if (!execution) {
              if (stagingFailed) {
                observe(() =>
                  options.onFinalized?.(identity, {
                    error: stageError,
                    publications: [],
                    status: "failed",
                  })
                );
              }
              return;
            }
            await Promise.allSettled(pending);
            let finalized: PublicationFinalization;
            try {
              const active = await execution;
              finalized = await active.finalize(result);
              if (stagingFailed) {
                finalized = {
                  error: stageError,
                  publications: [],
                  status: "failed",
                };
              }
            } catch (error) {
              finalized = { error, publications: [], status: "failed" };
            }
            observe(() => options.onFinalized?.(identity, finalized));
          })();
          return completion;
        },
        publisher: createToolArtifactPublisher(producer),
      };
    },
    onError: options.onError,
  };
}
