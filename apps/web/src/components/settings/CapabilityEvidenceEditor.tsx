import type {
  ProviderInstanceSummary,
  UpdateProviderRequest,
} from "@atlas/core/contract";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { useCapabilityCatalog } from "@/hooks/use-capability-routing";
import {
  buildCapabilityEvidencePatch,
  type CapabilityEvidenceSelection,
  capabilityEvidenceSelectionIsDisabled,
  capabilityEvidenceSelections,
  capabilityEvidenceSettingLabel,
  INHERIT_CAPABILITY_EVIDENCE,
  listProviderCapabilityEvidenceRows,
} from "@/lib/capability-evidence";
import { formatError } from "@/lib/client";

export function CapabilityEvidenceEditor({
  busy,
  dialogError,
  instance,
  onOpenChange,
  onSave,
  open,
}: {
  busy: boolean;
  dialogError: string | null;
  instance: ProviderInstanceSummary;
  onOpenChange: (open: boolean) => void;
  onSave: (
    capabilityOverrides: NonNullable<
      UpdateProviderRequest["capabilityOverrides"]
    >
  ) => Promise<void>;
  open: boolean;
}) {
  const catalogQuery = useCapabilityCatalog();
  const rows = useMemo(
    () =>
      catalogQuery.data
        ? listProviderCapabilityEvidenceRows(catalogQuery.data, instance.type)
        : [],
    [catalogQuery.data, instance.type]
  );
  const initialSelections = useMemo(
    () => capabilityEvidenceSelections(rows, instance),
    [instance, rows]
  );
  const [original, setOriginal] = useState(initialSelections);
  const [selections, setSelections] = useState(initialSelections);

  useEffect(() => {
    if (open) {
      setOriginal(initialSelections);
      setSelections(initialSelections);
    }
  }, [initialSelections, open]);

  const patch = buildCapabilityEvidencePatch(rows, original, selections);
  const hasChanges = Object.keys(patch).length > 0;
  const queryError = catalogQuery.error
    ? formatError(catalogQuery.error)
    : null;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Capability evidence for {instance.label}</DialogTitle>
          <DialogDescription>
            Overrides apply to every configured model for this provider.
            Supported requires every model to be verified; Unknown and
            Unsupported block requests. Provider default restores Atlas
            evidence, and an unavailable adapter cannot be enabled here.
          </DialogDescription>
        </DialogHeader>

        {catalogQuery.isLoading ? (
          <div className="flex min-h-24 items-center justify-center">
            <Spinner />
          </div>
        ) : rows.length ? (
          <div className="divide-y divide-border rounded-lg border">
            {rows.map((row) => (
              <div className="space-y-2 px-3 py-2.5" key={row.capabilityId}>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium text-sm">
                      {row.label}
                    </span>
                    <span className="shrink-0 text-muted-foreground text-xs">
                      Setting:{" "}
                      {capabilityEvidenceSettingLabel(
                        selections[row.capabilityId] ??
                          INHERIT_CAPABILITY_EVIDENCE
                      )}
                    </span>
                  </div>
                  <Select
                    disabled={busy}
                    onValueChange={(value) =>
                      setSelections((current) => ({
                        ...current,
                        [row.capabilityId]:
                          value as CapabilityEvidenceSelection,
                      }))
                    }
                    value={
                      selections[row.capabilityId] ??
                      INHERIT_CAPABILITY_EVIDENCE
                    }
                  >
                    <SelectTrigger
                      aria-label={`${row.label} evidence`}
                      className="w-full sm:w-48"
                      size="sm"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={INHERIT_CAPABILITY_EVIDENCE}>
                        Provider default
                      </SelectItem>
                      <SelectItem
                        disabled={capabilityEvidenceSelectionIsDisabled(
                          row,
                          "supported"
                        )}
                        value="supported"
                      >
                        Supported
                      </SelectItem>
                      <SelectItem value="unsupported">Unsupported</SelectItem>
                      <SelectItem value="unknown">
                        Unknown (fail closed)
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {row.implementationAvailable ? null : (
                  <p className="text-muted-foreground text-xs">
                    Atlas has no adapter for this capability, so Supported is
                    unavailable.
                  </p>
                )}
              </div>
            ))}
          </div>
        ) : queryError ? null : (
          <p className="text-muted-foreground text-sm">
            No capability evidence is available for this provider.
          </p>
        )}

        {dialogError || queryError ? (
          <p className="text-destructive text-sm" role="alert">
            {dialogError ?? queryError}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            disabled={busy}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={busy || !hasChanges}
            onClick={() => void onSave(patch)}
            type="button"
          >
            {busy ? <Spinner className="mr-2" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
