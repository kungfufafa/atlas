import {
  AtlasApiError,
  decodeBase64AttachmentData,
  PROVIDER_CAPABILITY_IDS,
  type ProviderInstance,
  type UserConfig,
} from "@atlas/core";
import { builtinProviderAdapterRegistry } from "../providers/capabilities/builtin-adapters";
import {
  type AudioTranscriptionInput,
  normalizeAudioTranscriptionInput,
  normalizeAudioTranscriptionOutput,
} from "../providers/capabilities/executors/audio-transcription";
import type { ProviderAdapterRegistry } from "../providers/capabilities/registry";
import { resolveConfiguredCapability } from "../providers/capabilities/runtime";
import { readApiKeyForInstance } from "../providers/create";
import {
  decodeStoredModelSelection,
  type ResolvedProfileProviderSelection,
} from "./provider-instance-helpers";

const AUDIO_TRANSCRIPTION = PROVIDER_CAPABILITY_IDS.audioTranscription;
export const MAX_AUDIO_TRANSCRIPTION_BYTES = 25 * 1024 * 1024;

export const TRANSCRIPTION_MODEL_REQUIRED_MESSAGE =
  "Configure an audio transcription model in Settings before sending voice messages.";

export function decodeAudioTranscriptionData(data: string): Buffer {
  return Buffer.from(
    decodeBase64AttachmentData(data, "Audio", MAX_AUDIO_TRANSCRIPTION_BYTES)
  );
}

export function resolveTranscriptionProviderSelection(
  userConfig: UserConfig | null | undefined,
  env: Record<string, string | undefined> = process.env,
  registry: ProviderAdapterRegistry = builtinProviderAdapterRegistry
): ResolvedProfileProviderSelection | null {
  const legacySelection = userConfig?.transcriptionModel?.trim();
  const configuredBinding =
    userConfig?.capabilityConfig?.bindings[AUDIO_TRANSCRIPTION];

  if (!(legacySelection || configuredBinding)) {
    return null;
  }

  if (!userConfig?.capabilityConfig && legacySelection) {
    const decoded = decodeStoredModelSelection(legacySelection);
    if (!decoded || decoded.providerId === "__unknown__") {
      throw new AtlasApiError(
        "Configured audio transcription model is invalid. Update it in Settings.",
        400
      );
    }
  }

  const selection = resolveConfiguredCapability({
    capabilityId: AUDIO_TRANSCRIPTION,
    config: userConfig,
    readApiKey: (instance) => readApiKeyForInstance(instance, env),
    registry,
  });

  return {
    instance: selection.instance,
    model: selection.model,
  };
}

export async function transcribeAudio(
  instance: ProviderInstance,
  model: string,
  input: AudioTranscriptionInput,
  env: Record<string, string | undefined> = process.env,
  registry: ProviderAdapterRegistry = builtinProviderAdapterRegistry
): Promise<string> {
  const audio = normalizeAudioTranscriptionInput(input);
  const apiKey = readApiKeyForInstance(instance, env)?.trim() ?? "";
  const output = await registry.execute(
    AUDIO_TRANSCRIPTION,
    { apiKey, instance, model },
    audio
  );

  return normalizeAudioTranscriptionOutput(output).text;
}
