import { Download04Icon } from "hugeicons-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useExportProfilePack } from "@/hooks/use-profile-pack";
import { formatError } from "@/lib/client";
import { downloadArchive } from "@/lib/download-archive";
import { toast } from "@/lib/toast";

export function ExportProfileButton({
  disabled,
  profileId,
}: {
  disabled?: boolean;
  profileId: string;
}) {
  const mutation = useExportProfilePack();

  const handleExport = async (): Promise<void> => {
    try {
      const result = await mutation.mutateAsync(profileId);
      downloadArchive(result.filename, result.data);
      toast("Profile pack downloaded.");
    } catch (error) {
      toast(formatError(error));
    }
  };

  return (
    <Button
      aria-label="Export profile"
      disabled={disabled || mutation.isPending}
      onClick={() => {
        void handleExport();
      }}
      size="sm"
      type="button"
      variant="outline"
    >
      {mutation.isPending ? (
        <Spinner className="size-3.5" />
      ) : (
        <Download04Icon aria-hidden className="size-3.5" />
      )}
      <span>Export</span>
    </Button>
  );
}
