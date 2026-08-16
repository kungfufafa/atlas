import type {
  ChannelAccessMode,
  UpdateWhatsAppSettingsRequest,
} from "@atlas/core/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { SETTINGS_CARD_LOADING_SKELETON } from "@/components/integration-settings.shared";
import { WhatsAppSettingsCardContent } from "@/components/whatsapp-settings-card-content";
import { useProfilesQuery } from "@/hooks/use-app-queries";
import { useSystemStatusQuery } from "@/hooks/use-system-status";
import {
  useReconnectWhatsApp,
  useRegenerateWhatsAppPairingCode,
  useSaveWhatsAppSettings,
  useWhatsAppSettings,
} from "@/hooks/use-whatsapp-settings";
import { formatError } from "@/lib/client";
import { queryKeys } from "@/lib/query-keys";

interface WhatsAppSettingsCardProps {
  embedded?: boolean;
  onSaveSuccess?: () => void;
  submitLabel?: string;
}

export function WhatsAppSettingsCard({
  embedded = false,
  submitLabel,
  onSaveSuccess,
}: WhatsAppSettingsCardProps) {
  const queryClient = useQueryClient();
  const { data: settings, isLoading, error: loadError } = useWhatsAppSettings();
  const { data: status } = useSystemStatusQuery();
  const { data: profiles = [] } = useProfilesQuery();
  const saveMutation = useSaveWhatsAppSettings();
  const regenerateMutation = useRegenerateWhatsAppPairingCode();
  const reconnectMutation = useReconnectWhatsApp();

  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [profileId, setProfileId] = useState("default");
  const [accessMode, setAccessMode] = useState<ChannelAccessMode>("pairing");
  const [allowedNumbers, setAllowedNumbers] = useState<string[]>([]);
  const [blockedNumbers, setBlockedNumbers] = useState<string[]>([]);
  const [hint, setHint] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [qrWasVisible, setQrWasVisible] = useState(false);
  const [copied, setCopied] = useState(false);

  const settingsProfileId = settings?.profileId;
  const settingsAccessMode = settings?.accessMode;
  const settingsAllowedNumbers = settings?.allowedNumbers;
  const settingsBlockedNumbers = settings?.blockedNumbers;

  useEffect(() => {
    if (saveMutation.isPending) {
      return;
    }
    if (settingsProfileId !== undefined && settingsProfileId !== "default") {
      setProfileId(settingsProfileId);
    } else if (profiles.length > 0) {
      const defaultProfile = profiles.find((p) => p.isDefault) ?? profiles[0];
      if (defaultProfile) {
        setProfileId(defaultProfile.id);
      }
    }
    if (settingsAccessMode !== undefined) {
      setAccessMode(settingsAccessMode);
    }
    if (settingsAllowedNumbers !== undefined) {
      setAllowedNumbers(settingsAllowedNumbers);
    }
    if (settingsBlockedNumbers !== undefined) {
      setBlockedNumbers(settingsBlockedNumbers);
    }
  }, [
    saveMutation.isPending,
    settingsProfileId,
    settingsAccessMode,
    settingsAllowedNumbers,
    settingsBlockedNumbers,
  ]);

  const configured = settings?.configured === true;
  const worker = status?.whatsappWorker;
  const running = worker?.running === true;
  const connected = worker?.connected === true;
  const qrCode = worker?.qrCode ?? null;
  const paired = Boolean(worker?.paired || settings?.pairedJid);
  const pairingCode = settings?.pairingCode ?? null;
  const linkedNumber = settings?.phoneNumberMasked ?? null;

  useEffect(() => {
    if (qrCode) {
      setQrWasVisible(true);
    }
    if (paired) {
      setQrWasVisible(false);
    }
  }, [qrCode, paired]);

  useEffect(() => {
    if (worker?.paired && !settings?.pairedJid) {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.whatsapp.settings,
      });
      return;
    }

    if (worker?.connected && !paired) {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.whatsapp.settings,
      });
    }
  }, [
    worker?.paired,
    worker?.connected,
    settings?.pairedJid,
    paired,
    queryClient,
  ]);

  useEffect(() => {
    setCopied(false);
  }, [pairingCode]);

  // The enable/stop hints go stale the moment the worker state flips; the
  // live subtitle already covers those cases, so drop the hint then.
  useEffect(() => {
    setHint(null);
  }, [running]);

  useEffect(
    () => () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    },
    []
  );

  const showQr = configured && running && !paired && Boolean(qrCode);
  const awaitingQr =
    configured &&
    !paired &&
    running &&
    !connected &&
    !qrCode &&
    !qrWasVisible &&
    !pairingCode;
  const bridgeStarting =
    configured && !paired && running && !connected && Boolean(pairingCode);
  const linkingAfterScan =
    configured && !paired && running && !qrCode && (qrWasVisible || connected);
  const showReconnect = configured && !showQr && !awaitingQr;
  const canSave =
    !configured ||
    profileId !== settings?.profileId ||
    accessMode !== (settings?.accessMode ?? "pairing") ||
    JSON.stringify(allowedNumbers) !==
      JSON.stringify(settings?.allowedNumbers ?? []) ||
    JSON.stringify(blockedNumbers) !==
      JSON.stringify(settings?.blockedNumbers ?? []);
  const actionLabel = submitLabel ?? (configured ? "Save" : "Enable WhatsApp");

  const statusLine =
    hint ??
    (formError ? formError : null) ??
    (loadError ? formatError(loadError) : null);

  const headerSubtitle = configured
    ? paired && running
      ? "WhatsApp is connected and ready to receive messages"
      : paired && !running
        ? "WhatsApp is linked. Start the bridge to receive messages"
        : running
          ? showQr
            ? "Scan the QR code in WhatsApp to link this device"
            : linkingAfterScan
              ? "Connecting WhatsApp…"
              : bridgeStarting
                ? "Preparing QR code…"
                : awaitingQr
                  ? "Preparing QR code…"
                  : "Scan the QR code in WhatsApp to connect"
          : "Bridge stopped — start it to get a QR code"
    : "Choose a reply profile, then enable WhatsApp";

  const statusBadge = configured
    ? paired && running
      ? "Connected"
      : paired && !running
        ? "Bridge stopped"
        : running
          ? linkingAfterScan
            ? "Connecting"
            : bridgeStarting
              ? "Starting…"
              : showQr
                ? "Awaiting scan"
                : awaitingQr
                  ? "Starting…"
                  : pairingCode
                    ? "Awaiting link"
                    : "Not connected"
          : "Stopped"
    : "Not set up";

  async function copyPairingCode() {
    if (!pairingCode) {
      return;
    }

    try {
      await navigator.clipboard.writeText(pairingCode);
      setCopied(true);
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
      copyTimeoutRef.current = setTimeout(() => {
        setCopied(false);
        copyTimeoutRef.current = null;
      }, 2000);
    } catch {
      setHint("Copy failed. Select the code and copy it manually.");
    }
  }

  function handleSave() {
    setFormError(null);
    setHint(null);

    const request: UpdateWhatsAppSettingsRequest = {
      accessMode,
      allowedNumbers: allowedNumbers.join(","),
      blockedNumbers: blockedNumbers.join(","),
      profileId: profileId.trim() || "default",
    };

    saveMutation.mutate(request, {
      onError: (error) => {
        setFormError(formatError(error));
      },
      onSuccess: (saved) => {
        if (saved.pairedJid) {
          setHint("Saved.");
        } else if (saved.pairingCode) {
          setHint(
            "Saved. Send the chat access code in the WhatsApp chat you want to authorize."
          );
        } else if (configured) {
          setHint("Saved.");
        } else {
          setHint("Enabled. Scan the QR code when it appears.");
        }
        onSaveSuccess?.();
      },
    });
  }

  function handleRegeneratePairingCode() {
    setFormError(null);
    setHint(null);

    regenerateMutation.mutate(undefined, {
      onError: (error) => {
        setFormError(formatError(error));
      },
      onSuccess: () => {
        setHint(
          "Chat access code generated. Send it in the WhatsApp chat you want to authorize."
        );
      },
    });
  }

  function handleReconnect() {
    setFormError(null);
    setHint(null);
    setQrWasVisible(false);

    reconnectMutation.mutate(undefined, {
      onError: (error) => {
        setFormError(formatError(error));
      },
      onSuccess: () => {
        setHint("Session reset. Scan the QR code when it appears.");
      },
    });
  }

  function handleProfileChange(nextProfileId: string) {
    setProfileId(nextProfileId);
    setHint(null);
    setFormError(null);
  }

  function handleAccessModeChange(nextMode: ChannelAccessMode) {
    setAccessMode(nextMode);
    setHint(null);
    setFormError(null);
  }

  function handleAllowedNumbersChange(nextNumbers: string[]) {
    setAllowedNumbers(nextNumbers);
    setHint(null);
    setFormError(null);
  }

  function handleBlockedNumbersChange(nextNumbers: string[]) {
    setBlockedNumbers(nextNumbers);
    setHint(null);
    setFormError(null);
  }

  if (isLoading) {
    if (embedded) {
      return SETTINGS_CARD_LOADING_SKELETON;
    }

    return <div className="py-3">{SETTINGS_CARD_LOADING_SKELETON}</div>;
  }

  const content = (
    <WhatsAppSettingsCardContent
      accessMode={accessMode}
      actionLabel={actionLabel}
      allowedNumbers={allowedNumbers}
      awaitingQr={awaitingQr}
      blockedNumbers={blockedNumbers}
      bridgeStarting={bridgeStarting}
      canSave={canSave}
      configured={configured}
      copied={copied}
      embedded={embedded}
      formError={formError}
      headerSubtitle={headerSubtitle}
      linkedNumber={linkedNumber}
      linkingAfterScan={linkingAfterScan}
      loadError={loadError}
      onAccessModeChange={handleAccessModeChange}
      onAllowedNumbersChange={handleAllowedNumbersChange}
      onBlockedNumbersChange={handleBlockedNumbersChange}
      onCopyPairingCode={() => void copyPairingCode()}
      onProfileChange={handleProfileChange}
      onReconnect={handleReconnect}
      onRegeneratePairingCode={handleRegeneratePairingCode}
      onSave={handleSave}
      paired={paired}
      pairingCode={pairingCode}
      profileId={profileId}
      profiles={profiles}
      qrCode={qrCode}
      reconnectPending={reconnectMutation.isPending}
      regeneratePending={regenerateMutation.isPending}
      running={running}
      savePending={saveMutation.isPending}
      showQr={showQr}
      showReconnect={showReconnect}
      statusBadge={statusBadge}
      statusLine={statusLine}
      worker={worker}
    />
  );

  if (embedded) {
    return (
      <div className="space-y-2">
        <p className="text-muted-foreground text-xs">{headerSubtitle}</p>
        {content}
      </div>
    );
  }

  return content;
}
