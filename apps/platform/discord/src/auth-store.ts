import type { DiscordConfigFile } from "@atlas/core/discord-config";
import {
  type DiscordPairingPrincipalBinder,
  isDiscordUserAuthorized,
  loadDiscordConfigFile,
  verifyAndPairDiscordUser,
} from "@atlas/core/discord-config";

export class DiscordAuthStore {
  private config: DiscordConfigFile | null = null;

  constructor(private readonly orgId?: string | null) {}

  async reload(): Promise<DiscordConfigFile | null> {
    this.config = await loadDiscordConfigFile(this.orgId);
    return this.config;
  }

  getConfig(): DiscordConfigFile | null {
    return this.config;
  }

  isAuthorized(userId: string): boolean {
    if (!this.config) {
      return false;
    }

    return isDiscordUserAuthorized(userId, this.config);
  }

  /** Paired bridge owners — admin for Discord bot management commands. */
  isPaired(userId: string): boolean {
    return this.config?.pairedUserIds.includes(userId) ?? false;
  }

  async tryPair(
    handshakeInput: string,
    userId: string,
    bindPrincipal?: DiscordPairingPrincipalBinder
  ): Promise<{ ok: boolean; message: string }> {
    const result = await verifyAndPairDiscordUser(
      handshakeInput,
      userId,
      this.orgId,
      bindPrincipal
    );
    await this.reload();
    return result;
  }
}
