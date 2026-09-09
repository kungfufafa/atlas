import { createClient } from "@atlas/client";
import type { ChannelIntegrationPolicy } from "@atlas/core/channel-integration-policy";
import type { NativeChannel } from "@atlas/core/channel-native-actions";
import type { ProviderInstanceSummary } from "@atlas/core/contract";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  NamedPolicyRules,
  OptionalToggle,
  PolicyActions,
  PolicyIds,
  PolicyRule,
} from "@/components/channel-policy-fields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/context/use-auth";
import { formatError } from "@/lib/client";

export function ChannelNativePolicyDialog({
  channel,
}: {
  channel: NativeChannel;
}) {
  const { activeOrg, user } = useAuth();
  if (!activeOrg || (activeOrg.role !== "admin" && !user?.isPlatformAdmin)) {
    return null;
  }
  return (
    <ScopedPolicyDialog
      channel={channel}
      key={`${activeOrg.id}:${channel}`}
      orgId={activeOrg.id}
    />
  );
}
function ScopedPolicyDialog({
  channel,
  orgId,
}: {
  channel: NativeChannel;
  orgId: string;
}) {
  // Capture the tenant on a dedicated client: delayed saves cannot follow a switched global client.
  const client = useMemo(() => createClient({ baseUrl: "", orgId }), [orgId]);
  const [open, setOpen] = useState(false);
  const [policy, setPolicy] = useState<ChannelIntegrationPolicy | null>(null);
  const [providers, setProviders] = useState<ProviderInstanceSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const epoch = useRef(0);
  useEffect(() => {
    const generation = ++epoch.current;
    if (!open) {
      return;
    }
    setLoading(true);
    setPolicy(null);
    setError(null);
    Promise.all([
      client.getChannelIntegrationPolicy(channel),
      client.listProviders(),
    ])
      .then(([next, response]) => {
        if (epoch.current === generation) {
          setPolicy(structuredClone(next));
          setProviders(response.providers);
        }
      })
      .catch((reason) => {
        if (epoch.current === generation) {
          setError(formatError(reason));
        }
      })
      .finally(() => {
        if (epoch.current === generation) {
          setLoading(false);
        }
      });
    return () => {
      epoch.current++;
    };
  }, [channel, client, open]);
  function change<K extends keyof ChannelIntegrationPolicy>(
    key: K,
    next: ChannelIntegrationPolicy[K]
  ) {
    setPolicy((previous) => {
      if (!previous) {
        return previous;
      }
      const updated = { ...previous };
      if (next === undefined) {
        delete updated[key];
      } else {
        updated[key] = next;
      }
      return updated;
    });
  }
  async function save() {
    if (!policy || saving) {
      return;
    }
    if (policy.speech && !policy.speech.providerId.trim()) {
      setError("Select a speech provider instance.");
      return;
    }
    const generation = epoch.current;
    setSaving(true);
    setError(null);
    try {
      await client.setChannelIntegrationPolicy(channel, policy);
      if (epoch.current === generation) {
        setOpen(false);
      }
    } catch (reason) {
      if (epoch.current === generation) {
        setError(formatError(reason));
      }
    } finally {
      if (epoch.current === generation) {
        setSaving(false);
      }
    }
  }
  const title = `${channel === "whatsapp" ? "WhatsApp" : channel === "telegram" ? "Telegram" : "Discord"} controls`;
  return (
    <>
      <Button
        className="mt-3"
        onClick={() => {
          setSaving(false);
          setOpen(true);
        }}
        size="sm"
        type="button"
        variant="outline"
      >
        Channel controls
      </Button>
      <Dialog
        onOpenChange={(next) => {
          if (!saving) {
            setOpen(next);
          }
        }}
        open={open}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              Rules apply together with workspace roles and channel access. A
              denial takes precedence. Inherit uses broader or default settings.
              Empty allowed lists permit no entries; empty blocked lists block
              none.
            </DialogDescription>
          </DialogHeader>
          {loading && <p role="status">Loading controls…</p>}
          {error && (
            <p className="text-destructive" role="alert">
              {error}
            </p>
          )}
          {policy && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <fieldset className="space-y-5" disabled={saving}>
                <OptionalToggle
                  label="Channel enabled"
                  onChange={(v) => change("enabled", v)}
                  value={policy.enabled}
                />
                <OptionalToggle
                  label="Approval buttons"
                  onChange={(v) => change("approvals", v)}
                  value={policy.approvals}
                />
                <details open>
                  <summary className="cursor-pointer font-medium">
                    Native actions
                  </summary>
                  <div className="pt-4">
                    <PolicyActions
                      onChange={(v) => change("actions", v)}
                      value={policy.actions}
                    />
                  </div>
                </details>
                <details>
                  <summary className="cursor-pointer font-medium">
                    Direct messages
                  </summary>
                  <div className="pt-4">
                    <PolicyRule
                      onChange={(v) => change("dm", v)}
                      value={policy.dm ?? {}}
                    />
                  </div>
                </details>
                <details>
                  <summary className="cursor-pointer font-medium">
                    Groups
                  </summary>
                  <div className="pt-4">
                    <PolicyRule
                      onChange={(v) => change("groups", v)}
                      value={policy.groups ?? {}}
                    />
                  </div>
                </details>
                <details>
                  <summary className="cursor-pointer font-medium">
                    Room rules
                  </summary>
                  <div className="pt-4">
                    <NamedPolicyRules
                      label="Room"
                      onChange={(v) => change("rooms", v)}
                      value={policy.rooms}
                    />
                  </div>
                </details>
                <details>
                  <summary className="cursor-pointer font-medium">
                    Sender rules
                  </summary>
                  <div className="pt-4">
                    <NamedPolicyRules
                      label="Sender"
                      onChange={(v) => change("senders", v)}
                      value={policy.senders}
                    />
                  </div>
                </details>
                {channel === "discord" && (
                  <details>
                    <summary className="cursor-pointer font-medium">
                      Voice and speech
                    </summary>
                    <div className="pt-4">
                      <PolicySpeech
                        channel={channel}
                        onChange={change}
                        policy={policy}
                        providers={providers}
                      />
                    </div>
                  </details>
                )}
              </fieldset>
              <DialogFooter className="mt-6">
                <Button
                  disabled={saving}
                  onClick={() => setOpen(false)}
                  type="button"
                  variant="outline"
                >
                  Cancel
                </Button>
                <Button disabled={saving} type="submit">
                  {saving ? "Saving…" : "Save controls"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
function PolicySpeech({
  channel,
  policy,
  providers,
  onChange,
}: {
  channel: NativeChannel;
  policy: ChannelIntegrationPolicy;
  providers: ProviderInstanceSummary[];
  onChange: <K extends keyof ChannelIntegrationPolicy>(
    key: K,
    value: ChannelIntegrationPolicy[K]
  ) => void;
}) {
  const speech = policy.speech;
  const voice = policy.voice;
  const eligible = providers.filter(
    (provider) =>
      provider.type === "openai" || provider.type === "openai_compatible"
  );
  return (
    <div className="space-y-4">
      {channel === "discord" && (
        <>
          <OptionalToggle
            label="Voice channel sessions"
            onChange={(v) =>
              onChange(
                "voice",
                v === undefined
                  ? undefined
                  : {
                      ...voice,
                      allowedRoomIds: voice?.allowedRoomIds ?? [],
                      enabled: v,
                    }
              )
            }
            value={voice?.enabled}
          />
          {voice && (
            <>
              <PolicyIds
                label="Allowed voice room IDs"
                onChange={(v) =>
                  onChange("voice", { ...voice, allowedRoomIds: v ?? [] })
                }
                required
                value={voice.allowedRoomIds}
              />
              <label className="block space-y-1">
                <span>Session limit (seconds)</span>
                <Input
                  max={3600}
                  min={10}
                  onChange={(e) =>
                    onChange("voice", {
                      ...voice,
                      maxSessionSeconds:
                        e.target.value === ""
                          ? undefined
                          : Number(e.target.value),
                    })
                  }
                  type="number"
                  value={voice.maxSessionSeconds ?? ""}
                />
              </label>
              <label className="block space-y-1">
                <span>Utterance limit (seconds)</span>
                <Input
                  max={60}
                  min={1}
                  onChange={(e) =>
                    onChange("voice", {
                      ...voice,
                      maxUtteranceSeconds:
                        e.target.value === ""
                          ? undefined
                          : Number(e.target.value),
                    })
                  }
                  type="number"
                  value={voice.maxUtteranceSeconds ?? ""}
                />
              </label>
            </>
          )}
        </>
      )}
      <label className="flex items-center gap-2">
        <input
          checked={speech !== undefined}
          onChange={(e) =>
            onChange(
              "speech",
              e.target.checked
                ? {
                    model: "",
                    providerId: "",
                    transport: "openai-audio-speech",
                    voice: "",
                  }
                : undefined
            )
          }
          type="checkbox"
        />
        Configure speech synthesis
      </label>
      {speech && (
        <>
          <div className="space-y-1">
            <span>Speech provider instance</span>
            <Select
              onValueChange={(v) =>
                onChange("speech", { ...speech, providerId: v ?? "" })
              }
              value={speech.providerId}
            >
              <SelectTrigger
                aria-label="Speech provider instance"
                className="w-full"
              >
                <SelectValue placeholder="Select provider" />
              </SelectTrigger>
              <SelectContent>
                {speech.providerId &&
                  !eligible.some((p) => p.id === speech.providerId) && (
                    <SelectItem value={speech.providerId}>
                      Unavailable: {speech.providerId}
                    </SelectItem>
                  )}
                {eligible.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label} ({p.id})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <label className="block space-y-1">
            <span>Speech model ID</span>
            <Input
              maxLength={200}
              onChange={(e) =>
                onChange("speech", { ...speech, model: e.target.value })
              }
              required
              value={speech.model}
            />
          </label>
          <label className="block space-y-1">
            <span>Speech voice ID</span>
            <Input
              maxLength={200}
              onChange={(e) =>
                onChange("speech", { ...speech, voice: e.target.value })
              }
              required
              value={speech.voice}
            />
          </label>
          <p className="text-muted-foreground text-xs">
            OpenAI audio/speech transport. Select an API provider that supports
            these exact model and voice IDs. Subscription providers cannot
            synthesize speech here.
          </p>
        </>
      )}
    </div>
  );
}
