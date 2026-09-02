import { Download04Icon } from "hugeicons-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

export function ExportProfileButton({
  className,
  disabled,
  onExport,
  pending,
  profileId,
}: {
  className?: string;
  disabled?: boolean;
  onExport: (profileId: string) => void | Promise<void>;
  pending: boolean;
  profileId: string;
}) {
  return (
    <Button
      aria-label="Export profile"
      className={className}
      disabled={disabled || pending}
      onClick={() => {
        void onExport(profileId);
      }}
      size="sm"
      type="button"
      variant="outline"
    >
      {pending ? (
        <Spinner className="size-3.5" />
      ) : (
        <Download04Icon aria-hidden className="size-3.5" />
      )}
      <span>Export</span>
    </Button>
  );
}
