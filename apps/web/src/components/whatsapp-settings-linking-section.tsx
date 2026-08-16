import {
  CheckmarkCircle01Icon,
  Copy01Icon,
  QrCodeScanIcon,
  RefreshIcon,
} from "hugeicons-react";
import { QRCodeSVG } from "qrcode.react";
import { SettingsRow } from "@/components/integration-settings.shared";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export function WhatsAppSettingsLinkingSection({
  paired,
  pairingCode,
  copied,
  savePending,
  regeneratePending,
  onCopyPairingCode,
  onRegeneratePairingCode,
  showQr,
  qrCode,
  linkingAfterScan,
  bridgeStarting,
  awaitingQr,
  showReconnect,
  showPairingSection = true,
  reconnectPending,
  onReconnect,
  running,
  rowClassName,
  compact = false,
}: {
  paired: boolean;
  pairingCode: string | null;
  copied: boolean;
  savePending: boolean;
  regeneratePending: boolean;
  onCopyPairingCode: () => void;
  onRegeneratePairingCode: () => void;
  showQr: boolean;
  qrCode: string | null;
  linkingAfterScan: boolean;
  bridgeStarting: boolean;
  awaitingQr: boolean;
  showReconnect: boolean;
  showPairingSection?: boolean;
  reconnectPending: boolean;
  onReconnect: () => void;
  running: boolean;
  rowClassName?: string;
  compact?: boolean;
}) {
  return (
    <div className={cn("space-y-4", !paired && "bg-muted/20")}>
      {showPairingSection ? (
        <>
          <SettingsRow
            className={rowClassName}
            description={
              pairingCode
                ? "Send this code in the WhatsApp chat you want to authorize."
                : paired
                  ? "Generate a one-time code to authorize a WhatsApp chat."
                  : "Scan the QR code to link WhatsApp before authorizing chats."
            }
            label="Chat access code"
          >
            {pairingCode ? (
              <div className="flex flex-wrap items-center justify-end gap-2">
                <code className="rounded-md border border-border bg-background px-2.5 py-1 text-sm tracking-widest">
                  {pairingCode}
                </code>
                <Button
                  onClick={onCopyPairingCode}
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
                  onClick={onRegeneratePairingCode}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {regeneratePending ? (
                    <Spinner />
                  ) : (
                    <>
                      <RefreshIcon aria-hidden="true" className="size-3.5" />
                      Generate new code
                    </>
                  )}
                </Button>
              </div>
            ) : paired ? (
              <Button
                disabled={!paired || regeneratePending || savePending}
                onClick={onRegeneratePairingCode}
                size="sm"
                type="button"
                variant="outline"
              >
                {regeneratePending ? (
                  <Spinner />
                ) : (
                  <>
                    <RefreshIcon aria-hidden="true" className="size-3.5" />
                    Generate code
                  </>
                )}
              </Button>
            ) : (
              <Button
                disabled={!paired || regeneratePending || savePending}
                onClick={onRegeneratePairingCode}
                size="sm"
                type="button"
                variant="outline"
              >
                {regeneratePending ? (
                  <>
                    <Spinner className="size-3" />
                    Generating…
                  </>
                ) : (
                  "Link a device first"
                )}
              </Button>
            )}
          </SettingsRow>

          {pairingCode ? (
            <ol
              className={cn(
                "list-decimal space-y-1 pl-5 text-muted-foreground text-xs",
                !compact && "px-4 py-3 pl-8"
              )}
            >
              <li>Open a private chat with the connected WhatsApp account</li>
              <li>Send the code as a message</li>
            </ol>
          ) : null}
        </>
      ) : null}

      {showQr ? (
        <div className={cn("space-y-3", !compact && "px-4 py-4")}>
          <div className="flex items-center gap-2">
            <QrCodeScanIcon aria-hidden className="size-4 text-primary" />
            <p className="font-medium text-foreground text-sm">
              Link WhatsApp with a QR code
            </p>
          </div>
          <div className="flex justify-center">
            <div className="inline-flex rounded-xl border border-border bg-white p-3">
              <QRCodeSVG size={180} value={qrCode!} />
            </div>
          </div>
          <ol className="list-decimal space-y-1 pl-5 text-muted-foreground text-xs">
            <li>Open WhatsApp on your phone</li>
            <li>Go to Settings, then Linked Devices</li>
            <li>
              Tap <strong>Link a Device</strong> and scan this code
            </li>
          </ol>
        </div>
      ) : linkingAfterScan ? (
        <div
          className={cn(
            "flex items-center gap-2 text-muted-foreground text-sm",
            !compact && "px-4 py-4"
          )}
        >
          <Spinner className="size-4" />
          Connecting WhatsApp…
        </div>
      ) : bridgeStarting ? (
        <div
          className={cn(
            "flex items-center gap-2 text-muted-foreground text-sm",
            !compact && "px-4 py-4"
          )}
        >
          <Spinner className="size-4" />
          Preparing QR code…
        </div>
      ) : awaitingQr ? (
        <div
          className={cn(
            "flex items-center gap-2 text-muted-foreground text-sm",
            !compact && "px-4 py-4"
          )}
        >
          <Spinner className="size-4" />
          Preparing QR code…
        </div>
      ) : null}

      {showReconnect ? (
        <SettingsRow
          className={rowClassName}
          description={
            paired
              ? "Unlinks the current session so you can scan a new QR code"
              : running
                ? "Clears a stuck session so you can link again with a QR code"
                : "Starts the bridge and shows a fresh QR code to link"
          }
          label="Reconnect"
        >
          <Button
            disabled={reconnectPending || savePending || regeneratePending}
            onClick={onReconnect}
            size="sm"
            type="button"
            variant="outline"
          >
            {reconnectPending ? (
              <>
                <Spinner className="size-3" />
                Resetting…
              </>
            ) : (
              <>
                <QrCodeScanIcon aria-hidden="true" className="size-3.5" />
                Reconnect with QR
              </>
            )}
          </Button>
        </SettingsRow>
      ) : null}
    </div>
  );
}
