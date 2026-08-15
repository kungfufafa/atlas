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

export interface DiscordBlockedUsersDialogProps {
  blockedUserIds: string[];
  onBlockedUserIdsChange: (userIds: string[]) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

function parseDiscordIds(input: string): string[] {
  return input
    .split(/[,\s\n]+/)
    .map((id) => id.trim())
    .filter((id) => /^[1-9]\d{15,20}$/.test(id));
}

export function DiscordBlockedUsersDialog({
  open,
  onOpenChange,
  blockedUserIds,
  onBlockedUserIdsChange,
}: DiscordBlockedUsersDialogProps) {
  const [newId, setNewId] = useState("");
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchDraft, setBatchDraft] = useState("");

  function handleAdd() {
    const trimmed = newId.trim();
    if (!/^[1-9]\d{15,20}$/.test(trimmed)) {
      return;
    }

    if (!blockedUserIds.includes(trimmed)) {
      onBlockedUserIdsChange([...blockedUserIds, trimmed]);
    }
    setNewId("");
  }

  function handleRemove(target: string) {
    onBlockedUserIdsChange(blockedUserIds.filter((id) => id !== target));
  }

  function handleBatchImport() {
    const parsed = parseDiscordIds(batchDraft);
    if (parsed.length > 0) {
      const combined = [...new Set([...blockedUserIds, ...parsed])];
      onBlockedUserIdsChange(combined);
    }
    setBatchDraft("");
    setBatchOpen(false);
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Blocked Discord Users</DialogTitle>
        </DialogHeader>

        {batchOpen ? (
          <div className="space-y-3">
            <Textarea
              onChange={(e) => setBatchDraft(e.target.value)}
              placeholder="Paste Discord snowflake IDs separated by commas or lines"
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
                Add users
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex gap-2">
              <InputGroup className="flex-1">
                <InputGroupInput
                  onChange={(e) => setNewId(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAdd();
                    }
                  }}
                  placeholder="Enter Discord user snowflake ID"
                  value={newId}
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
              {blockedUserIds.length === 0 ? (
                <div className="p-4 text-center text-muted-foreground text-sm">
                  No blocked users
                </div>
              ) : (
                blockedUserIds.map((id) => (
                  <div
                    className="flex items-center justify-between px-3 py-2 text-sm"
                    key={id}
                  >
                    <span className="font-mono">ID: {id}</span>
                    <Button
                      aria-label={`Remove user ${id}`}
                      className="size-7 text-muted-foreground hover:text-destructive"
                      onClick={() => handleRemove(id)}
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
