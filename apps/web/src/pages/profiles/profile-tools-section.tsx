import type { ProfileDetail, ToolSummary } from "@atlas/core/contract";
import { BUILTIN_TOOL_IDS } from "@atlas/core/tools/protected";
import { Search01Icon } from "hugeicons-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { EmailSettingsDialog } from "@/components/EmailSettingsDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/context/use-auth";
import { canUseToolPlayground, toolPlaygroundPath } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { buildProfileToolAssignmentRows } from "@/pages/profiles/profile-tools-section.shared";

const toolSearchThreshold = 4;

export function ProfileToolsSection({
  detail,
  busy,
  tools,
  toolsLoadFailed,
  toolsLoading,
  onAssignmentChange,
}: {
  detail: ProfileDetail;
  busy: boolean;
  tools: ToolSummary[];
  toolsLoadFailed: boolean;
  toolsLoading: boolean;
  onAssignmentChange: (
    toolId: string,
    assigned: boolean
  ) => void | Promise<void>;
}) {
  const { user, activeOrg } = useAuth();
  const canManageWorkspace =
    user?.isPlatformAdmin === true || activeOrg?.role === "admin";
  const canOpenPlayground = canUseToolPlayground(
    user?.isPlatformAdmin === true,
    activeOrg?.role
  );
  const [emailConfigOpen, setEmailConfigOpen] = useState(false);
  const [query, setQuery] = useState("");
  const allRows = useMemo(
    () => buildProfileToolAssignmentRows(tools, detail.tools, ""),
    [detail.tools, tools]
  );
  const rows = useMemo(
    () => buildProfileToolAssignmentRows(tools, detail.tools, query),
    [detail.tools, query, tools]
  );
  const trimmedQuery = query.trim();
  const showSearch =
    allRows.length >= toolSearchThreshold || trimmedQuery.length > 0;
  const assignedCount = allRows.filter(({ assigned }) => assigned).length;
  const catalogUnavailable = toolsLoadFailed || toolsLoading;

  return (
    <div className="pt-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="type-section-title text-balance">Tools</h3>
          {allRows.length > 0 && !catalogUnavailable ? (
            <p className="type-body mt-1 text-xs tabular-nums">
              {assignedCount} of {allRows.length} on
            </p>
          ) : null}
        </div>
      </div>

      {toolsLoading && allRows.length === 0 ? (
        <div className="flex items-center gap-2 text-muted-foreground text-xs">
          <Spinner className="size-3.5" />
          <span>Loading tools…</span>
        </div>
      ) : toolsLoadFailed && allRows.length === 0 ? (
        <p className="type-body text-pretty text-xs" role="alert">
          Could not load tools.
        </p>
      ) : allRows.length === 0 ? (
        <p className="type-body text-pretty text-xs">No tools available.</p>
      ) : (
        <div className="space-y-3">
          {toolsLoadFailed ? (
            <p className="text-muted-foreground text-xs" role="alert">
              Tool catalog unavailable. Showing assigned tools only.
            </p>
          ) : toolsLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-xs">
              <Spinner className="size-3.5" />
              <span>Loading tool catalog…</span>
            </div>
          ) : null}
          {showSearch ? (
            <div className="relative">
              <Search01Icon
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                aria-label="Search profile tools"
                className="h-8 border-border/60 bg-muted/20 pl-8 text-sm shadow-none focus-visible:border-foreground/20 focus-visible:bg-background focus-visible:ring-1 focus-visible:ring-foreground/10 dark:bg-muted/15 dark:focus-visible:bg-background/60"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search tools…"
                value={query}
              />
            </div>
          ) : null}

          {rows.length === 0 ? (
            <p className="text-pretty py-6 text-center text-muted-foreground text-sm">
              No tools match &ldquo;{trimmedQuery}&rdquo;.
            </p>
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
              {rows.map(({ assigned, tool }) => {
                const name = (
                  <p className="truncate font-medium text-foreground text-sm leading-tight">
                    {tool.name}
                  </p>
                );
                const onConfigure =
                  assigned &&
                  canOpenPlayground &&
                  tool.id === BUILTIN_TOOL_IDS.email
                    ? () => setEmailConfigOpen(true)
                    : undefined;

                return (
                  <li
                    className="flex items-center justify-between gap-3 px-3 py-2.5 transition-colors duration-150 ease-out hover:bg-muted/40"
                    key={tool.id}
                  >
                    {assigned && canOpenPlayground ? (
                      <Link
                        aria-label={`Open playground for ${tool.name}`}
                        className={cn(
                          "min-w-0 flex-1 rounded-sm text-left outline-none transition-[text-decoration-color] duration-150 ease-out",
                          "underline decoration-transparent underline-offset-2 hover:decoration-foreground/40",
                          "focus-visible:ring-2 focus-visible:ring-ring/50",
                          busy && "pointer-events-none opacity-50"
                        )}
                        to={toolPlaygroundPath(tool.id, {
                          fromProfileId: detail.id,
                        })}
                      >
                        {name}
                      </Link>
                    ) : (
                      <div className="min-w-0 flex-1">{name}</div>
                    )}
                    <div className="flex shrink-0 items-center gap-2">
                      {onConfigure ? (
                        <Button
                          disabled={busy}
                          onClick={onConfigure}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          Configure
                        </Button>
                      ) : null}
                      <span
                        className={cn(
                          "w-6 text-right font-medium text-xs",
                          assigned
                            ? "text-emerald-700 dark:text-emerald-300"
                            : "text-muted-foreground"
                        )}
                      >
                        {assigned ? "On" : "Off"}
                      </span>
                      <Switch
                        aria-label={`${tool.name} is ${assigned ? "on" : "off"}. Turn ${assigned ? "off" : "on"}`}
                        checked={assigned}
                        disabled={busy || !canManageWorkspace}
                        onCheckedChange={(checked) => {
                          void onAssignmentChange(tool.id, checked);
                        }}
                        size="sm"
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <EmailSettingsDialog
        onOpenChange={setEmailConfigOpen}
        open={emailConfigOpen}
      />
    </div>
  );
}
