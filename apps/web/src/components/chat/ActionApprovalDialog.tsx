import type { ApprovalRequest } from "@atlas/core";
import {
  AlertCircleIcon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
} from "hugeicons-react";

import { useState } from "react";

export function ActionApprovalDialog({
  approval,
  onConfirm,
  onCancel,
}: {
  approval: ApprovalRequest;
  onConfirm?: (approval: ApprovalRequest) => void;
  onCancel?: (approval: ApprovalRequest) => void;
}) {
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleConfirm = () => {
    if (isSubmitting || approval.status !== "pending") {
      return;
    }
    setIsSubmitting(true);
    onConfirm?.(approval);
  };

  const handleCancel = () => {
    if (isSubmitting || approval.status !== "pending") {
      return;
    }
    setIsSubmitting(true);
    onCancel?.(approval);
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
            <div className="mt-2 space-y-1 rounded-md bg-muted/40 p-2 font-mono text-[11px] text-muted-foreground">
              {Object.entries(approval.details).map(([k, v]) => (
                <div className="flex items-center justify-between" key={k}>
                  <span className="font-medium text-foreground/80">{k}:</span>
                  <span className="max-w-[200px] truncate">{String(v)}</span>
                </div>
              ))}
            </div>
          ) : null}

          {approval.status === "pending" ? (
            <div className="flex items-center gap-2 pt-2">
              <button
                className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 font-semibold text-primary-foreground text-xs shadow-xs transition-colors hover:bg-primary/90 disabled:opacity-50"
                disabled={isSubmitting}
                onClick={handleConfirm}
                type="button"
              >
                <CheckmarkCircle02Icon className="size-3.5" />
                {isSubmitting ? "Confirming..." : "Confirm"}
              </button>
              <button
                className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background px-3 py-1.5 font-medium text-xs transition-colors hover:bg-accent disabled:opacity-50"
                disabled={isSubmitting}
                onClick={handleCancel}
                type="button"
              >
                <Cancel01Icon className="size-3.5" />
                Cancel
              </button>
            </div>
          ) : (
            <div className="pt-2 font-medium text-muted-foreground text-xs">
              Status: <span className="capitalize">{approval.status}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
