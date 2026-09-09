import { AtlasApiError, type ProviderInstance } from "@atlas/core";
import { loadChannelIntegrationPolicy } from "@atlas/core/channel-integration-policy";
import {
  type ChannelActionActor,
  type NativeChannel,
  nativeChannelSchema,
} from "@atlas/core/channel-native-actions";
import { z } from "zod";
import {
  decodeAudioTranscriptionData,
  resolveTranscriptionProviderSelection,
  transcribeAudio,
} from "../../services/audio-transcription";
import { authorizeChannelAction } from "../../services/channel-action-authorization";
import {
  assertChannelSpeechWav,
  resolveChannelSpeech,
  synthesizeChannelSpeechBytes,
} from "../../services/channel-speech-service";
import type { ServerOptions } from "../context";
import { requireActiveOrgIdFromContext } from "../org-guards";
import {
  errorResponse,
  getRequestAuth,
  json,
  readJsonWithLimit,
} from "../shared";
import type { HonoApp } from "../types";

const id = z.string().trim().min(1).max(200);
const actorSchema = z
  .object({
    channel: nativeChannelSchema.optional(),
    channelUserId: id,
    channelUserAliases: z.array(id).max(8).optional(),
    sessionId: id,
    channelChatId: id,
    channelThreadId: id.optional(),
    channelIsGroup: z.boolean(),
    channelAddressed: z.boolean().optional(),
  })
  .strict();
const speechSchema = actorSchema.extend({ text: z.string().min(1).max(4096) });
const transcriptionSchema = actorSchema.extend({
  data: z.string().min(1).max(35_000_000),
  filename: z.string().max(200).optional(),
  mediaType: z.literal("audio/wav"),
});

async function authorizeVoice(
  options: ServerOptions,
  orgId: string,
  channel: NativeChannel,
  actor: ChannelActionActor
) {
  if (!options.databaseAdapter) {
    throw new AtlasApiError("Database unavailable", 500);
  }
  const principal = await authorizeChannelAction(
    options.databaseAdapter,
    options.agent.identityService,
    { ...actor, channel, orgId, intent: "files" }
  );
  options.agent.channelNativeActions.assertBoundActor(
    orgId,
    channel,
    actor,
    principal.userId
  );
  const policy = await loadChannelIntegrationPolicy(orgId, channel);
  const room = actor.channelThreadId ?? actor.channelChatId;
  if (!(policy.voice?.enabled && policy.voice.allowedRoomIds.includes(room))) {
    throw new AtlasApiError(
      "Voice is not enabled for this workspace room",
      403
    );
  }
  const config = await options.agent.getUserConfigForOrg(orgId);
  return { config, policy, principal };
}

export function registerChannelVoiceRoutes(
  app: HonoApp,
  options: ServerOptions
): void {
  for (const operation of ["capabilities", "speech", "transcribe"] as const) {
    app.post(`/v1/channel-voice/${operation}`, async (c) => {
      const auth = getRequestAuth(c);
      const channel = nativeChannelSchema.safeParse(
        auth.workspaceWorker?.channel
      );
      if (!channel.success) {
        return errorResponse("A scoped messenger worker is required", 403);
      }
      const schema =
        operation === "speech"
          ? speechSchema
          : operation === "transcribe"
            ? transcriptionSchema
            : actorSchema;
      const parsed = schema.safeParse(
        await readJsonWithLimit<unknown>(
          c.req.raw,
          operation === "transcribe" ? 35 * 1024 * 1024 : 32 * 1024
        )
      );
      if (!parsed.success) {
        return errorResponse("Invalid channel voice request", 400);
      }
      if (parsed.data.channel && parsed.data.channel !== channel.data) {
        return errorResponse("Worker channel mismatch", 403);
      }
      const actor = actorSchema.parse({
        channel: parsed.data.channel,
        channelUserId: parsed.data.channelUserId,
        channelUserAliases: parsed.data.channelUserAliases,
        sessionId: parsed.data.sessionId,
        channelChatId: parsed.data.channelChatId,
        channelThreadId: parsed.data.channelThreadId,
        channelIsGroup: parsed.data.channelIsGroup,
        channelAddressed: parsed.data.channelAddressed,
      });
      const orgId = requireActiveOrgIdFromContext(c);
      const current = await authorizeVoice(options, orgId, channel.data, actor);
      const recordUsage = async (
        instance: ProviderInstance,
        modelId: string,
        capability: string
      ) => {
        const session = await options.databaseAdapter!.getSession(
          actor.sessionId
        );
        if (!session) {
          return;
        }
        await options.databaseAdapter!.incrementLlmUsageDaily(
          {
            orgId,
            userId: current.principal.userId,
            profileId: session.profileId,
            channel: channel.data,
            capability,
            modelId,
            providerCredentialId: instance.id,
            providerType: instance.type,
          },
          {
            estimatedCostUsd: 0,
            inputTokens: 0,
            outputTokens: 0,
            requestCount: 1,
          }
        );
      };
      let transcription: ReturnType<
        typeof resolveTranscriptionProviderSelection
      > = null;
      try {
        transcription = resolveTranscriptionProviderSelection(
          current.config,
          {}
        );
      } catch {
        /* Unusable explicit capability remains unavailable. */
      }
      const speech = resolveChannelSpeech(current.config, current.policy);
      if (operation === "capabilities") {
        return json({
          transcription: Boolean(transcription),
          speech: Boolean(speech),
          maxSessionSeconds: current.policy.voice?.maxSessionSeconds ?? 300,
          maxUtteranceSeconds: current.policy.voice?.maxUtteranceSeconds ?? 20,
        });
      }
      const recheck = async () => {
        const latest = await authorizeVoice(
          options,
          orgId,
          channel.data,
          actor
        );
        if (
          latest.principal.userId !== current.principal.userId ||
          JSON.stringify(latest.policy) !== JSON.stringify(current.policy) ||
          JSON.stringify(latest.config) !== JSON.stringify(current.config)
        ) {
          throw new AtlasApiError(
            "Voice authorization or provider configuration changed",
            403
          );
        }
      };
      if (operation === "speech") {
        if (!speech) {
          throw new AtlasApiError(
            "Configure an explicit speech provider, model and voice for this integration",
            409
          );
        }
        const input = speechSchema.parse(parsed.data);
        await recheck();
        const bytes = await synthesizeChannelSpeechBytes(
          speech,
          input.text,
          c.req.raw.signal
        );
        await recordUsage(speech.instance, speech.model, "audio.speech");
        await recheck();
        return json({
          data: bytes.toString("base64"),
          mediaType: "audio/wav",
          filename: "atlas-speech.wav",
        });
      }
      if (!transcription) {
        throw new AtlasApiError(
          "Configure a transcription provider for this workspace",
          409
        );
      }
      const input = transcriptionSchema.parse(parsed.data);
      const bytes = decodeAudioTranscriptionData(input.data);
      let duration: number;
      try {
        duration = assertChannelSpeechWav(bytes);
      } catch {
        throw new AtlasApiError("Voice input must be valid PCM WAV audio", 400);
      }
      if (duration > (current.policy.voice?.maxUtteranceSeconds ?? 20)) {
        throw new AtlasApiError(
          "Voice input exceeds this room's utterance duration limit",
          400
        );
      }
      await recheck();
      const text = await transcribeAudio(
        transcription.instance,
        transcription.model,
        {
          bytes,
          mediaType: input.mediaType,
          filename: input.filename ?? "channel-voice.wav",
        },
        {}
      );
      await recordUsage(
        transcription.instance,
        transcription.model,
        "audio.transcription"
      );
      await recheck();
      return json({ text });
    });
  }
}
