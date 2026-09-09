import { AtlasApiError, type UserConfig } from "@atlas/core";
import type { ChannelIntegrationPolicy } from "@atlas/core/channel-integration-policy";

const MAX_SPEECH_BYTES = 10 * 1024 * 1024;

export function resolveChannelSpeech(
  config: UserConfig | null,
  policy: ChannelIntegrationPolicy
) {
  const speech = policy.speech;
  if (!speech) {
    return null;
  }
  const instance = config?.providers.find(
    (provider) => provider.id === speech.providerId
  );
  if (
    !(
      instance &&
      ["openai", "openai_compatible"].includes(instance.type) &&
      instance.apiKey?.trim()
    )
  ) {
    return null;
  }
  const base =
    instance.baseUrl ??
    (instance.type === "openai" ? "https://api.openai.com/v1" : "");
  let endpoint: URL;
  try {
    endpoint = new URL(`${base.replace(/\/+$/, "")}/audio/speech`);
  } catch {
    return null;
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    return null;
  }
  return {
    apiKey: instance.apiKey,
    endpoint: endpoint.toString(),
    instance,
    model: speech.model,
    voice: speech.voice,
  };
}

/** Parse the actual PCM WAV container, including optional RIFF chunks. */
export function assertChannelSpeechWav(bytes: Buffer): number {
  if (
    bytes.length < 44 ||
    bytes.length > MAX_SPEECH_BYTES ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE" ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  ) {
    throw new AtlasApiError("Speech provider returned invalid WAV audio", 502);
  }
  let pcm = false;
  let data = false;
  let alignment = 0;
  let byteRate = 0;
  let duration = 0;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const kind = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > bytes.length) {
      throw new AtlasApiError("Speech provider returned truncated audio", 502);
    }
    if (kind === "fmt ") {
      if (size < 16 || pcm) {
        throw new AtlasApiError(
          "Speech provider returned invalid PCM metadata",
          502
        );
      }
      const channels = bytes.readUInt16LE(start + 2);
      const rate = bytes.readUInt32LE(start + 4);
      const bits = bytes.readUInt16LE(start + 14);
      alignment = (channels * bits) / 8;
      byteRate = rate * alignment;
      pcm =
        bytes.readUInt16LE(start) === 1 &&
        (channels === 1 || channels === 2) &&
        rate >= 8000 &&
        rate <= 96_000 &&
        bits === 16 &&
        bytes.readUInt16LE(start + 12) === alignment &&
        bytes.readUInt32LE(start + 8) === rate * alignment;
    }
    if (kind === "data") {
      if (data) {
        throw new AtlasApiError(
          "Speech provider returned duplicate PCM data",
          502
        );
      }
      data = size > 0 && alignment > 0 && size % alignment === 0;
      duration = size / byteRate;
    }
    offset = start + size + (size % 2);
  }
  if (!(pcm && data) || offset !== bytes.length) {
    throw new AtlasApiError(
      "Speech provider returned unsupported PCM audio",
      502
    );
  }
  return duration;
}

export async function synthesizeChannelSpeechBytes(
  selection: NonNullable<ReturnType<typeof resolveChannelSpeech>>,
  text: string,
  signal?: AbortSignal
): Promise<Buffer> {
  if (!text.trim() || text.length > 4096) {
    throw new AtlasApiError(
      "Speech text must contain 1 to 4096 characters",
      400
    );
  }
  const timeout = AbortSignal.timeout(45_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(selection.endpoint, {
    body: JSON.stringify({
      input: text,
      model: selection.model,
      response_format: "wav",
      voice: selection.voice,
    }),
    headers: {
      authorization: `Bearer ${selection.apiKey}`,
      "content-type": "application/json",
    },
    method: "POST",
    redirect: "error",
    signal: combined,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new AtlasApiError(
      `Speech provider rejected the request (HTTP ${response.status})`,
      502
    );
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new AtlasApiError("Speech provider returned no audio", 502);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      combined.throwIfAborted();
      const next = await reader.read();
      if (next.done) {
        break;
      }
      size += next.value.byteLength;
      if (size > MAX_SPEECH_BYTES) {
        throw new AtlasApiError(
          "Speech provider response exceeds the audio limit",
          502
        );
      }
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks);
  assertChannelSpeechWav(bytes);
  return bytes;
}
