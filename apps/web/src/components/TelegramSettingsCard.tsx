import type {
  ChannelAccessMode,
  UpdateTelegramSettingsRequest,
} from "@atlas/core/contract";
import { useEffect, useState } from "react";
import { SETTINGS_CARD_LOADING_SKELETON } from "@/components/integration-settings.shared";
import {
  type AllowedTelegramUser,
  TelegramAllowedUsersDialog,
} from "@/components/TelegramAllowedUsersDialog";
import { TelegramBlockedUsersDialog } from "@/components/TelegramBlockedUsersDialog";
import { TelegramSettingsCardContent } from "@/components/telegram-settings-card-content";
import { useProfilesQuery } from "@/hooks/use-app-queries";
import { useSystemStatusQuery } from "@/hooks/use-system-status";
import {
  useRegenerateTelegramHandshake,
  useSaveTelegramSettings,
  useTelegramSettings,
} from "@/hooks/use-telegram-settings";
import { formatError } from "@/lib/client";

interface TelegramSettingsCardProps {
  embedded?: boolean;
  onSaveSuccess?: () => void;
  submitLabel?: string;
}

export function TelegramSettingsCard({
  embedded = false,
  submitLabel = "Save",
  onSaveSuccess,
}: TelegramSettingsCardProps) {
  const { data: settings, isLoading, error: loadError } = useTelegramSettings();
  const { data: status } = useSystemStatusQuery();
  const { data: profiles = [] } = useProfilesQuery();
  const saveMutation = useSaveTelegramSettings();
  const regenerateMutation = useRegenerateTelegramHandshake();

  const [botToken, setBotToken] = useState("");
  const [showBotToken, setShowBotToken] = useState(false);
  const [profileId, setProfileId] = useState("default");
  const [accessMode, setAccessMode] = useState<ChannelAccessMode>("pairing");
  const [allowedUsers, setAllowedUsers] = useState<AllowedTelegramUser[]>([]);
  const [blockedUserIds, setBlockedUserIds] = useState<string[]>([]);
  const [allowedUsersOpen, setAllowedUsersOpen] = useState(false);
  const [blockedUsersOpen, setBlockedUsersOpen] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!settings) {
      return;
    }

    if (settings.profileId && settings.profileId !== "default") {
      setProfileId(settings.profileId);
    } else if (profiles.length > 0) {
      const defaultProfile = profiles.find((p) => p.isDefault) ?? profiles[0];
      if (defaultProfile) {
        setProfileId(defaultProfile.id);
      }
    }
    setAccessMode(settings.accessMode ?? "pairing");
    setBotToken("");
    setBlockedUserIds((settings.blockedUserIds ?? []).map(String));
    setAllowedUsers((current) => {
      const existing = new Map(current.map((user) => [user.id, user]));
      return (settings.allowedUserIds ?? []).map((id) => {
        const stringId = String(id);
        return existing.get(stringId) ?? { id: stringId };
      });
    });
  }, [settings, profiles]);

  const configured = settings?.configured === true;
  const isPaired = (settings?.pairedUserIds.length ?? 0) > 0;
  const hasAllowedUsers = (settings?.allowedUserIds.length ?? 0) > 0;
  const hasLinkedUsers = isPaired || hasAllowedUsers;
  const pairingCode = settings?.handshakeCode ?? null;
  const worker = status?.telegramWorker;
  const running = worker?.running === true;
  const workerFailed = configured && worker?.ok === false && !running;
  const canSave = configured || botToken.trim().length > 0;
  const allowedUserSummary =
    allowedUsers.length === 0
      ? "No manual users"
      : `${allowedUsers.length} user${allowedUsers.length === 1 ? "" : "s"}`;
  const blockedUserSummary =
    blockedUserIds.length === 0
      ? "No blocked users"
      : `${blockedUserIds.length} blocked user${blockedUserIds.length === 1 ? "" : "s"}`;

  const statusLine =
    hint ??
    (formError ? formError : null) ??
    (loadError ? formatError(loadError) : null);

  const headerSubtitle = workerFailed
    ? "Telegram rejected the bot token — paste a valid token and save"
    : configured
      ? hasLinkedUsers && running
        ? "Your Telegram is connected to Atlas"
        : hasLinkedUsers
          ? "Linked. Start the bridge to receive messages"
          : accessMode === "pairing"
            ? pairingCode
              ? "Step 2: send your chat access code to the bot in Telegram"
              : "Step 2: generate a chat access code and send it to your bot"
            : accessMode === "allowlist"
              ? "Step 2: add allowed Telegram user IDs, then start the bridge"
              : accessMode === "denylist"
                ? "Step 2: add blocked Telegram user IDs, then start the bridge"
                : "Step 2: start the bridge to open the bot to everyone"
      : "Step 1: paste a bot token from @BotFather";

  const statusBadge = workerFailed
    ? "Error"
    : configured
      ? hasLinkedUsers && running
        ? "Connected"
        : hasLinkedUsers
          ? "Paired"
          : "Awaiting link"
      : "Not set up";

  async function copyHandshakeCode() {
    if (!pairingCode) {
      return;
    }

    try {
      await navigator.clipboard.writeText(pairingCode);
      setHint("Code copied — paste it in Telegram.");
    } catch {
      setHint("Copy the code manually.");
    }
  }

  function handleSave(afterSuccess?: () => void) {
    setFormError(null);
    setHint(null);

    const request: UpdateTelegramSettingsRequest = {
      accessMode,
      allowedUserIds: allowedUsers.map((user) => user.id).join(","),
      blockedUserIds: blockedUserIds.join(","),
      profileId: profileId.trim() || "default",
    };

    if (botToken.trim()) {
      request.botToken = botToken.trim();
    }

    saveMutation.mutate(request, {
      onError: (err) => {
        setFormError(formatError(err));
      },
      onSuccess: (saved) => {
        setBotToken("");
        const savedHasLinkedUsers =
          saved.pairedUserIds.length > 0 || saved.allowedUserIds.length > 0;

        if (saved.handshakeCode && !savedHasLinkedUsers) {
          setHint("Saved. Send the chat access code to your bot.");
        } else if (savedHasLinkedUsers) {
          setHint("Saved.");
        } else {
          setHint(
            "Saved. Generate a chat access code if you still need to link."
          );
        }
        afterSuccess?.();
        onSaveSuccess?.();
      },
    });
  }

  function handleAccessModeChange(nextMode: ChannelAccessMode) {
    setAccessMode(nextMode);
    setHint(null);
    setFormError(null);
  }

  function handleBlockedUsersChange(nextBlocked: string[]) {
    setBlockedUserIds(nextBlocked);
    setHint(null);
    setFormError(null);
  }

  function handleRegenerateHandshake() {
    setFormError(null);
    setHint(null);

    regenerateMutation.mutate(undefined, {
      onError: (err) => {
        setFormError(formatError(err));
      },
      onSuccess: () => {
        setHint("New code ready — send it to your bot in Telegram.");
      },
    });
  }

  if (isLoading) {
    if (embedded) {
      return SETTINGS_CARD_LOADING_SKELETON;
    }

    return <div className="py-3">{SETTINGS_CARD_LOADING_SKELETON}</div>;
  }

  const content = (
    <TelegramSettingsCardContent
      accessMode={accessMode}
      allowedUserSummary={allowedUserSummary}
      blockedUserSummary={blockedUserSummary}
      botToken={botToken}
      formError={formError}
      headerSubtitle={headerSubtitle}
      loadError={loadError}
      onAccessModeChange={handleAccessModeChange}
      onBotTokenChange={(value) => {
        setBotToken(value);
        setHint(null);
        if (formError) {
          setFormError(null);
        }
      }}
      onCopyHandshakeCode={() => void copyHandshakeCode()}
      onManageAllowedUsers={() => setAllowedUsersOpen(true)}
      onManageBlockedUsers={() => setBlockedUsersOpen(true)}
      onProfileChange={(value) => {
        setProfileId(value);
        setHint(null);
      }}
      onRegenerateHandshake={handleRegenerateHandshake}
      onSave={() => handleSave()}
      onToggleShowBotToken={() => setShowBotToken((current) => !current)}
      pairingCode={pairingCode}
      profileId={profileId}
      profiles={profiles}
      settings={settings}
      statusBadge={statusBadge}
      statusLine={statusLine}
      submitLabel={submitLabel}
      view={{
        canSave,
        configured,
        embedded,
        hasLinkedUsers,
        isPaired,
        regeneratePending: regenerateMutation.isPending,
        running,
        savePending: saveMutation.isPending,
        showBotToken,
        workerFailed,
      }}
      worker={worker}
    />
  );

  const allowedUsersDialog = (
    <TelegramAllowedUsersDialog
      allowedUsers={allowedUsers}
      onAllowedUsersChange={setAllowedUsers}
      onError={setFormError}
      onOpenChange={setAllowedUsersOpen}
      onSaved={() => {
        setHint("Allowed users saved.");
        setFormError(null);
      }}
      open={allowedUsersOpen}
      profileId={profileId}
    />
  );

  const blockedUsersDialog = (
    <TelegramBlockedUsersDialog
      blockedUserIds={blockedUserIds}
      onBlockedUserIdsChange={handleBlockedUsersChange}
      onOpenChange={setBlockedUsersOpen}
      open={blockedUsersOpen}
    />
  );

  if (embedded) {
    return (
      <>
        <div className="space-y-2">
          <p className="text-muted-foreground text-xs">{headerSubtitle}</p>
          {content}
        </div>
        {allowedUsersDialog}
        {blockedUsersDialog}
      </>
    );
  }

  return (
    <>
      {content}
      {allowedUsersDialog}
      {blockedUsersDialog}
    </>
  );
}
