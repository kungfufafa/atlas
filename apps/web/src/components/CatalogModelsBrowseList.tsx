import { type ReactNode, useDeferredValue, useMemo, useState } from "react";
import {
  BrowseModelRowButton,
  type BrowseModelRowDisplay,
  ModelBrowseShell,
  VirtualModelBrowseList,
} from "@/components/ModelBrowseShell";
import { filterRowsBySearch } from "@/components/model-browse-utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface CatalogModelsBrowseQuery {
  canFetch?: boolean;
  error?: Error | null;
  isFetching?: boolean;
  isLoading?: boolean;
  onRefresh?: () => void;
  refreshDisabled?: boolean;
}

export interface CatalogModelsBrowseListProps<
  T extends { id: string; name: string },
> {
  className?: string;
  disabled?: boolean;
  emptyMessage?: string;
  filterRows?: (rows: T[], search: string, hideDeprecated: boolean) => T[];
  idleMessage?: string;
  isDeprecated?: (row: T) => boolean;
  multiSelect?: boolean;
  onAddMany?: (rows: T[]) => void;
  onSelect: (row: T) => void;
  query?: CatalogModelsBrowseQuery;
  rows: T[];
  selectedIds?: ReadonlySet<string>;
  status?:
    | ReactNode
    | ((context: { filteredCount: number; filteredRows: T[] }) => ReactNode);
  toDisplayRow?: (row: T) => BrowseModelRowDisplay;
  toolbarTrailing?: ReactNode;
}

export function CatalogModelsBrowseList<
  T extends { id: string; name: string },
>({
  rows,
  onSelect,
  selectedIds,
  className,
  query,
  idleMessage,
  emptyMessage,
  status,
  toDisplayRow = (row) => ({ id: row.id, name: row.name }),
  filterRows,
  isDeprecated,
  toolbarTrailing,
  multiSelect = false,
  onAddMany,
  disabled = false,
}: CatalogModelsBrowseListProps<T>) {
  const {
    canFetch = true,
    isLoading = false,
    isFetching = false,
    error = null,
    onRefresh,
    refreshDisabled = false,
  } = query ?? {};
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [hideDeprecated, setHideDeprecated] = useState(true);
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const showDeprecatedFilter = Boolean(isDeprecated);

  const pendingRowIds = useMemo(() => {
    if (!multiSelect) {
      return new Set<string>();
    }

    const rowIds = new Set(rows.map((row) => row.id));
    return new Set([...pendingIds].filter((id) => rowIds.has(id)));
  }, [multiSelect, pendingIds, rows]);

  const filtered = useMemo(() => {
    if (filterRows) {
      return filterRows(rows, deferredSearch, hideDeprecated);
    }

    let result = rows;
    if (showDeprecatedFilter && hideDeprecated) {
      result = result.filter((row) => !isDeprecated!(row));
    }

    return filterRowsBySearch(result, deferredSearch);
  }, [
    rows,
    deferredSearch,
    hideDeprecated,
    filterRows,
    isDeprecated,
    showDeprecatedFilter,
  ]);

  const resolvedStatus =
    typeof status === "function"
      ? status({ filteredCount: filtered.length, filteredRows: filtered })
      : (status ??
        (canFetch
          ? `${filtered.length} model${filtered.length === 1 ? "" : "s"}`
          : (idleMessage ?? "Enter credentials to browse models.")));

  const resolvedEmptyMessage =
    emptyMessage ??
    (canFetch
      ? "No models found."
      : (idleMessage ?? "Enter credentials to browse models."));

  const toolbarDisabled = disabled || !canFetch;

  const handleRowSelect = (row: T) => {
    if (disabled) {
      return;
    }
    if (!multiSelect) {
      onSelect(row);
      return;
    }

    if (selectedIds?.has(row.id)) {
      return;
    }

    setPendingIds((current) => {
      const next = new Set(current);
      if (next.has(row.id)) {
        next.delete(row.id);
      } else {
        next.add(row.id);
      }
      return next;
    });
  };

  const handleAddMany = () => {
    if (disabled) {
      return;
    }
    onAddMany?.(rows.filter((row) => pendingRowIds.has(row.id)));
    setPendingIds(new Set());
  };

  return (
    <ModelBrowseShell
      className={className}
      emptyMessage={resolvedEmptyMessage}
      error={canFetch ? error : null}
      footer={
        multiSelect ? (
          <div className="sticky bottom-0 flex shrink-0 justify-end border-border border-t bg-background px-3 py-2">
            <Button
              disabled={disabled || pendingRowIds.size === 0}
              onClick={handleAddMany}
              size="sm"
              type="button"
            >
              Add {pendingRowIds.size}{" "}
              {pendingRowIds.size === 1 ? "model" : "models"}
            </Button>
          </div>
        ) : undefined
      }
      isEmpty={!canFetch || filtered.length === 0}
      isLoading={canFetch && (isLoading || (isFetching && rows.length === 0))}
      status={
        onRefresh ? (
          <div className="flex items-center justify-between gap-2">
            <span>{resolvedStatus}</span>
            <button
              className="text-foreground underline-offset-2 hover:underline disabled:opacity-50"
              disabled={toolbarDisabled || refreshDisabled || isFetching}
              onClick={onRefresh}
              type="button"
            >
              Refresh
            </button>
          </div>
        ) : (
          resolvedStatus
        )
      }
      toolbar={
        <>
          <Input
            className="min-w-35 flex-1"
            disabled={toolbarDisabled}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search model name or ID..."
            value={search}
          />
          {toolbarTrailing}
          {showDeprecatedFilter ? (
            <label className="flex h-8 cursor-pointer items-center gap-2 text-foreground text-sm">
              <input
                checked={hideDeprecated}
                className="size-4 rounded border-input"
                disabled={toolbarDisabled}
                onChange={(event) => setHideDeprecated(event.target.checked)}
                type="checkbox"
              />
              Hide deprecated
            </label>
          ) : null}
        </>
      }
    >
      <VirtualModelBrowseList
        getKey={(row) => row.id}
        renderRow={(row, style) => (
          <BrowseModelRowButton
            disabled={disabled}
            onSelect={() => handleRowSelect(row)}
            row={toDisplayRow(row)}
            selectable={multiSelect}
            selected={
              pendingRowIds.has(row.id) || selectedIds?.has(row.id) === true
            }
            style={style}
          />
        )}
        rows={filtered}
      />
    </ModelBrowseShell>
  );
}
