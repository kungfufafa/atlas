import { Readable } from "node:stream";
import type { AtlasClient } from "@atlas/client";
import {
  AudioPlayerStatus,
  AudioResource,
  createAudioPlayer,
  EndBehaviorType,
  entersState,
  joinVoiceChannel,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import type { Client, VoiceChannel } from "discord.js";
import { PermissionFlagsBits } from "discord.js";
import OpusScript from "opusscript";
import { requireDiscordPermissions } from "./native-actions";
import { prepareDiscordPlaybackPcm } from "./native-audio";
import type { DiscordCallbackBinding } from "./native-callbacks";

const RATE = 48_000;
const CHANNELS = 2;
const MAX_UTTERANCE_BYTES = RATE * CHANNELS * 2 * 20;

export function discordPcmToWav(pcm: Buffer): Buffer {
  if (!pcm.length || pcm.length % 4 !== 0 || pcm.length > MAX_UTTERANCE_BYTES) {
    throw new Error(
      "Discord voice recording is empty or exceeds twenty seconds"
    );
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * CHANNELS * 2, 28);
  header.writeUInt16LE(CHANNELS * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export async function decodeDiscordUtterance(
  stream: Readable,
  signal: AbortSignal,
  maxSeconds = 20
): Promise<Buffer> {
  const codec = new OpusScript(RATE, CHANNELS, OpusScript.Application.VOIP);
  const chunks: Buffer[] = [];
  let size = 0;
  const abort = () =>
    stream.destroy(new Error("Discord voice recording stopped"));
  const limitSeconds = Math.max(1, Math.min(20, maxSeconds));
  const timer = setTimeout(abort, limitSeconds * 1000);
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    for await (const packet of stream) {
      signal.throwIfAborted();
      if (!Buffer.isBuffer(packet)) {
        throw new Error("Discord voice packet is invalid");
      }
      const pcm = codec.decode(packet);
      size += pcm.length;
      if (size > RATE * CHANNELS * 2 * limitSeconds) {
        throw new Error("Discord voice utterance exceeds twenty seconds");
      }
      chunks.push(Buffer.from(pcm));
    }
    return discordPcmToWav(Buffer.concat(chunks));
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    stream.destroy();
    codec.delete();
  }
}

export interface DiscordVoiceConnection {
  onClose(callback: () => void): void;
  onSpeaker(callback: (userId: string) => void): void;
  play(bytes: Buffer, signal: AbortSignal): Promise<void>;
  receive(userId: string): Readable;
  stop(): void;
}

export function createDiscordPlaybackResource(
  pcm: Buffer,
  signal: AbortSignal
): AudioResource<null> {
  if (
    !pcm.length ||
    pcm.length % 4 !== 0 ||
    pcm.length > RATE * CHANNELS * 2 * 90
  ) {
    throw new Error(
      "Discord playback PCM is invalid or exceeds ninety seconds"
    );
  }
  signal.throwIfAborted();
  function* packets() {
    const codec = new OpusScript(RATE, CHANNELS, OpusScript.Application.AUDIO);
    const frameBytes = 960 * CHANNELS * 2;
    try {
      for (let offset = 0; offset < pcm.length; offset += frameBytes) {
        signal.throwIfAborted();
        const frame = Buffer.alloc(frameBytes);
        pcm.copy(frame, 0, offset, Math.min(offset + frameBytes, pcm.length));
        yield Buffer.from(codec.encode(frame, 960));
      }
    } finally {
      codec.delete();
    }
  }
  // createAudioResource initializes an FFmpeg discovery subprocess even for Raw
  // input. The public resource constructor accepts our encoded packet stream.
  return new AudioResource([], [Readable.from(packets())], null, 5);
}

export async function connectDiscordVoice(
  channel: VoiceChannel,
  signal?: AbortSignal
): Promise<DiscordVoiceConnection> {
  const connection = joinVoiceChannel({
    adapterCreator: channel.guild.voiceAdapterCreator,
    channelId: channel.id,
    guildId: channel.guild.id,
    selfDeaf: false,
    selfMute: false,
  });
  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Stop },
  });
  let onClose: (() => void) | undefined;
  connection.on("error", () => {
    player.stop(true);
    if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
      connection.destroy();
    }
    onClose?.();
  });
  connection.on(VoiceConnectionStatus.Disconnected, () => onClose?.());
  try {
    await entersState(
      connection,
      VoiceConnectionStatus.Ready,
      AbortSignal.any([
        signal ?? new AbortController().signal,
        AbortSignal.timeout(15_000),
      ])
    );
    connection.subscribe(player);
  } catch (error) {
    player.stop(true);
    connection.destroy();
    throw error;
  }
  return {
    onClose: (callback) => {
      onClose = callback;
      if (
        connection.state.status === VoiceConnectionStatus.Destroyed ||
        connection.state.status === VoiceConnectionStatus.Disconnected
      ) {
        callback();
      }
    },
    onSpeaker: (callback) => connection.receiver.speaking.on("start", callback),
    async play(bytes, signal) {
      signal.throwIfAborted();
      const stop = () => player.stop(true);
      signal.addEventListener("abort", stop, { once: true });
      try {
        const pcm = await prepareDiscordPlaybackPcm(bytes, signal);
        signal.throwIfAborted();
        player.play(createDiscordPlaybackResource(pcm, signal));
        await entersState(player, AudioPlayerStatus.Playing, 10_000);
        await entersState(player, AudioPlayerStatus.Idle, 90_000);
        signal.throwIfAborted();
      } finally {
        signal.removeEventListener("abort", stop);
        player.stop(true);
      }
    },
    receive: (userId) =>
      connection.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 800 },
      }),
    stop() {
      connection.receiver.speaking.removeAllListeners("start");
      for (const stream of connection.receiver.subscriptions.values()) {
        stream.destroy();
      }
      player.stop(true);
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
        connection.destroy();
      }
    },
  };
}

interface ActiveVoiceSession {
  binding: DiscordCallbackBinding;
  busy: boolean;
  channel: VoiceChannel;
  connection: DiscordVoiceConnection;
  controller: AbortController;
  expires: ReturnType<typeof setTimeout>;
  startedAt: number;
  timer: ReturnType<typeof setInterval>;
}

export class DiscordVoiceSessions {
  private readonly active = new Map<string, ActiveVoiceSession>();
  private readonly joining = new Map<
    string,
    { binding: DiscordCallbackBinding; controller: AbortController }
  >();
  private closed = false;

  constructor(
    private readonly options: {
      authorize(binding: DiscordCallbackBinding): Promise<void>;
      client: AtlasClient;
      connect?: typeof connectDiscordVoice;
      discord: Client<true>;
      runTurn(
        binding: DiscordCallbackBinding,
        text: string,
        signal: AbortSignal
      ): Promise<string>;
      status(binding: DiscordCallbackBinding, text: string): Promise<void>;
    }
  ) {}

  private identity(binding: DiscordCallbackBinding) {
    return {
      channel: "discord" as const,
      channelAddressed: true,
      channelChatId: binding.channelChatId,
      channelIsGroup: true,
      channelUserId: binding.channelUserId,
      sessionId: binding.sessionId,
    };
  }

  assertCanJoin(guildId: string): void {
    if (this.closed || this.active.has(guildId) || this.joining.has(guildId)) {
      throw new Error(
        "Discord voice runtime is closed or this server already has a voice session"
      );
    }
  }

  private scoped<T>(
    binding: DiscordCallbackBinding,
    operation: () => Promise<T>
  ): Promise<T> {
    return this.options.client.isolateOrgId(() => {
      this.options.client.setOrgId(binding.orgId);
      return operation();
    });
  }

  async join(
    binding: DiscordCallbackBinding,
    channel: VoiceChannel
  ): Promise<void> {
    this.assertCanJoin(channel.guild.id);
    if (this.closed) {
      throw new Error("Discord voice runtime is closed");
    }
    if (
      binding.guildId !== channel.guild.id ||
      binding.channelId !== channel.id ||
      binding.channelThreadId
    ) {
      throw new Error(
        "Discord voice connection does not match the authorized room"
      );
    }
    if (
      this.active.has(channel.guild.id) ||
      this.joining.has(channel.guild.id)
    ) {
      throw new Error("This bot already has a voice session in this server");
    }
    const controller = new AbortController();
    this.joining.set(channel.guild.id, { binding, controller });
    try {
      const capabilities = await this.authorizeSpeaker(binding, channel);
      controller.signal.throwIfAborted();
      const connection = await (this.options.connect ?? connectDiscordVoice)(
        channel,
        controller.signal
      );
      try {
        controller.signal.throwIfAborted();
        await this.authorizeSpeaker(binding, channel);
      } catch (error) {
        connection.stop();
        throw error;
      }
      const session: ActiveVoiceSession = {
        binding,
        busy: false,
        channel,
        connection,
        controller,
        expires: setTimeout(
          () =>
            this.leave(channel.guild.id, binding.channelUserId, binding.orgId),
          capabilities.maxSessionSeconds * 1000
        ),
        startedAt: Date.now(),
        timer: setInterval(() => {
          this.authorizeSpeaker(binding, channel).catch(() =>
            this.leave(binding.guildId!, binding.channelUserId, binding.orgId)
          );
        }, 10_000),
      };
      this.active.set(channel.guild.id, session);
      connection.onClose(() =>
        this.leave(channel.guild.id, binding.channelUserId, binding.orgId)
      );
      controller.signal.throwIfAborted();
      connection.onSpeaker((userId) => {
        if (
          userId !== binding.channelUserId ||
          session.busy ||
          session.controller.signal.aborted
        ) {
          return;
        }
        session.busy = true;
        this.utterance(session)
          .catch(async () => {
            if (session.controller.signal.aborted) {
              return;
            }
            try {
              await this.authorizeSpeaker(binding, channel);
              await this.options.status(
                binding,
                "Voice turn could not complete. Check access and audio settings."
              );
            } catch {
              this.leave(
                channel.guild.id,
                binding.channelUserId,
                binding.orgId
              );
            }
          })
          .finally(() => {
            session.busy = false;
          })
          .catch(() => {});
      });
    } finally {
      this.joining.delete(channel.guild.id);
    }
  }

  leave(guildId: string, channelUserId: string, orgId: string): boolean {
    const session = this.active.get(guildId);
    const joining = this.joining.get(guildId);
    if (
      joining?.binding.channelUserId === channelUserId &&
      joining.binding.orgId === orgId &&
      !session
    ) {
      joining.controller.abort();
      this.joining.delete(guildId);
      return true;
    }
    if (
      !session ||
      session.binding.channelUserId !== channelUserId ||
      session.binding.orgId !== orgId
    ) {
      return false;
    }
    this.active.delete(guildId);
    clearInterval(session.timer);
    clearTimeout(session.expires);
    session.controller.abort();
    session.connection.stop();
    return true;
  }

  close(): void {
    this.closed = true;
    for (const { controller } of this.joining.values()) {
      controller.abort();
    }
    this.joining.clear();
    for (const [guildId, session] of this.active) {
      this.leave(guildId, session.binding.channelUserId, session.binding.orgId);
    }
  }

  async recheck(guildId: string): Promise<void> {
    const session = this.active.get(guildId);
    if (!session) {
      return;
    }
    try {
      await this.authorizeSpeaker(session.binding, session.channel);
    } catch {
      this.leave(guildId, session.binding.channelUserId, session.binding.orgId);
    }
  }

  private async authorizeSpeaker(
    binding: DiscordCallbackBinding,
    channel: VoiceChannel
  ): Promise<{ maxSessionSeconds: number; maxUtteranceSeconds: number }> {
    await this.options.authorize(binding);
    const capabilities = await this.scoped(binding, () =>
      this.options.client.getChannelVoiceCapabilities(this.identity(binding))
    );
    if (
      !(
        capabilities.transcription &&
        capabilities.speech &&
        Number.isFinite(capabilities.maxSessionSeconds)
      ) ||
      capabilities.maxSessionSeconds <= 0 ||
      !Number.isFinite(capabilities.maxUtteranceSeconds) ||
      capabilities.maxUtteranceSeconds <= 0
    ) {
      throw new Error(
        "Discord voice requires current transcription, speech, and configured duration limits"
      );
    }
    const active = this.active.get(channel.guild.id);
    if (
      active &&
      Date.now() - active.startedAt >= capabilities.maxSessionSeconds * 1000
    ) {
      throw new Error("Discord voice session duration limit reached");
    }
    const current = await this.options.discord.channels.fetch(channel.id, {
      force: true,
    });
    if (!current || current.type !== channel.type) {
      throw new Error("Discord voice room is unavailable");
    }
    await requireDiscordPermissions(current, binding.channelUserId, [
      PermissionFlagsBits.Connect,
      PermissionFlagsBits.Speak,
    ]);
    const state = await channel.guild.voiceStates.fetch(binding.channelUserId, {
      force: true,
    });
    if (state.channelId !== channel.id) {
      throw new Error("Discord speaker left the authorized voice room");
    }
    return capabilities;
  }

  private async utterance(session: ActiveVoiceSession): Promise<void> {
    const { binding, controller, channel } = session;
    const signal = controller.signal;
    const capabilities = await this.authorizeSpeaker(binding, channel);
    signal.throwIfAborted();
    const audio = await decodeDiscordUtterance(
      session.connection.receive(binding.channelUserId),
      signal,
      capabilities.maxUtteranceSeconds
    );
    await this.authorizeSpeaker(binding, channel);
    signal.throwIfAborted();
    const transcription = await this.scoped(binding, () =>
      this.options.client.transcribeChannelVoice({
        ...this.identity(binding),
        data: audio.toString("base64"),
        filename: "discord-voice.wav",
        mediaType: "audio/wav",
      })
    );
    signal.throwIfAborted();
    if (!transcription.text.trim()) {
      return;
    }
    await this.authorizeSpeaker(binding, channel);
    const reply = await this.options.runTurn(
      binding,
      transcription.text,
      signal
    );
    signal.throwIfAborted();
    if (!reply.trim()) {
      return;
    }
    await this.authorizeSpeaker(binding, channel);
    const speech = await this.scoped(binding, () =>
      this.options.client.synthesizeChannelSpeech({
        ...this.identity(binding),
        text: reply,
      })
    );
    signal.throwIfAborted();
    const bytes = Buffer.from(speech.data, "base64");
    if (
      speech.mediaType !== "audio/wav" ||
      bytes.length > 10 * 1024 * 1024 ||
      bytes.toString("ascii", 0, 4) !== "RIFF" ||
      bytes.toString("ascii", 8, 12) !== "WAVE"
    ) {
      throw new Error("Discord speech response is not a supported WAV payload");
    }
    await this.authorizeSpeaker(binding, channel);
    signal.throwIfAborted();
    await session.connection.play(bytes, signal);
  }
}
