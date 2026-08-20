import {
  ArrowExpand01Icon,
  ArrowShrink02Icon,
  CheckmarkCircle01Icon,
  Copy01Icon,
  Download01Icon,
} from "hugeicons-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button-variants";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function ArtifactAttachmentPanelActions({
  copied,
  loading,
  content,
  copyDisabled = false,
  fullscreen,
  downloadUrl,
  filename,
  onCopy,
  onToggleFullscreen,
  extraActions,
}: {
  copied: boolean;
  loading: boolean;
  content: string | null;
  copyDisabled?: boolean;
  fullscreen: boolean;
  downloadUrl: string;
  filename: string;
  onCopy: () => void;
  onToggleFullscreen: () => void;
  extraActions?: ReactNode;
}) {
  const copyLabel = copied ? "Copied" : "Copy";
  const fullscreenLabel = fullscreen ? "Exit fullscreen" : "Fullscreen";

  return (
    <>
      {copyDisabled ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={copyLabel}
                disabled={loading && !content}
                onClick={onCopy}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                {copied ? (
                  <CheckmarkCircle01Icon
                    aria-hidden
                    className="size-4 text-emerald-600 dark:text-emerald-400"
                  />
                ) : (
                  <Copy01Icon aria-hidden className="size-4" />
                )}
              </Button>
            }
          />
          <TooltipContent side="bottom" sideOffset={6}>
            {copyLabel}
          </TooltipContent>
        </Tooltip>
      )}

      <Tooltip>
        <TooltipTrigger
          render={
            <a
              aria-label="Download"
              className={cn(
                buttonVariants({ size: "icon-sm", variant: "ghost" })
              )}
              download={filename}
              href={downloadUrl}
              rel="noopener"
            >
              <Download01Icon aria-hidden className="size-4" />
            </a>
          }
        />
        <TooltipContent side="bottom" sideOffset={6}>
          Download
        </TooltipContent>
      </Tooltip>

      {extraActions}

      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label={fullscreenLabel}
              onClick={onToggleFullscreen}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              {fullscreen ? (
                <ArrowShrink02Icon aria-hidden className="size-4" />
              ) : (
                <ArrowExpand01Icon aria-hidden className="size-4" />
              )}
            </Button>
          }
        />
        <TooltipContent side="bottom" sideOffset={6}>
          {fullscreenLabel}
        </TooltipContent>
      </Tooltip>
    </>
  );
}
