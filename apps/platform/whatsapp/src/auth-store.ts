import type { WhatsAppConfigFile } from "@atlas/core/whatsapp-config";
import {
  isWhatsAppUserAuthorized,
  loadWhatsAppConfigFile,
  verifyAndPairWhatsAppUser,
} from "@atlas/core/whatsapp-config";

export class WhatsAppAuthStore {
  private config: WhatsAppConfigFile | null = null;

  constructor(private readonly orgId?: string | null) {}

  async reload(): Promise<WhatsAppConfigFile | null> {
    this.config = await loadWhatsAppConfigFile(this.orgId);
    return this.config;
  }

  getConfig(): WhatsAppConfigFile | null {
    return this.config;
  }

  isAuthorized(jid: string): boolean {
    if (!this.config) {
      return false;
    }

    return isWhatsAppUserAuthorized(jid, this.config);
  }

  async tryPair(
    pairingCodeInput: string,
    jid: string
  ): Promise<{ ok: boolean; message: string }> {
    const result = await verifyAndPairWhatsAppUser(
      pairingCodeInput,
      jid,
      this.orgId
    );
    await this.reload();
    return result;
  }
}
