import type { ChannelAccessMode } from "@atlas/core/contract";

export const CHANNEL_ACCESS_MODE_OPTIONS = [
  { label: "Open", value: "open" },
  { label: "Allowed list only", value: "allowlist" },
  { label: "Blocked list filter", value: "denylist" },
  { label: "Chat access code", value: "pairing" },
] as const satisfies ReadonlyArray<{
  label: string;
  value: ChannelAccessMode;
}>;

export function channelAccessModeLabel(mode: ChannelAccessMode): string {
  return (
    CHANNEL_ACCESS_MODE_OPTIONS.find((option) => option.value === mode)
      ?.label ?? mode
  );
}
