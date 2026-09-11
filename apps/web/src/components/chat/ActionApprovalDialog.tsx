import type { ApprovalRequest } from "@atlas/core/contract";
import {
  AlertCircleIcon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
} from "hugeicons-react";

import { useRef, useState } from "react";

interface ActionApprovalDialogProps {
  approval: ApprovalRequest;
  onCancel?: (approval: ApprovalRequest) => Promise<void>;
  onConfirm?: (approval: ApprovalRequest) => Promise<void>;
}

export function ActionApprovalDialog(props: ActionApprovalDialogProps) {
  // Each approval owns its state, including when a stream reuses this position.
  return <ActionApprovalCard key={props.approval.id} {...props} />;
}

function ActionApprovalCard({
  approval,
  onConfirm,
  onCancel,
}: ActionApprovalDialogProps) {
  const submitting = useRef(false);
  const [submission, setSubmission] = useState<"approved" | "denied" | null>(
    null
  );
  const [decided, setDecided] = useState<"approved" | "denied" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status =
    approval.status === "pending"
      ? (decided ?? approval.status)
      : approval.status;
  const isSubmitting = submission !== null;

  const submit = async (decision: "approved" | "denied") => {
    const callback = decision === "approved" ? onConfirm : onCancel;
    if (submitting.current || status !== "pending" || !callback) {
      return;
    }
    submitting.current = true;
    setSubmission(decision);
    setError(null);
    try {
      await callback(approval);
      setDecided(decision);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not save the approval. Try again."
      );
    } finally {
      submitting.current = false;
      setSubmission(null);
    }
  };

  return (
    <div className="fade-in-50 my-3 animate-in rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 shadow-sm backdrop-blur-sm">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
          <AlertCircleIcon className="size-5" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <h4 className="font-semibold text-foreground text-sm">
            {approval.title}
          </h4>
          <p className="text-muted-foreground text-xs leading-relaxed">
            {approval.consequenceSummary}
          </p>

          {approval.details && Object.keys(approval.details).length > 0 ? (
            <dl className="mt-2 max-h-64 space-y-2 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-[11px] text-muted-foreground">
              {Object.entries(approval.details).map(([k, v]) => (
                <div key={k}>
                  <dt className="font-medium text-foreground/80">{k}:</dt>
                  <dd className="whitespace-pre-wrap break-words">
                    {typeof v === "string" ? v : JSON.stringify(v, null, 2)}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
          {error ? (
            <p className="text-destructive text-xs" role="alert">
              {error}
            </p>
          ) : null}

          {status === "pending" ? (
            <div className="flex items-center gap-2 pt-2">
              <button
                className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 font-semibold text-primary-foreground text-xs shadow-xs transition-colors hover:bg-primary/90 disabled:opacity-50"
                disabled={isSubmitting || !onConfirm}
                onClick={() => {
                  void submit("approved");
                }}
                type="button"
              >
                <CheckmarkCircle02Icon className="size-3.5" />
                {submission === "approved" ? "Confirming..." : "Confirm"}
              </button>
              <button
                className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background px-3 py-1.5 font-medium text-xs transition-colors hover:bg-accent disabled:opacity-50"
                disabled={isSubmitting || !onCancel}
                onClick={() => {
                  void submit("denied");
                }}
                type="button"
              >
                <Cancel01Icon className="size-3.5" />
                {submission === "denied" ? "Cancelling..." : "Cancel"}
              </button>
            </div>
          ) : (
            <div className="pt-2 font-medium text-muted-foreground text-xs">
              Status: <span className="capitalize">{status}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
