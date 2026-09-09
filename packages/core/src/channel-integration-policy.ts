import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { AtlasApiError } from "./api-error";
import type {
  ChannelNativeActionKind,
  NativeChannel,
} from "./channel-native-actions";
import { writePrivateTextFile } from "./fs";
import type { CanonicalPrincipal } from "./identity/principal";
import { toWhatsAppPhoneJid } from "./whatsapp-config";
import { getWorkspaceChannelDir } from "./workspace-channel-paths";

const identifier = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (value) => !["__proto__", "constructor", "prototype"].includes(value)
  );
const ids = z.array(identifier).max(500);
export const channelActionKindSchema = z.enum([
  "react",
  "poll",
  "edit",
  "delete",
  "pin",
  "unpin",
  "topic_create",
  "topic_edit",
  "thread_create",
  "send_media",
]);
const actions = z.partialRecord(channelActionKindSchema, z.boolean());
export const channelRuleSchema = z
  .object({
    actions: actions.optional(),
    allowedSenders: ids.optional(),
    allowedTools: ids.optional(),
    blockedSenders: ids.optional(),
    enabled: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    roles: z
      .array(z.enum(["admin", "member", "viewer"]))
      .max(3)
      .optional(),
  })
  .strict();
export type ChannelIntegrationRule = z.infer<typeof channelRuleSchema>;
const rules = z
  .custom<Record<string, unknown>>(
    (value) =>
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length <= 500 &&
      Object.keys(value).every((key) => identifier.safeParse(key).success)
  )
  .pipe(z.record(identifier, channelRuleSchema));
export const channelIntegrationPolicySchema = z
  .object({
    actions: actions.optional(),
    approvals: z.boolean().optional(),
    dm: channelRuleSchema.optional(),
    enabled: z.boolean().optional(),
    groups: channelRuleSchema.optional(),
    rooms: rules.optional(),
    senders: rules.optional(),
    speech: z
      .object({
        model: identifier,
        providerId: identifier,
        transport: z.literal("openai-audio-speech"),
        voice: identifier,
      })
      .strict()
      .optional(),
    version: z.literal(1),
    voice: z
      .object({
        allowedRoomIds: ids,
        enabled: z.boolean(),
        maxSessionSeconds: z.number().int().min(10).max(3600).optional(),
        maxUtteranceSeconds: z.number().int().min(1).max(60).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ChannelIntegrationPolicy = z.infer<
  typeof channelIntegrationPolicySchema
>;
export interface ChannelPolicyOrigin {
  channelAddressed?: boolean;
  channelChatId?: string;
  channelIsGroup?: boolean;
  channelThreadId?: string;
  channelUserAliases?: string[];
  channelUserId: string;
}

export function getChannelIntegrationPolicyPath(
  orgId: string,
  channel: NativeChannel
): string {
  return join(getWorkspaceChannelDir(channel, orgId), "native-policy.json");
}
export async function loadChannelIntegrationPolicy(
  orgId: string,
  channel: NativeChannel
): Promise<ChannelIntegrationPolicy> {
  let raw: string;
  try {
    raw = await readFile(
      getChannelIntegrationPolicyPath(orgId, channel),
      "utf8"
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1 };
    }
    throw error;
  }
  if (Buffer.byteLength(raw) > 1024 * 1024) {
    throw new AtlasApiError("Channel policy exceeds the supported size", 403);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new AtlasApiError(
      "Channel policy is invalid; administrator correction required",
      403
    );
  }
  const parsed = channelIntegrationPolicySchema.safeParse(value);
  if (!parsed.success) {
    throw new AtlasApiError(
      "Channel policy is invalid; administrator correction required",
      403
    );
  }
  return parsed.data;
}
export async function saveChannelIntegrationPolicy(
  orgId: string,
  channel: NativeChannel,
  input: unknown
): Promise<ChannelIntegrationPolicy> {
  const parsed = channelIntegrationPolicySchema.safeParse(input);
  if (!parsed.success) {
    throw new AtlasApiError("Invalid channel integration policy", 400);
  }
  const policy = parsed.data;
  if (Buffer.byteLength(JSON.stringify(policy)) > 1024 * 1024) {
    throw new AtlasApiError("Channel policy exceeds the supported size", 400);
  }
  const file = getChannelIntegrationPolicyPath(orgId, channel);
  await writePrivateTextFile(file, `${JSON.stringify(policy, null, 2)}\n`, {
    ensureDir: dirname(file),
  });
  return policy;
}
function senderKeys(
  channel: NativeChannel,
  origin: ChannelPolicyOrigin
): string[] {
  return [
    ...new Set(
      [origin.channelUserId, ...(origin.channelUserAliases ?? [])].map((id) =>
        channel === "whatsapp" ? (toWhatsAppPhoneJid(id) ?? id) : id.trim()
      )
    ),
  ];
}
export function effectiveChannelRules(
  policy: ChannelIntegrationPolicy,
  channel: NativeChannel,
  origin: ChannelPolicyOrigin
): ChannelIntegrationRule[] {
  const selected: ChannelIntegrationRule[] = [];
  const mode = origin.channelIsGroup ? policy.groups : policy.dm;
  if (mode) {
    selected.push(mode);
  }
  for (const key of ["*", origin.channelChatId, origin.channelThreadId]) {
    if (key && policy.rooms && Object.hasOwn(policy.rooms, key)) {
      selected.push(policy.rooms[key]!);
    }
  }
  const actors = senderKeys(channel, origin);
  for (const [key, rule] of Object.entries(policy.senders ?? {})) {
    const normalized =
      channel === "whatsapp" ? (toWhatsAppPhoneJid(key) ?? key) : key;
    if (key === "*" || actors.includes(normalized)) {
      selected.push(rule);
    }
  }
  return selected;
}
export function assertChannelIntegrationPolicy(
  policy: ChannelIntegrationPolicy,
  channel: NativeChannel,
  origin: ChannelPolicyOrigin,
  principal: CanonicalPrincipal,
  options: {
    action?: ChannelNativeActionKind;
    tool?: string;
    approval?: boolean;
  } = {}
): void {
  const fail = () => {
    throw new AtlasApiError(
      "Current channel integration policy denies this action",
      403
    );
  };
  if (
    policy.enabled === false ||
    (options.approval && policy.approvals === false) ||
    (options.action && policy.actions?.[options.action] === false)
  ) {
    fail();
  }
  if (
    (policy.dm || policy.groups || policy.rooms || policy.senders) &&
    (!origin.channelChatId || origin.channelIsGroup === undefined)
  ) {
    fail();
  }
  const actors = senderKeys(channel, origin);
  const matches = (values: string[]) =>
    values.some(
      (value) =>
        value === "*" ||
        actors.includes(
          channel === "whatsapp" ? (toWhatsAppPhoneJid(value) ?? value) : value
        )
    );
  for (const rule of effectiveChannelRules(policy, channel, origin)) {
    if (
      rule.enabled === false ||
      (rule.blockedSenders && matches(rule.blockedSenders))
    ) {
      fail();
    }
    if (rule.allowedSenders && !matches(rule.allowedSenders)) {
      fail();
    }
    if (
      rule.roles &&
      !rule.roles.includes(
        principal.isPlatformAdmin ? "admin" : principal.orgRole
      )
    ) {
      fail();
    }
    if (
      options.tool &&
      rule.allowedTools &&
      !rule.allowedTools.includes(options.tool) &&
      !rule.allowedTools.includes("*")
    ) {
      fail();
    }
    if (options.action && rule.actions?.[options.action] === false) {
      fail();
    }
    if (
      origin.channelIsGroup &&
      rule.requireMention === true &&
      origin.channelAddressed !== true
    ) {
      fail();
    }
  }
}
