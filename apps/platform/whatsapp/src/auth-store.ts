import type {
  WhatsAppConfigFile,
  WhatsAppPairingPrincipalBinder,
} from "@atlas/core/whatsapp-config";
import {
  isWhatsAppUserAuthorized,
  loadWhatsAppConfigFile,
  loadWhatsAppLidMap,
  lookupWhatsAppLidPhone,
  rememberWhatsAppLidPhone,
  verifyAndPairWhatsAppUser,
} from "@atlas/core/whatsapp-config";

export class WhatsAppAuthStore {
  private config: WhatsAppConfigFile | null = null;
  private lidMap: Record<string, string> = {};

  constructor(private readonly orgId?: string | null) {}

  async reload(): Promise<WhatsAppConfigFile | null> {
    this.config = await loadWhatsAppConfigFile(this.orgId);
    this.lidMap = await loadWhatsAppLidMap(this.orgId);
    return this.config;
  }

  getConfig(): WhatsAppConfigFile | null {
    return this.config;
  }

  isAuthorized(jid: string, extras?: { senderPn?: string | null }): boolean {
    if (!this.config) {
      return false;
    }

    return isWhatsAppUserAuthorized(
      {
        jid,
        mappedPhoneJid: lookupWhatsAppLidPhone(this.lidMap, jid),
        senderPn: extras?.senderPn,
      },
      this.config
    );
  }

  isPairedIdentity(
    jid: string,
    extras?: { senderPn?: string | null }
  ): boolean {
    if (!this.config) {
      return false;
    }

    return isWhatsAppUserAuthorized(
      {
        jid,
        mappedPhoneJid: lookupWhatsAppLidPhone(this.lidMap, jid),
        senderPn: extras?.senderPn,
      },
      { ...this.config, accessMode: "pairing" }
    );
  }

  async rememberSenderPn(
    remoteJid: string,
    senderPn?: string | null
  ): Promise<void> {
    if (!senderPn?.trim()) {
      return;
    }

    const stored = await rememberWhatsAppLidPhone(
      remoteJid,
      senderPn,
      this.orgId
    );
    if (!stored) {
      return;
    }

    this.lidMap = await loadWhatsAppLidMap(this.orgId);
  }

  async tryPair(
    pairingCodeInput: string,
    jid: string,
    bindPrincipal: WhatsAppPairingPrincipalBinder
  ): Promise<{
    ok: boolean;
    message: string;
  }> {
    try {
      return await verifyAndPairWhatsAppUser(
        pairingCodeInput,
        jid,
        bindPrincipal,
        this.orgId
      );
    } finally {
      await this.reload();
    }
  }
}
