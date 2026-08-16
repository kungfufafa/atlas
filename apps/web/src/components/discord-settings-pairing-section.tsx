import type { ChannelAccessMode, ProfileSummary } from "@atlas/core/contract";
import {
  CheckmarkCircle01Icon,
  Copy01Icon,
  RefreshIcon,
} from "hugeicons-react";
import {
  DiscordPairingGuide,
  SettingsRow,
} from "@/components/discord-settings-card.shared";
import {
  CHANNEL_ACCESS_MODE_OPTIONS,
  channelAccessModeLabel,
} from "@/components/integration-settings.shared";
import { ProfileAvatar } from "@/components/ProfileAvatar";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { WorkerActionBar } from "@/components/WorkerActionBar";
import { cn } from "@/lib/utils";

export function DiscordSettingsPairingSection({
  isPaired,
  pairingCode,
  copied,
  savePending,
  regeneratePending,
  inviteUrl,
  onCopyHandshakeCode,
  onRegenerateHandshake,
  rowClassName,
  compact = false,
}: {
  isPaired: boolean;
  pairingCode: string | null;
  copied: boolean;
  savePending: boolean;
  regeneratePending: boolean;
  inviteUrl: string | null;
  onCopyHandshakeCode: () => void;
  onRegenerateHandshake: () => void;
  rowClassName?: string;
  compact?: boolean;
}) {
  return (
    <div className={cn("space-y-4", !isPaired && "bg-muted/20")}>
      <SettingsRow
        className={rowClassName}
        description={
          pairingCode
            ? isPaired
              ? "Send this code to your bot in Discord to link another account."
              : "Send this code to your bot in Discord to finish linking."
            : isPaired
              ? "Discord is linked. Generate a new code to link another account."
              : "Generate a code, then message it to your bot once."
        }
        label="Chat access code"
      >
        {pairingCode ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <code className="rounded-md border border-border bg-background px-2.5 py-1 text-sm tracking-widest">
              {pairingCode}
            </code>
            <Button
              className="min-w-[5.25rem] justify-center"
              onClick={onCopyHandshakeCode}
              size="sm"
              type="button"
              variant="outline"
            >
              {copied ? (
                <CheckmarkCircle01Icon
                  aria-hidden
                  className="size-3.5 text-emerald-600 dark:text-emerald-400"
                />
              ) : (
                <Copy01Icon aria-hidden className="size-3.5" />
              )}
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button
              disabled={regeneratePending || savePending}
              onClick={onRegenerateHandshake}
              size="sm"
              type="button"
              variant="outline"
            >
              {regeneratePending ? (
                <Spinner />
              ) : (
                <>
                  <RefreshIcon aria-hidden="true" className="size-3.5" />
                  New code
                </>
              )}
            </Button>
          </div>
        ) : isPaired ? (
          <Button
            disabled={regeneratePending || savePending}
            onClick={onRegenerateHandshake}
            size="sm"
            type="button"
            variant="outline"
          >
            {regeneratePending ? (
              <Spinner />
            ) : (
              <>
                <RefreshIcon aria-hidden="true" className="size-3.5" />
                New code
              </>
            )}
          </Button>
        ) : (
          <Button
            disabled={regeneratePending || savePending}
            onClick={onRegenerateHandshake}
            size="sm"
            type="button"
          >
            {regeneratePending ? (
              <>
                <Spinner className="size-3" />
                Generating…
              </>
            ) : (
              "Generate access code"
            )}
          </Button>
        )}
      </SettingsRow>

      {pairingCode ? (
        <DiscordPairingGuide compact={compact} inviteUrl={inviteUrl} />
      ) : null}
    </div>
  );
}

export function DiscordSettingsConfiguredRows({
  accessMode,
  onAccessModeChange,
  allowedUserSummary,
  onManageAllowedUsers,
  blockedUserSummary,
  onManageBlockedUsers,
  savePending,
  profileId,
  profiles,
  onProfileChange,
  running,
  worker,
  rowClassName,
}: {
  accessMode: ChannelAccessMode;
  onAccessModeChange: (mode: ChannelAccessMode) => void;
  allowedUserSummary: string;
  onManageAllowedUsers: () => void;
  blockedUserSummary: string;
  onManageBlockedUsers: () => void;
  savePending: boolean;
  profileId: string;
  profiles: ProfileSummary[];
  onProfileChange: (profileId: string) => void;
  running: boolean;
  worker: { process?: { managed?: boolean } } | null | undefined;
  rowClassName?: string;
}) {
  return (
    <div className="space-y-4">
      <SettingsRow
        className={rowClassName}
        description="Controls who is permitted to chat with the assistant"
        label="Access mode"
      >
        <Select
          disabled={savePending}
          onValueChange={(value) => {
            if (value) {
              onAccessModeChange(value as ChannelAccessMode);
            }
          }}
          value={accessMode}
        >
          <SelectTrigger
            className="w-[11rem] sm:w-[13rem]"
            id="discord-access-mode"
          >
            <SelectValue placeholder="Access mode">
              {channelAccessModeLabel(accessMode)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent align="end">
            {CHANNEL_ACCESS_MODE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>

      {accessMode === "allowlist" ? (
        <SettingsRow
          className={rowClassName}
          description="Discord user IDs that can use this bot"
          label="Allowed users"
        >
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="text-muted-foreground text-xs">
              {allowedUserSummary}
            </span>
            <Button
              disabled={savePending}
              onClick={onManageAllowedUsers}
              size="sm"
              type="button"
              variant="outline"
            >
              Manage
            </Button>
          </div>
        </SettingsRow>
      ) : null}

      {accessMode === "denylist" ? (
        <SettingsRow
          className={rowClassName}
          description="Discord user IDs blocked from chatting"
          label="Blocked users"
        >
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="text-muted-foreground text-xs">
              {blockedUserSummary}
            </span>
            <Button
              disabled={savePending}
              onClick={onManageBlockedUsers}
              size="sm"
              type="button"
              variant="outline"
            >
              Manage
            </Button>
          </div>
        </SettingsRow>
      ) : null}

      <SettingsRow
        className={rowClassName}
        description="Which agent answers on Discord"
        label="Reply as"
      >
        <Select
          disabled={savePending || profiles.length === 0}
          onValueChange={(value) => {
            if (value) {
              onProfileChange(String(value));
            }
          }}
          value={profileId}
        >
          <SelectTrigger
            className="w-[11rem] sm:w-[13rem]"
            id="discord-profile"
          >
            <SelectValue placeholder="Profile">
              {profiles.find((profile) => profile.id === profileId)?.name}
            </SelectValue>
          </SelectTrigger>
          <SelectContent align="end">
            {profiles.map((profile) => (
              <SelectItem key={profile.id} value={profile.id}>
                <span className="flex items-center gap-2">
                  <ProfileAvatar profile={profile} size="sm" />
                  <span>{profile.name}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsRow>

      <SettingsRow
        className={rowClassName}
        description={running ? "Running" : "Stopped"}
        label="Bridge worker"
      >
        <WorkerActionBar
          pm2Managed={worker?.process?.managed ?? false}
          running={running}
          workerName="discord"
        />
      </SettingsRow>
    </div>
  );
}
