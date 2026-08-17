import { prepareSvgPreview } from "@/lib/artifact-svg-preview";

export function SvgPreview({
  content,
  filename,
  className = "max-h-[min(70vh,48rem)] max-w-full object-contain",
}: {
  content: string;
  filename: string;
  className?: string;
}) {
  const result = prepareSvgPreview(content);

  if (result.status === "too_large") {
    return (
      <p className="p-4 text-muted-foreground text-sm">
        This SVG is too large to preview.
      </p>
    );
  }

  if (result.status !== "ok") {
    return (
      <p className="p-4 text-muted-foreground text-sm">
        This SVG couldn&apos;t be previewed.
      </p>
    );
  }

  return <img alt={filename} className={className} src={result.dataUrl} />;
}
