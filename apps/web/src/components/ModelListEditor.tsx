import type { CustomModelEntry } from "@atlas/core/contract";
import { Add01Icon, Delete02Icon } from "hugeicons-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupInput } from "@/components/ui/input-group";
import { Switch } from "@/components/ui/switch";
import { createClientId, syncRowKeys } from "@/lib/client-id";

export interface ModelListRow extends CustomModelEntry {}

interface ModelListEditorProps {
  browseLabel?: string;
  disabled?: boolean;
  models: ModelListRow[];
  onBrowse?: () => void;
  onChange: (models: ModelListRow[]) => void;
  showPricing?: boolean;
  showThinking?: boolean;
}

function emptyRow(): ModelListRow {
  return { id: "", name: "" };
}

interface ReasoningLevelsInputProps {
  disabled?: boolean;
  modelId?: string;
  onChange: (values: string[] | undefined) => void;
  value?: string[];
}

function ReasoningLevelsInput({
  value,
  onChange,
  disabled,
  modelId,
}: ReasoningLevelsInputProps) {
  const [text, setText] = useState(() => value?.join(", ") ?? "");
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => {
    if (!isFocused) {
      setText(value?.join(", ") ?? "");
    }
  }, [value, isFocused]);

  return (
    <InputGroupInput
      aria-label={`Reasoning levels for ${modelId?.trim() || "model"}`}
      disabled={disabled}
      onBlur={() => {
        setIsFocused(false);
        const parts = text
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const next = parts.length > 0 ? parts : undefined;
        onChange(next);
        setText(next?.join(", ") ?? "");
      }}
      onChange={(event) => {
        const val = event.target.value;
        setText(val);
        const parts = val
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        onChange(parts.length > 0 ? parts : undefined);
      }}
      onFocus={() => setIsFocused(true)}
      placeholder="low, medium, high"
      title="Comma-separated reasoning levels (e.g. low, medium, xhigh)"
      value={text}
    />
  );
}

export function ModelListEditor({
  models,
  disabled,
  showPricing = true,
  showThinking = false,
  onBrowse,
  browseLabel = "Browse models.dev",
  onChange,
}: ModelListEditorProps) {
  const rowKeysRef = useRef<string[]>([]);
  // Keep React keys available on the first paint (avoids undefined keys + useEffect).
  syncRowKeys(rowKeysRef.current, models.length);

  const updateRow = (index: number, patch: Partial<ModelListRow>) => {
    onChange(
      models.map((row, rowIndex) =>
        rowIndex === index ? { ...row, ...patch } : row
      )
    );
  };

  const removeRow = (index: number) => {
    rowKeysRef.current.splice(index, 1);
    onChange(models.filter((_, rowIndex) => rowIndex !== index));
  };

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-lg border border-border">
        <table
          className={`w-full text-left text-xs ${showThinking ? "min-w-[48rem]" : "min-w-[32rem]"}`}
        >
          <thead className="border-border border-b bg-muted/30 text-muted-foreground">
            <tr>
              <th className="px-2 py-2 font-medium">Model ID</th>
              <th className="px-2 py-2 font-medium">Display name</th>
              {showThinking ? (
                <th className="px-2 py-2 font-medium">Reasoning / Levels</th>
              ) : null}
              {showPricing ? (
                <>
                  <th className="px-2 py-2 font-medium">$/1M in</th>
                  <th className="px-2 py-2 font-medium">$/1M out</th>
                </>
              ) : null}
              <th aria-label="Actions" className="w-10 px-2 py-2" />
            </tr>
          </thead>
          <tbody>
            {models.map((row, index) => (
              <tr
                className="border-border/60 border-b last:border-0"
                key={rowKeysRef.current[index]}
              >
                <td className="px-2 py-1.5">
                  <InputGroup>
                    <InputGroupInput
                      disabled={disabled}
                      onChange={(event) =>
                        updateRow(index, { id: event.target.value })
                      }
                      placeholder="llama3.2"
                      value={row.id}
                    />
                  </InputGroup>
                </td>
                <td className="px-2 py-1.5">
                  <InputGroup>
                    <InputGroupInput
                      disabled={disabled}
                      onChange={(event) =>
                        updateRow(index, { name: event.target.value })
                      }
                      placeholder="Optional label"
                      value={row.name ?? ""}
                    />
                  </InputGroup>
                </td>
                {showThinking ? (
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-2">
                      <Switch
                        aria-label={`Reasoning for ${row.id.trim() || "model"}`}
                        checked={row.supportsThinking === true}
                        disabled={disabled}
                        onCheckedChange={(checked) =>
                          updateRow(index, { supportsThinking: checked })
                        }
                        size="sm"
                      />
                      {row.supportsThinking ? (
                        <InputGroup className="w-44">
                          <ReasoningLevelsInput
                            disabled={disabled}
                            modelId={row.id}
                            onChange={(reasoningEffortValues) =>
                              updateRow(index, { reasoningEffortValues })
                            }
                            value={row.reasoningEffortValues}
                          />
                        </InputGroup>
                      ) : null}
                    </div>
                  </td>
                ) : null}
                {showPricing ? (
                  <>
                    <td className="px-2 py-1.5">
                      <InputGroup>
                        <InputGroupInput
                          disabled={disabled}
                          min={0}
                          onChange={(event) => {
                            const value = event.target.value;
                            updateRow(index, {
                              inputPerMillionUsd:
                                value === "" ? undefined : Number(value),
                            });
                          }}
                          placeholder="—"
                          step="any"
                          type="number"
                          value={row.inputPerMillionUsd ?? ""}
                        />
                      </InputGroup>
                    </td>
                    <td className="px-2 py-1.5">
                      <InputGroup>
                        <InputGroupInput
                          disabled={disabled}
                          min={0}
                          onChange={(event) => {
                            const value = event.target.value;
                            updateRow(index, {
                              outputPerMillionUsd:
                                value === "" ? undefined : Number(value),
                            });
                          }}
                          placeholder="—"
                          step="any"
                          type="number"
                          value={row.outputPerMillionUsd ?? ""}
                        />
                      </InputGroup>
                    </td>
                  </>
                ) : null}
                <td className="px-2 py-1.5 text-right">
                  <Button
                    aria-label="Remove model"
                    disabled={disabled || models.length <= 1}
                    onClick={() => removeRow(index)}
                    size="icon-sm"
                    type="button"
                    variant="ghost"
                  >
                    <Delete02Icon className="size-4" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          disabled={disabled}
          onClick={() => {
            rowKeysRef.current.push(createClientId());
            onChange([...models, emptyRow()]);
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          <Add01Icon className="mr-1 size-4" />
          Add model
        </Button>

        {onBrowse ? (
          <Button
            disabled={disabled}
            onClick={onBrowse}
            size="sm"
            type="button"
            variant="secondary"
          >
            {browseLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
