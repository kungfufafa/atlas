import type { TelegramConfigFile } from "@atlas/core/telegram-config";
import {
  isTelegramUserAuthorized,
  loadTelegramConfigFile,
  verifyAndPairTelegramUser,
} from "@atlas/core/telegram-config";

export class TelegramAuthStore {
  private config: TelegramConfigFile | null = null;

  constructor(private readonly orgId?: string | null) {}

  async reload(): Promise<TelegramConfigFile | null> {
    this.config = await loadTelegramConfigFile(this.orgId);
    return this.config;
  }

  getConfig(): TelegramConfigFile | null {
    return this.config;
  }

  isAuthorized(userId: number): boolean {
    if (!this.config) {
      return false;
    }

    return isTelegramUserAuthorized(userId, this.config);
  }

  async tryPair(
    handshakeInput: string,
    userId: number
  ): Promise<{ ok: boolean; message: string }> {
    const result = await verifyAndPairTelegramUser(
      handshakeInput,
      userId,
      this.orgId
    );
    await this.reload();
    return result;
  }
}
