import { Delete02Icon } from "hugeicons-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  InputGroup,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Textarea } from "@/components/ui/textarea";

export interface WhatsAppNumbersDialogProps {
  numbers: string[];
  onNumbersChange: (numbers: string[]) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  title: string;
}

function normalizeNumber(input: string): string {
  const digits = input.replace(/\D/g, "");
  if (digits.startsWith("08")) {
    return `628${digits.slice(2)}`;
  }
  return digits;
}

function parseNumbers(input: string): string[] {
  return input
    .split(/[,\s\n]+/)
    .map((num) => normalizeNumber(num))
    .filter((num) => num.length >= 6);
}

export function WhatsAppNumbersDialog({
  open,
  onOpenChange,
  numbers,
  onNumbersChange,
  title,
}: WhatsAppNumbersDialogProps) {
  const [newNumber, setNewNumber] = useState("");
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchDraft, setBatchDraft] = useState("");

  function handleAdd() {
    const normalized = normalizeNumber(newNumber);
    if (!normalized || normalized.length < 6) {
      return;
    }

    if (!numbers.includes(normalized)) {
      onNumbersChange([...numbers, normalized]);
    }
    setNewNumber("");
  }

  function handleRemove(target: string) {
    onNumbersChange(numbers.filter((num) => num !== target));
  }

  function handleBatchImport() {
    const parsed = parseNumbers(batchDraft);
    if (parsed.length > 0) {
      const combined = [...new Set([...numbers, ...parsed])];
      onNumbersChange(combined);
    }
    setBatchDraft("");
    setBatchOpen(false);
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        {batchOpen ? (
          <div className="space-y-3">
            <Textarea
              onChange={(e) => setBatchDraft(e.target.value)}
              placeholder="Paste numbers separated by commas or lines (+62812..., 0811...)"
              rows={5}
              value={batchDraft}
            />
            <div className="flex justify-end gap-2">
              <Button
                onClick={() => setBatchOpen(false)}
                size="sm"
                variant="ghost"
              >
                Cancel
              </Button>
              <Button onClick={handleBatchImport} size="sm">
                Add numbers
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex gap-2">
              <InputGroup className="flex-1">
                <InputGroupInput
                  onChange={(e) => setNewNumber(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAdd();
                    }
                  }}
                  placeholder="Enter phone number (+62812...)"
                  value={newNumber}
                />
                <InputGroupButton onClick={handleAdd} size="sm">
                  Add
                </InputGroupButton>
              </InputGroup>
              <Button
                onClick={() => setBatchOpen(true)}
                size="sm"
                variant="outline"
              >
                Batch
              </Button>
            </div>

            <div className="max-h-60 divide-y divide-border overflow-y-auto rounded-md border border-border">
              {numbers.length === 0 ? (
                <div className="p-4 text-center text-muted-foreground text-sm">
                  No numbers added
                </div>
              ) : (
                numbers.map((num) => (
                  <div
                    className="flex items-center justify-between px-3 py-2 text-sm"
                    key={num}
                  >
                    <span className="font-mono">+{num}</span>
                    <Button
                      aria-label={`Remove ${num}`}
                      className="size-7 text-muted-foreground hover:text-destructive"
                      onClick={() => handleRemove(num)}
                      size="icon"
                      variant="ghost"
                    >
                      <Delete02Icon className="size-4" />
                    </Button>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
