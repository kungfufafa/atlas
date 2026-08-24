import type { ChannelAccessMode, ProfileSummary } from "@atlas/core/contract";
import { useState } from "react";
import {
  CHANNEL_ACCESS_MODE_OPTIONS,
  channelAccessModeLabel,
  IntegrationSettingsFooter,
  IntegrationStatusHeader,
  SettingsRow,
} from "@/components/integration-settings.shared";
import { ProfileAvatar } from "@/components/ProfileAvatar";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupInput } from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WhatsAppNumbersDialog } from "@/components/WhatsAppNumbersDialog";
import { WorkerActionBar } from "@/components/WorkerActionBar";
import {
  shouldShowWhatsAppChatAccessSection,
  WhatsAppSettingsChatAccessSection,
  WhatsAppSettingsDeviceLinkSection,
} from "@/components/whatsapp-settings-linking-section";
import { cn } from "@/lib/utils";

export function WhatsAppSettingsCardContent({
  embedded,
  headerSubtitle,
  statusBadge,
  configured,
  paired,
  running,
  showQr,
  linkedNumber,
  accessMode,
  onAccessModeChange,
  allowedNumbers,
  onAllowedNumbersChange,
  blockedNumbers,
  onBlockedNumbersChange,
  profileId,
  profiles,
  savePending,
  onProfileChange,
  phoneNumber,
  onPhoneNumberChange,
  pairingCode,
  copied,
  onCopyPairingCode,
  onRegeneratePairingCode,
  devicePairingCode,
  copiedDevicePairingCode,
  onCopyDevicePairingCode,
  regeneratePending,
  qrCode,
  linkingAfterScan,
  bridgeStarting,
  awaitingQr,
  awaitingDevicePairingCode,
  showReconnect,
  onReconnect,
  reconnectPending,
  worker,
  statusLine,
  formError,
  loadError,
  canSave,
  actionLabel,
  onSave,
}: {
  actionLabel: string;
  allowedNumbers: string[];
  accessMode: ChannelAccessMode;
  awaitingQr: boolean;
  blockedNumbers: string[];
  bridgeStarting: boolean;
  canSave: boolean;
  configured: boolean;
  copied: boolean;
  embedded: boolean;
  formError: string | null;
  headerSubtitle: string;
  linkedNumber: string | null;
  linkingAfterScan: boolean;
  loadError: unknown;
  onAccessModeChange: (mode: ChannelAccessMode) => void;
  onAllowedNumbersChange: (numbers: string[]) => void;
  onBlockedNumbersChange: (numbers: string[]) => void;
  onCopyDevicePairingCode: () => void;
  onCopyPairingCode: () => void;
  onPhoneNumberChange: (phoneNumber: string) => void;
  onProfileChange: (profileId: string) => void;
  onReconnect: () => void;
  onRegeneratePairingCode: () => void;
  onSave: () => void;
  awaitingDevicePairingCode: boolean;
  copiedDevicePairingCode: boolean;
  devicePairingCode: string | null;
  paired: boolean;
  pairingCode: string | null;
  phoneNumber: string;
  profileId: string;
  profiles: ProfileSummary[];
  qrCode: string | null;
  reconnectPending: boolean;
  regeneratePending: boolean;
  running: boolean;
  savePending: boolean;
  showQr: boolean;
  showReconnect: boolean;
  statusBadge: string;
  statusLine: string | null;
  worker: { process?: { managed?: boolean } } | null | undefined;
}) {
  const paneItemClass = embedded ? undefined : "px-0 py-0";
  const [allowlistOpen, setAllowlistOpen] = useState(false);
  const [denylistOpen, setDenylistOpen] = useState(false);

  return (
    <div className={cn(!embedded && "space-y-4 py-4")}>
      {embedded ? null : (
        <IntegrationStatusHeader
          className={paneItemClass}
          configured={configured}
          connected={paired && running}
          statusBadge={statusBadge}
          subtitle={headerSubtitle}
          title="WhatsApp"
        />
      )}

      {paired && linkedNumber ? (
        <SettingsRow
          className={paneItemClass}
          description="From your WhatsApp session"
          label="Linked account"
        >
          <span className="text-foreground text-sm">{linkedNumber}</span>
        </SettingsRow>
      ) : null}

      {paired ? null : (
        <SettingsRow className={paneItemClass} label="Phone number">
          <InputGroup className="w-full min-w-[12rem] sm:w-[16rem]">
            <InputGroupInput
              autoComplete="tel"
              disabled={savePending}
              id="whatsapp-phone-number"
              onChange={(event) => {
                onPhoneNumberChange(event.target.value);
              }}
              placeholder={
                linkedNumber ? `Saved (${linkedNumber})` : "e.g. 628123456789"
              }
              type="tel"
              value={phoneNumber}
            />
          </InputGroup>
        </SettingsRow>
      )}

      <SettingsRow
        className={paneItemClass}
        description="Which agent answers on WhatsApp"
        label="Reply as"
      >
        <Select
          disabled={profiles.length === 0}
          onValueChange={(value) => {
            if (value) {
              onProfileChange(String(value));
            }
          }}
          value={profileId}
        >
          <SelectTrigger
            className="w-[11rem] sm:w-[13rem]"
            id="whatsapp-profile"
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

      {configured ? (
        <WhatsAppSettingsDeviceLinkSection
          awaitingDevicePairingCode={awaitingDevicePairingCode}
          awaitingQr={awaitingQr}
          bridgeStarting={bridgeStarting}
          compact={!embedded}
          copiedDevicePairingCode={copiedDevicePairingCode}
          devicePairingCode={devicePairingCode}
          linkingAfterScan={linkingAfterScan}
          onCopyDevicePairingCode={onCopyDevicePairingCode}
          onReconnect={onReconnect}
          paired={paired}
          qrCode={qrCode}
          reconnectPending={reconnectPending}
          regeneratePending={regeneratePending}
          rowClassName={paneItemClass}
          running={running}
          savePending={savePending}
          showQr={showQr}
          showReconnect={false}
        />
      ) : null}

      <SettingsRow
        className={paneItemClass}
        description="Controls who is permitted to chat with the assistant"
        label="Access mode"
      >
        <div className="flex items-center gap-2">
          <Select
            onValueChange={(value) => {
              if (value) {
                onAccessModeChange(value as ChannelAccessMode);
              }
            }}
            value={accessMode}
          >
            <SelectTrigger
              className="w-[11rem] sm:w-[13rem]"
              id="whatsapp-access-mode"
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

          {accessMode === "allowlist" ? (
            <Button
              onClick={() => setAllowlistOpen(true)}
              size="sm"
              type="button"
              variant="outline"
            >
              {allowedNumbers.length === 0
                ? "Configure allowed list"
                : `${allowedNumbers.length} allowed`}
            </Button>
          ) : null}

          {accessMode === "denylist" ? (
            <Button
              onClick={() => setDenylistOpen(true)}
              size="sm"
              type="button"
              variant="outline"
            >
              {blockedNumbers.length === 0
                ? "Configure blocked list"
                : `${blockedNumbers.length} blocked`}
            </Button>
          ) : null}
        </div>
      </SettingsRow>

      <WhatsAppNumbersDialog
        numbers={allowedNumbers}
        onNumbersChange={onAllowedNumbersChange}
        onOpenChange={setAllowlistOpen}
        open={allowlistOpen}
        title="Allowed Phone Numbers"
      />

      <WhatsAppNumbersDialog
        numbers={blockedNumbers}
        onNumbersChange={onBlockedNumbersChange}
        onOpenChange={setDenylistOpen}
        open={denylistOpen}
        title="Blocked Phone Numbers"
      />

      {configured && shouldShowWhatsAppChatAccessSection(accessMode) ? (
        <WhatsAppSettingsChatAccessSection
          compact={!embedded}
          copied={copied}
          onCopyPairingCode={onCopyPairingCode}
          onRegeneratePairingCode={onRegeneratePairingCode}
          paired={paired}
          pairingCode={pairingCode}
          regeneratePending={regeneratePending}
          rowClassName={paneItemClass}
          savePending={savePending}
        />
      ) : null}

      {configured ? (
        <WhatsAppSettingsDeviceLinkSection
          awaitingDevicePairingCode={false}
          awaitingQr={false}
          bridgeStarting={false}
          compact={!embedded}
          copiedDevicePairingCode={copiedDevicePairingCode}
          devicePairingCode={null}
          linkingAfterScan={false}
          onCopyDevicePairingCode={onCopyDevicePairingCode}
          onReconnect={onReconnect}
          paired={paired}
          qrCode={null}
          reconnectPending={reconnectPending}
          regeneratePending={regeneratePending}
          rowClassName={paneItemClass}
          running={running}
          savePending={savePending}
          showQr={false}
          showReconnect={showReconnect}
        />
      ) : null}

      {configured ? (
        <SettingsRow
          className={paneItemClass}
          description={running ? "Running" : "Stopped"}
          label="Bridge worker"
        >
          <WorkerActionBar
            pm2Managed={worker?.process?.managed ?? false}
            running={running}
            workerName="whatsapp"
          />
        </SettingsRow>
      ) : null}

      <IntegrationSettingsFooter
        canSave={canSave}
        className={paneItemClass}
        formError={formError}
        loadError={loadError}
        onSave={onSave}
        savePending={savePending}
        statusLine={statusLine}
        submitLabel={actionLabel}
      />
    </div>
  );
}
