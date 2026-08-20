import { timingSafeEqual } from "node:crypto";
import {
  AtlasApiError,
  createTelegramOutboundAdapter,
  type NotificationWebhookRequest,
  normalizeNotificationWebhookRequest,
  type TelegramOutboundAdapter,
} from "@atlas/core";
import type { DatabaseAdapter } from "@atlas/db";
import type { AuthService } from "./auth-service";

function hashesEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function levelPrefix(level: NotificationWebhookRequest["level"]): string {
  switch (level) {
    case "success":
      return "✅";
    case "warning":
      return "⚠️";
    case "error":
      return "❌";
    case "info":
      return "ℹ️";
    default:
      return "🔔";
  }
}

function formatNotificationMessage(
  payload: NotificationWebhookRequest
): string {
  const prefix = levelPrefix(payload.level);

  if (payload.title) {
    return `${prefix} **${payload.title}**\n\n${payload.body}`;
  }

  return `${prefix} ${payload.body}`;
}

export class NotificationWebhookService {
  private readonly telegram: TelegramOutboundAdapter;

  constructor(
    private readonly databaseAdapter: DatabaseAdapter,
    private readonly authService: AuthService,
    telegram?: TelegramOutboundAdapter
  ) {
    this.telegram = telegram ?? createTelegramOutboundAdapter();
  }

  async deliver(
    destinationId: string,
    apiKey: string | null,
    payload: unknown
  ): Promise<void> {
    if (!apiKey) {
      throw new AtlasApiError("Invalid notification credentials.", 401);
    }

    const destination =
      await this.databaseAdapter.getNotificationDestination(destinationId);
    const presented = this.authService.hashToken(apiKey);
    const expected =
      destination?.secretHash ?? this.authService.hashToken("\0");
    if (!(hashesEqual(presented, expected) && destination)) {
      throw new AtlasApiError("Invalid notification credentials.", 401);
    }

    const normalized = normalizeNotificationWebhookRequest(payload);
    const result = await this.telegram.send({
      chatIds: [destination.config.chatId],
      orgId: destination.orgId,
      parseMode: "HTML",
      text: formatNotificationMessage(normalized),
      ...(destination.config.topicId
        ? { topicId: destination.config.topicId }
        : {}),
    });

    if (!result.ok) {
      throw new AtlasApiError(
        result.error ?? "Notification delivery failed.",
        502
      );
    }
  }
}
