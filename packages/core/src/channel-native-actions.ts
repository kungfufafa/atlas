import { z } from "zod";

export const nativeChannelSchema = z.enum(["telegram", "whatsapp", "discord"]);
export type NativeChannel = z.infer<typeof nativeChannelSchema>;
const messageId = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1).max(4000);
const name = z.string().trim().min(1).max(100);

/** Destinations and identities come from the live worker turn, never model arguments. */
export const channelNativeActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      emoji: z.string().max(100),
      kind: z.literal("react"),
      messageId: messageId.optional(),
    })
    .strict(),
  z
    .object({
      allowMultiple: z.boolean().optional(),
      anonymous: z.boolean().optional(),
      durationHours: z.number().int().min(1).max(168).optional(),
      kind: z.literal("poll"),
      openPeriodSeconds: z.number().int().min(5).max(600).optional(),
      options: z.array(z.string().trim().min(1).max(100)).min(2).max(10),
      question: z.string().trim().min(1).max(300),
    })
    .strict(),
  z.object({ kind: z.literal("edit"), messageId, text }).strict(),
  z.object({ kind: z.literal("delete"), messageId }).strict(),
  z.object({ kind: z.literal("pin"), messageId }).strict(),
  z.object({ kind: z.literal("unpin"), messageId }).strict(),
  z.object({ kind: z.literal("topic_create"), name }).strict(),
  z
    .object({
      closed: z.boolean().optional(),
      kind: z.literal("topic_edit"),
      name: name.optional(),
    })
    .strict()
    .refine(
      (action) => action.name !== undefined || action.closed !== undefined
    ),
  z
    .object({ kind: z.literal("thread_create"), name, text: text.optional() })
    .strict(),
  z
    .object({
      kind: z.literal("send_media"),
      mode: z.enum(["voice", "audio", "video", "document"]),
      path: z.string().trim().min(1).max(1024),
    })
    .strict(),
]);
export type ChannelNativeAction = z.infer<typeof channelNativeActionSchema>;
export type ChannelNativeActionKind = ChannelNativeAction["kind"];

export interface ChannelNativeActionRequest {
  action: ChannelNativeAction;
  channel: NativeChannel;
  channelAddressed?: boolean;
  channelChatId: string;
  channelIsGroup?: boolean;
  channelThreadId?: string;
  expiresAt: string;
  id: string;
  orgId: string;
  profileId: string;
  sessionId: string;
}

export const channelActionReceiptSchema = z
  .object({
    error: z.string().max(1000).optional(),
    messageId: messageId.optional(),
    resourceId: messageId.optional(),
    status: z.enum(["accepted", "failed", "unknown"]),
    threadId: messageId.optional(),
  })
  .strict()
  .refine(
    (receipt) =>
      receipt.status === "accepted"
        ? !receipt.error
        : Boolean(receipt.error?.trim()),
    {
      message:
        "Failed or uncertain receipts require an error; accepted receipts cannot include an error",
    }
  );
export type ChannelActionReceipt = z.infer<typeof channelActionReceiptSchema>;

export interface ChannelActionActor {
  channel?: NativeChannel;
  channelAddressed?: boolean;
  channelChatId: string;
  channelIsGroup?: boolean;
  channelThreadId?: string;
  channelUserAliases?: string[];
  channelUserId: string;
  sessionId: string;
}
export interface ClaimChannelActionInput extends ChannelActionActor {
  requestId: string;
}
export interface CompleteChannelActionInput extends ClaimChannelActionInput {
  receipt: ChannelActionReceipt;
}

export interface DecideChannelApprovalInput {
  approvalId: string;
  channel: NativeChannel;
  channelAddressed?: boolean;
  channelChatId: string;
  channelIsGroup: boolean;
  channelThreadId?: string;
  channelUserAliases?: string[];
  channelUserId: string;
  decision: "approved" | "denied";
  profileId?: string;
  sessionId: string;
}
