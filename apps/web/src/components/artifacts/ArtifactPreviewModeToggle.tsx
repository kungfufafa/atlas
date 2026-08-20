import { cn } from "@/lib/utils";

export type ArtifactPreviewMode = "preview" | "code";

export function ArtifactPreviewModeToggle({
  mode,
  onChange,
}: {
  mode: ArtifactPreviewMode;
  onChange: (mode: ArtifactPreviewMode) => void;
}) {
  return (
    <div
      className="inline-flex h-7 shrink-0 items-center rounded-md bg-muted p-0.5"
      role="tablist"
    >
      {(["preview", "code"] as const).map((value) => (
        <button
          aria-selected={mode === value}
          className={cn(
            "h-6 rounded px-2.5 font-medium text-xs transition-colors",
            mode === value
              ? "bg-background text-foreground shadow-xs"
              : "text-muted-foreground hover:text-foreground"
          )}
          key={value}
          onClick={() => onChange(value)}
          role="tab"
          type="button"
        >
          {value === "preview" ? "Preview" : "Code"}
        </button>
      ))}
    </div>
  );
}
