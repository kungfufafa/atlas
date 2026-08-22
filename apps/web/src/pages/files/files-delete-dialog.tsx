import type { ArtifactFile } from "@atlas/core/contract";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";

export function FilesDeleteDialog({
  deleteTarget,
  deletePending,
  deleteError = null,
  onClose,
  onConfirm,
}: {
  deleteTarget: ArtifactFile | null;
  deletePending: boolean;
  deleteError?: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!(open || deletePending)) {
          onClose();
        }
      }}
      open={deleteTarget !== null}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete artifact</DialogTitle>
          <DialogDescription>
            Remove {deleteTarget?.filename} from this profile?
          </DialogDescription>
        </DialogHeader>
        {deleteError ? (
          <p className="text-destructive text-sm">{deleteError}</p>
        ) : null}
        <DialogFooter>
          <Button
            disabled={deletePending}
            onClick={onClose}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={deletePending}
            onClick={onConfirm}
            type="button"
            variant="destructive"
          >
            {deletePending ? <Spinner className="size-4" /> : null}
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
