import type { ProfilePackPreviewResponse } from "@atlas/core/contract";
import { Upload04Icon } from "hugeicons-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { formatDataPortabilityBytes } from "@/hooks/use-data-portability";
import {
  useImportProfilePack,
  usePreviewProfilePack,
} from "@/hooks/use-profile-pack";
import { formatError } from "@/lib/client";
import { toast } from "@/lib/toast";

const MAX_PROFILE_PACK_BYTES = 25 * 1024 * 1024;

export function ProfileImportDialog({
  onImported,
  onOpenChange,
  open,
}: {
  onImported: (profileId: string) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<ProfilePackPreviewResponse | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const previewMutation = usePreviewProfilePack();
  const importMutation = useImportProfilePack();
  const pending = previewMutation.isPending || importMutation.isPending;

  const reset = (): void => {
    setFile(null);
    setName("");
    setPreview(null);
    setError(null);
    if (inputRef.current) {
      inputRef.current.value = "";
    }
  };

  const handleFile = async (selected: File | null): Promise<void> => {
    reset();
    if (!selected) {
      return;
    }
    setFile(selected);
    if (selected.size > MAX_PROFILE_PACK_BYTES) {
      setError("Profile pack must be 25 MB or smaller.");
      return;
    }
    try {
      const result = await previewMutation.mutateAsync(selected);
      setPreview(result);
      setName(result.plannedName);
    } catch (cause) {
      setError(formatError(cause));
    }
  };

  const handleImport = async (): Promise<void> => {
    if (!(file && preview && name.trim())) {
      return;
    }
    setError(null);
    try {
      const result = await importMutation.mutateAsync({
        file,
        name: name.trim(),
      });
      toast("Profile imported.");
      onImported(result.profileId);
      reset();
      onOpenChange(false);
    } catch (cause) {
      setError(formatError(cause));
    }
  };

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (pending) {
          return;
        }
        if (!nextOpen) {
          reset();
        }
        onOpenChange(nextOpen);
      }}
      open={open}
    >
      <DialogContent className="gap-5 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import profile</DialogTitle>
          <DialogDescription>
            Creates a new standard profile. Provider keys and connection secrets
            are never imported; assignments reconnect only to matching resources
            in this organization.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <Button
              disabled={pending}
              onClick={() => inputRef.current?.click()}
              type="button"
              variant="outline"
            >
              {previewMutation.isPending ? (
                <Spinner className="size-4" />
              ) : (
                <Upload04Icon aria-hidden className="size-4" />
              )}
              Choose ZIP
            </Button>
            <span className="min-w-0 truncate text-muted-foreground text-sm">
              {file?.name ?? "No file selected"}
            </span>
            <input
              accept=".zip,application/zip"
              aria-label="Choose profile pack"
              className="sr-only"
              disabled={pending}
              onChange={(event) => {
                void handleFile(event.target.files?.[0] ?? null);
              }}
              ref={inputRef}
              type="file"
            />
          </div>

          {preview ? (
            <>
              <div>
                <label
                  className="mb-1 block font-medium text-sm"
                  htmlFor="profile-pack-name"
                >
                  Profile name
                </label>
                <Input
                  id="profile-pack-name"
                  maxLength={120}
                  onChange={(event) => setName(event.target.value)}
                  value={name}
                />
              </div>
              <div className="rounded-md border px-3 py-2 text-sm">
                <p>
                  {preview.archiveFileCount} files ·{" "}
                  {formatDataPortabilityBytes(preview.archiveTotalBytes)}
                </p>
                {preview.skippedAssignments.length > 0 ? (
                  <p className="mt-1 text-amber-700 dark:text-amber-400">
                    {preview.skippedAssignments.length} assignments or settings
                    will be skipped.
                  </p>
                ) : null}
              </div>
            </>
          ) : null}

          {error ? (
            <p className="text-destructive text-sm" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            disabled={pending}
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={pending || !preview || !name.trim()}
            onClick={() => {
              void handleImport();
            }}
            type="button"
          >
            {importMutation.isPending ? <Spinner className="size-4" /> : null}
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
