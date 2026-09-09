import type { ChannelIntegrationRule } from "@atlas/core/channel-integration-policy";
import type { ChannelNativeActionKind } from "@atlas/core/channel-native-actions";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

export const ACTION_LABELS: Record<ChannelNativeActionKind, string> = {
  delete: "Delete messages",
  edit: "Edit messages",
  pin: "Pin messages",
  poll: "Polls",
  react: "Reactions",
  send_media: "Send media",
  thread_create: "Create threads",
  topic_create: "Create topics",
  topic_edit: "Edit topics",
  unpin: "Unpin messages",
};
export function OptionalToggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean | undefined;
  onChange: (value: boolean | undefined) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-3">
      <label htmlFor={id}>{label}</label>
      <Select
        onValueChange={(v) =>
          onChange(v === "inherit" ? undefined : v === "enabled")
        }
        value={value === undefined ? "inherit" : value ? "enabled" : "disabled"}
      >
        <SelectTrigger aria-label={label} id={id} size="sm">
          <SelectValue>
            {value === undefined ? "Inherit" : value ? "Enabled" : "Disabled"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="inherit">Inherit</SelectItem>
          <SelectItem value="enabled">Enabled</SelectItem>
          <SelectItem value="disabled">Disabled</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
export function PolicyIds({
  label,
  value,
  onChange,
  required = false,
}: {
  label: string;
  value: string[] | undefined;
  onChange: (value: string[] | undefined) => void;
  required?: boolean;
}) {
  const id = useId();
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id}>{label}</label>
        {!required && (
          <Select
            onValueChange={(v) => onChange(v === "inherit" ? undefined : [])}
            value={value === undefined ? "inherit" : "custom"}
          >
            <SelectTrigger aria-label={`${label} mode`} size="sm">
              <SelectValue>
                {value === undefined ? "Inherit" : "Specify list"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inherit">Inherit</SelectItem>
              <SelectItem value="custom">Specify list</SelectItem>
            </SelectContent>
          </Select>
        )}
      </div>
      {value !== undefined && (
        <Textarea
          aria-label={label}
          defaultValue={value.join("\n")}
          id={id}
          onChange={(event) =>
            onChange([
              ...new Set(
                event.target.value
                  .split(/[\n,]+/)
                  .map((v) => v.trim())
                  .filter(Boolean)
              ),
            ])
          }
          placeholder="One ID per line; blank means none"
          rows={2}
        />
      )}
    </div>
  );
}
export function PolicyActions({
  value,
  onChange,
}: {
  value: ChannelIntegrationRule["actions"];
  onChange: (value: ChannelIntegrationRule["actions"]) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {Object.entries(ACTION_LABELS).map(([kind, label]) => (
        <OptionalToggle
          key={kind}
          label={label}
          onChange={(next) => {
            const actions = { ...value };
            if (next === undefined) {
              delete actions[kind as ChannelNativeActionKind];
            } else {
              actions[kind as ChannelNativeActionKind] = next;
            }
            onChange(Object.keys(actions).length ? actions : undefined);
          }}
          value={value?.[kind as ChannelNativeActionKind]}
        />
      ))}
    </div>
  );
}
export function PolicyRule({
  value,
  onChange,
}: {
  value: ChannelIntegrationRule;
  onChange: (rule: ChannelIntegrationRule) => void;
}) {
  function change<K extends keyof ChannelIntegrationRule>(
    key: K,
    next: ChannelIntegrationRule[K]
  ) {
    const rule = { ...value };
    if (next === undefined) {
      delete rule[key];
    } else {
      rule[key] = next;
    }
    onChange(rule);
  }
  const roles = value.roles;
  return (
    <div className="space-y-4">
      <OptionalToggle
        label="Rule enabled"
        onChange={(v) => change("enabled", v)}
        value={value.enabled}
      />
      <OptionalToggle
        label="Require mention or reply"
        onChange={(v) => change("requireMention", v)}
        value={value.requireMention}
      />
      <PolicyIds
        label="Allowed sender IDs"
        onChange={(v) => change("allowedSenders", v)}
        value={value.allowedSenders}
      />
      <PolicyIds
        label="Blocked sender IDs"
        onChange={(v) => change("blockedSenders", v)}
        value={value.blockedSenders}
      />
      <PolicyIds
        label="Allowed tool IDs"
        onChange={(v) => change("allowedTools", v)}
        value={value.allowedTools}
      />
      <label className="flex items-center gap-2">
        <input
          checked={roles !== undefined}
          onChange={(e) => change("roles", e.target.checked ? [] : undefined)}
          type="checkbox"
        />
        Limit workspace roles
      </label>
      {roles !== undefined && (
        <div className="flex gap-4">
          {(["admin", "member", "viewer"] as const).map((role) => (
            <label className="flex items-center gap-2" key={role}>
              <input
                checked={roles.includes(role)}
                onChange={(e) =>
                  change(
                    "roles",
                    e.target.checked
                      ? [...roles, role]
                      : roles.filter((r) => r !== role)
                  )
                }
                type="checkbox"
              />
              {role}
            </label>
          ))}
        </div>
      )}
      <details>
        <summary className="cursor-pointer font-medium">
          Action restrictions
        </summary>
        <div className="pt-3">
          <PolicyActions
            onChange={(v) => change("actions", v)}
            value={value.actions}
          />
        </div>
      </details>
    </div>
  );
}
export function NamedPolicyRules({
  label,
  value,
  onChange,
}: {
  label: "Room" | "Sender";
  value: Record<string, ChannelIntegrationRule> | undefined;
  onChange: (rules: Record<string, ChannelIntegrationRule> | undefined) => void;
}) {
  const [identifier, setIdentifier] = useState("");
  const [error, setError] = useState<string | null>(null);
  function add() {
    const id = identifier.trim();
    if (
      !id ||
      id.length > 200 ||
      ["__proto__", "prototype", "constructor"].includes(id) ||
      Object.hasOwn(value ?? {}, id)
    ) {
      setError("Enter a unique, valid ID.");
      return;
    }
    onChange({ ...value, [id]: {} });
    setIdentifier("");
    setError(null);
  }
  return (
    <div className="space-y-3">
      {Object.entries(value ?? {}).map(([id, rule]) => (
        <details className="rounded-lg border p-3" key={id}>
          <summary className="cursor-pointer break-all font-medium">
            {id}
          </summary>
          <div className="space-y-4 pt-4">
            <PolicyRule
              onChange={(next) => onChange({ ...value, [id]: next })}
              value={rule}
            />
            <Button
              onClick={() => {
                const next = { ...value };
                delete next[id];
                onChange(Object.keys(next).length ? next : undefined);
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              Remove {label.toLowerCase()} rule
            </Button>
          </div>
        </details>
      ))}
      <div className="flex gap-2">
        <Input
          aria-label={`New ${label.toLowerCase()} ID`}
          onChange={(e) => setIdentifier(e.target.value)}
          placeholder={`${label} ID or *`}
          value={identifier}
        />
        <Button onClick={add} size="sm" type="button" variant="outline">
          Add {label.toLowerCase()}
        </Button>
      </div>
      {error && (
        <p className="text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
