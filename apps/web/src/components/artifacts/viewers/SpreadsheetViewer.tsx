import type { SpreadsheetPreview } from "@atlas/core";
import { Search01Icon } from "hugeicons-react";
import { useMemo, useState } from "react";

function columnNumberToLetter(colIndex: number): string {
  let temp = colIndex;
  let letter = "";
  while (temp >= 0) {
    letter = String.fromCharCode((temp % 26) + 65) + letter;
    temp = Math.floor(temp / 26) - 1;
  }
  return letter;
}

export function SpreadsheetViewer({
  preview,
  onSelectSheet,
}: {
  preview: SpreadsheetPreview;
  downloadUrl: string;
  onSelectSheet?: (sheetName: string, sheetIndex: number) => void;
}) {
  const activeSheet = preview.activeSheet;
  const data = activeSheet?.data || [];
  const [selectedCell, setSelectedCell] = useState<{
    col: number;
    row: number;
  }>({
    col: 0,
    row: 0,
  });
  const [filterQuery, setFilterQuery] = useState("");

  const maxCols = Math.max(
    activeSheet?.columnCount || 0,
    ...data.map((r) => r.length),
    1
  );

  const filteredRowIndices = useMemo(() => {
    if (!filterQuery.trim()) {
      return data.map((_, idx) => idx);
    }
    const q = filterQuery.toLowerCase();
    const indices: number[] = [];
    data.forEach((row, idx) => {
      const match = row.some((cell) =>
        String(cell ?? "")
          .toLowerCase()
          .includes(q)
      );
      if (match) {
        indices.push(idx);
      }
    });
    return indices;
  }, [data, filterQuery]);

  const selectedValue =
    data[selectedCell.row]?.[selectedCell.col] === undefined
      ? ""
      : String(data[selectedCell.row][selectedCell.col] ?? "");

  const selectedCellName = `${columnNumberToLetter(selectedCell.col)}${selectedCell.row + 1}`;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      {/* Top Toolbar & Formula Bar */}
      <div className="flex items-center gap-2 border-border border-b px-3 py-1.5 font-mono text-xs">
        <div className="flex h-6 min-w-12 items-center justify-center rounded border border-border bg-muted/40 px-2 font-medium text-foreground">
          {selectedCellName}
        </div>
        <div className="h-4 w-px bg-border" />
        <span className="shrink-0 text-muted-foreground">fx</span>
        <div className="min-w-0 flex-1 truncate text-foreground">
          {selectedValue || (
            <span className="text-muted-foreground/50">Empty</span>
          )}
        </div>
        <div className="relative">
          <Search01Icon className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            className="h-7 w-36 rounded-md border border-border bg-background pr-2 pl-7 text-foreground text-xs placeholder:text-muted-foreground focus:outline-hidden focus:ring-1 focus:ring-ring"
            onChange={(e) => setFilterQuery(e.target.value)}
            placeholder="Search"
            type="text"
            value={filterQuery}
          />
        </div>
      </div>

      {/* Grid Container */}
      <div className="min-h-0 flex-1 overflow-auto bg-card/40">
        <table className="w-full border-collapse text-left font-sans text-xs">
          {/* Header Row (Column Letters) */}
          <thead className="sticky top-0 z-10 bg-muted/90 backdrop-blur-xs">
            <tr>
              <th className="sticky left-0 z-20 w-12 border-border border-r border-b bg-muted/95 p-1.5 text-center font-bold text-[10px] text-muted-foreground uppercase">
                #
              </th>
              {Array.from({ length: maxCols }).map((_, c) => {
                const colLetter = columnNumberToLetter(c);
                const isSelectedCol = selectedCell.col === c;
                return (
                  <th
                    className={`min-w-28 border-border border-r border-b px-3 py-1.5 text-center font-medium text-xs ${
                      isSelectedCol
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground"
                    }`}
                    key={colLetter}
                  >
                    {colLetter}
                  </th>
                );
              })}
            </tr>
          </thead>

          {/* Grid Rows */}
          <tbody>
            {filteredRowIndices.length === 0 ? (
              <tr>
                <td
                  className="py-12 text-center text-muted-foreground"
                  colSpan={maxCols + 1}
                >
                  No matching cells found.
                </td>
              </tr>
            ) : (
              filteredRowIndices.map((rIdx) => {
                const row = data[rIdx] || [];
                const isSelectedRow = selectedCell.row === rIdx;

                return (
                  <tr
                    className={`border-border/40 border-b ${
                      isSelectedRow ? "bg-muted/40" : "hover:bg-muted/30"
                    }`}
                    key={`row-${rIdx}`}
                  >
                    {/* Row Number Header */}
                    <td
                      className={`sticky left-0 z-10 w-12 select-none border-border border-r p-1.5 text-center font-medium text-[11px] tabular-nums ${
                        isSelectedRow
                          ? "bg-muted text-foreground"
                          : "bg-muted/80 text-muted-foreground"
                      }`}
                    >
                      {rIdx + 1}
                    </td>

                    {/* Cells */}
                    {Array.from({ length: maxCols }).map((_, cIdx) => {
                      const cellVal = row[cIdx];
                      const isSelected =
                        selectedCell.row === rIdx && selectedCell.col === cIdx;
                      const cellFormatKey = `${rIdx}:${cIdx}`;
                      const format = activeSheet?.cellFormats?.[cellFormatKey];

                      let alignClass = "text-left";
                      if (
                        typeof cellVal === "number" ||
                        format?.align === "right"
                      ) {
                        alignClass = "text-right";
                      } else if (
                        typeof cellVal === "boolean" ||
                        format?.align === "center"
                      ) {
                        alignClass = "text-center";
                      }

                      let displayVal =
                        cellVal !== null && cellVal !== undefined
                          ? String(cellVal)
                          : "";
                      if (
                        typeof cellVal === "number" &&
                        format?.type === "currency"
                      ) {
                        displayVal = `$${cellVal.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
                      }

                      return (
                        <td
                          className={`min-w-28 cursor-pointer border-border/60 border-r px-3 py-1.5 tabular-nums transition-all ${alignClass} ${
                            format?.bold
                              ? "font-bold text-foreground"
                              : "text-foreground/90"
                          } ${
                            isSelected
                              ? "bg-muted outline outline-1 outline-foreground/20 outline-offset-[-1px]"
                              : ""
                          }`}
                          key={`cell-${rIdx}-${cIdx}`}
                          onClick={() =>
                            setSelectedCell({ col: cIdx, row: rIdx })
                          }
                        >
                          <span className="block truncate">{displayVal}</span>
                        </td>
                      );
                    })}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Bottom Sheet Tabs Bar */}
      {preview.sheetNames && preview.sheetNames.length > 0 ? (
        <div className="flex items-center gap-1 overflow-x-auto border-border border-t px-2 py-1">
          {preview.sheetNames.map((sheetName, sIdx) => {
            const isActive = sIdx === (preview.activeSheetIndex ?? 0);
            return (
              <button
                className={`rounded-md px-2.5 py-1 font-medium text-xs ${
                  isActive
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                }`}
                key={sheetName}
                onClick={() => onSelectSheet?.(sheetName, sIdx)}
                type="button"
              >
                {sheetName}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
