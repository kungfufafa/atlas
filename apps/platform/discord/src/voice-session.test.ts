import { afterEach, expect, spyOn, test } from "bun:test";
import childProcess from "node:child_process";
import { Readable } from "node:stream";
import type { AtlasClient } from "@atlas/client";
import {
  ChannelType,
  type Client,
  PermissionsBitField,
  type VoiceChannel,
} from "discord.js";
import OpusScript from "opusscript";
import type { DiscordCallbackBinding } from "./native-callbacks";
import {
  createDiscordPlaybackResource,
  type DiscordVoiceConnection,
  DiscordVoiceSessions,
  decodeDiscordUtterance,
  discordPcmToWav,
} from "./voice-session";

const sessions: DiscordVoiceSessions[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) {
    session.close();
  }
});

function packet(): Buffer {
  const codec = new OpusScript(48_000, 2, OpusScript.Application.VOIP);
  try {
    return codec.encode(Buffer.alloc(3840), 960);
  } finally {
    codec.delete();
  }
}

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error("Voice fixture did not reach expected state");
}

function fixture() {
  const calls: string[] = [];
  const requests: Record<string, unknown>[] = [];
  const binding: DiscordCallbackBinding = {
    channelAddressed: true,
    channelChatId: "voice",
    channelId: "voice",
    channelOrgKey: "org-voice",
    channelUserId: "speaker",
    conversationKey: "conversation",
    guildId: "guild",
    orgId: "org",
    profileId: "profile",
    sessionId: "session",
  };
  let voiceChannelId = "voice";
  let access = true;
  let speech = true;
  let transcription = true;
  let maxSessionSeconds = 60;
  let maxUtteranceSeconds = 20;
  let revokeAfterTranscribe = false;
  let revokeAfterSpeech = false;
  let packetCount = 1;
  let speaker: (userId: string) => void = () => {};
  let closed: () => void = () => {};
  const encoded = packet();
  const connection: DiscordVoiceConnection = {
    onClose: (callback) => {
      closed = callback;
    },
    onSpeaker: (callback) => {
      speaker = callback;
    },
    play: async (bytes) => {
      calls.push("play");
      expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
    },
    receive: (userId) => {
      calls.push("receive");
      expect(userId).toBe("speaker");
      return Readable.from(
        Array.from({ length: packetCount }, () => Buffer.from(encoded))
      );
    },
    stop: () => {
      calls.push("stop");
    },
  };
  const channel = {
    guild: {
      id: "guild",
      members: {
        fetch: async () => ({ id: "speaker" }),
        fetchMe: async () => ({ id: "bot" }),
      },
      roles: { fetch: async () => {} },
      voiceStates: { fetch: async () => ({ channelId: voiceChannelId }) },
    },
    guildId: "guild",
    id: "voice",
    isDMBased: () => false,
    permissionsFor: () => new PermissionsBitField(PermissionsBitField.All),
    type: ChannelType.GuildVoice,
  } as unknown as VoiceChannel;
  const client = {
    getChannelVoiceCapabilities: async (input: Record<string, unknown>) => {
      calls.push("capabilities");
      requests.push(input);
      return { maxSessionSeconds, maxUtteranceSeconds, speech, transcription };
    },
    isolateOrgId: async (operation: () => Promise<unknown>) =>
      await operation(),
    setOrgId: (orgId: string) => {
      expect(orgId).toBe("org");
    },
    synthesizeChannelSpeech: async (input: Record<string, unknown>) => {
      calls.push("speech");
      requests.push(input);
      if (revokeAfterSpeech) {
        access = false;
      }
      return {
        data: discordPcmToWav(Buffer.alloc(3840)).toString("base64"),
        filename: "reply.wav",
        mediaType: "audio/wav",
      };
    },
    transcribeChannelVoice: async (input: Record<string, unknown>) => {
      calls.push("transcribe");
      requests.push(input);
      const bytes = Buffer.from(input.data as string, "base64");
      expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
      if (revokeAfterTranscribe) {
        access = false;
      }
      return { text: "What is next?" };
    },
  } as unknown as AtlasClient;
  const options = {
    authorize: async () => {
      calls.push("authorize");
      if (!access) {
        throw new Error("revoked");
      }
    },
    client,
    connect: async () => {
      calls.push("connect");
      return connection;
    },
    discord: {
      channels: { fetch: async () => channel },
    } as unknown as Client<true>,
    runTurn: async (
      _binding: DiscordCallbackBinding,
      text: string,
      signal: AbortSignal
    ) => {
      calls.push("agent");
      expect(text).toBe("What is next?");
      signal.throwIfAborted();
      return "Proceed with the next step.";
    },
    status: async () => {
      calls.push("status");
    },
  };
  const runtime = new DiscordVoiceSessions(options);
  sessions.push(runtime);
  return {
    binding,
    calls,
    channel,
    connection,
    disableSpeech: () => {
      speech = false;
    },
    disableTranscription: () => {
      transcription = false;
    },
    disconnect: () => closed(),
    emit: (id = "speaker") => speaker(id),
    leaveRoom: () => {
      voiceChannelId = "other";
    },
    limitSession: (seconds: number) => {
      maxSessionSeconds = seconds;
    },
    limitUtterance: (seconds: number, packets: number) => {
      maxUtteranceSeconds = seconds;
      packetCount = packets;
    },
    options,
    requests,
    revoke: () => {
      access = false;
    },
    revokeAfterSpeech: () => {
      revokeAfterSpeech = true;
    },
    revokeAfterTranscribe: () => {
      revokeAfterTranscribe = true;
    },
    runtime,
  };
}

test("actual Opus codec yields a bounded PCM WAV with correct audio metadata", async () => {
  const wav = await decodeDiscordUtterance(
    Readable.from([packet(), packet()]),
    new AbortController().signal
  );
  expect(wav.readUInt16LE(22)).toBe(2);
  expect(wav.readUInt32LE(24)).toBe(48_000);
  expect(wav.readUInt32LE(40)).toBe(7680);
  expect(wav.length).toBe(7724);
});

test("only the authorized speaker reaches scoped transcription, agent, speech, and playback", async () => {
  const state = fixture();
  await state.runtime.join(state.binding, state.channel);
  state.emit("foreign-speaker");
  expect(state.calls).not.toContain("receive");
  state.emit();
  state.emit();
  await until(() => state.calls.includes("play"));
  expect(state.calls.filter((call) => call === "receive")).toHaveLength(1);
  for (const request of state.requests) {
    expect(request).toMatchObject({
      channel: "discord",
      channelAddressed: true,
      channelChatId: "voice",
      channelIsGroup: true,
      channelUserId: "speaker",
      sessionId: "session",
    });
  }
  expect(state.calls.indexOf("transcribe")).toBeLessThan(
    state.calls.indexOf("agent")
  );
  expect(state.calls.indexOf("agent")).toBeLessThan(
    state.calls.indexOf("speech")
  );
  expect(state.calls.indexOf("speech")).toBeLessThan(
    state.calls.indexOf("play")
  );
});

test.each(["speech", "transcription", "access", "voice-room"])(
  "missing current %s gate prevents joining",
  async (gate) => {
    const state = fixture();
    if (gate === "speech") {
      state.disableSpeech();
    }
    if (gate === "transcription") {
      state.disableTranscription();
    }
    if (gate === "access") {
      state.revoke();
    }
    if (gate === "voice-room") {
      state.leaveRoom();
    }
    await expect(
      state.runtime.join(state.binding, state.channel)
    ).rejects.toThrow();
    expect(state.calls).not.toContain("connect");
    expect(state.calls).not.toContain("receive");
  }
);

test("another tenant or sender cannot replace or stop the active guild session", async () => {
  const state = fixture();
  await state.runtime.join(state.binding, state.channel);
  await expect(
    state.runtime.join(
      { ...state.binding, channelUserId: "other", orgId: "foreign" },
      state.channel
    )
  ).rejects.toThrow();
  expect(state.runtime.leave("guild", "other", "org")).toBe(false);
  expect(state.runtime.leave("guild", "speaker", "foreign")).toBe(false);
  expect(state.calls).not.toContain("stop");
  expect(state.runtime.leave("guild", "speaker", "org")).toBe(true);
  expect(state.calls.filter((call) => call === "stop")).toHaveLength(1);
});

test.each(["before-capture", "after-transcribe", "after-speech"])(
  "revocation %s stops the next protected voice phase",
  async (stage) => {
    const state = fixture();
    await state.runtime.join(state.binding, state.channel);
    if (stage === "before-capture") {
      state.revoke();
    }
    if (stage === "after-transcribe") {
      state.revokeAfterTranscribe();
    }
    if (stage === "after-speech") {
      state.revokeAfterSpeech();
    }
    state.emit();
    await until(() => state.calls.includes("stop"));
    expect(state.calls).not.toContain("play");
    if (stage === "before-capture") {
      expect(state.calls).not.toContain("receive");
    }
    if (stage === "after-transcribe") {
      expect(state.calls).not.toContain("agent");
    }
  }
);

test("voice policy revocation and room exit immediately disconnect on recheck", async () => {
  const state = fixture();
  await state.runtime.join(state.binding, state.channel);
  state.disableSpeech();
  await state.runtime.recheck("guild");
  expect(state.calls).toContain("stop");
  const moved = fixture();
  await moved.runtime.join(moved.binding, moved.channel);
  moved.leaveRoom();
  await moved.runtime.recheck("guild");
  expect(moved.calls).toContain("stop");
});

test("configured utterance and session limits are enforced", async () => {
  const state = fixture();
  state.limitUtterance(1, 51);
  await state.runtime.join(state.binding, state.channel);
  state.emit();
  await until(() => state.calls.includes("status"));
  expect(state.calls).not.toContain("transcribe");
  const expires = fixture();
  expires.limitSession(1);
  await expires.runtime.join(expires.binding, expires.channel);
  await until(() => expires.calls.includes("stop"));
});

test("disconnect aborts an in-flight agent turn before speech", async () => {
  const state = fixture();
  state.options.runTurn = async (_binding, _text, signal) => {
    state.calls.push("agent");
    return await new Promise<string>((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(new Error("cancelled")), {
        once: true,
      })
    );
  };
  await state.runtime.join(state.binding, state.channel);
  state.emit();
  await until(() => state.calls.includes("agent"));
  state.disconnect();
  await Bun.sleep(1);
  expect(state.calls).toContain("stop");
  expect(state.calls).not.toContain("speech");
});

test("cancelled pending join stops its eventual connection and cannot accept speech", async () => {
  const state = fixture();
  let connected!: (connection: DiscordVoiceConnection) => void;
  state.options.connect = () =>
    new Promise((resolve) => {
      connected = resolve;
    });
  const pending = state.runtime.join(state.binding, state.channel);
  await until(() => Boolean(connected));
  expect(state.runtime.leave("guild", "speaker", "other-org")).toBe(false);
  expect(state.runtime.leave("guild", "speaker", "org")).toBe(true);
  connected(state.connection);
  await expect(pending).rejects.toThrow();
  state.emit();
  expect(state.calls.filter((call) => call === "stop")).toHaveLength(1);
  expect(state.calls).not.toContain("receive");
  expect(() => state.runtime.assertCanJoin("guild")).not.toThrow();
});

test("a connection already closed during callback installation cannot report a successful join", async () => {
  const state = fixture();
  state.connection.onClose = (callback) => callback();
  await expect(
    state.runtime.join(state.binding, state.channel)
  ).rejects.toThrow();
  expect(state.calls.filter((call) => call === "stop")).toHaveLength(1);
  expect(() => state.runtime.assertCanJoin("guild")).not.toThrow();
});

test("playback resource encodes exact 48 kHz stereo frames in process without an implicit FFmpeg probe or child", async () => {
  const spawn = spyOn(childProcess, "spawn");
  const spawnSync = spyOn(childProcess, "spawnSync");
  const decoder = new OpusScript(48_000, 2, OpusScript.Application.AUDIO);
  const controller = new AbortController();
  try {
    const resource = createDiscordPlaybackResource(
      Buffer.alloc(38_400),
      controller.signal
    );
    let decodedBytes = 0;
    let frames = 0;
    for await (const encoded of resource.playStream) {
      decodedBytes += decoder.decode(encoded).length;
      frames += 1;
    }
    expect(resource.edges).toEqual([]);
    expect(frames).toBe(10);
    expect(decodedBytes).toBe(38_400);
    expect(spawn).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
    controller.abort();
    expect(() =>
      createDiscordPlaybackResource(Buffer.alloc(3840), controller.signal)
    ).toThrow();
  } finally {
    decoder.delete();
    spawn.mockRestore();
    spawnSync.mockRestore();
  }
});
