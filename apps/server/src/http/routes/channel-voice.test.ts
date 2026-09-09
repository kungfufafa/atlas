import { afterEach, expect, test } from "bun:test";
import { createWorkspaceWorkerAuthToken, type UserConfig } from "@atlas/core";
import {
  type ChannelIntegrationPolicy,
  saveChannelIntegrationPolicy,
} from "@atlas/core/channel-integration-policy";
import {
  assertChannelSpeechWav,
  resolveChannelSpeech,
} from "../../services/channel-speech-service";
import { setupTestConfigDir } from "../../test-config-dir";
import { createNativeChannelHarness } from "../../testing/channel-native-harness";

setupTestConfigDir("atlas-channel-voice-");
const open: Array<Awaited<ReturnType<typeof createNativeChannelHarness>>> = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.stop(true);
  }
  for (const h of open.splice(0)) {
    h.database.close();
  }
});
function wav() {
  const bytes = Buffer.alloc(48);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(40, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24_000, 24);
  bytes.writeUInt32LE(48_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(4, 40);
  bytes.writeInt16LE(320, 44);
  bytes.writeInt16LE(-320, 46);
  return bytes;
}
async function harness(
  fetchHandler: (request: Request) => Response | Promise<Response>
) {
  const h = await createNativeChannelHarness("discord");
  open.push(h);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: fetchHandler,
  });
  servers.push(server);
  const config: UserConfig = {
    defaultProviderId: null,
    providers: [
      {
        id: "tenant-speech",
        apiKey: "synthetic-tenant-key",
        baseUrl: `${server.url}v1`,
        createdAt: new Date().toISOString(),
        type: "openai_compatible",
        label: "Synthetic speech endpoint",
      },
    ],
  };
  await h.db.upsertOrgAiConfig({
    orgId: h.orgId,
    config,
    updatedAt: new Date().toISOString(),
  });
  const policy: ChannelIntegrationPolicy = {
    version: 1,
    voice: {
      enabled: true,
      allowedRoomIds: [h.actor.channelChatId],
      maxSessionSeconds: 60,
      maxUtteranceSeconds: 10,
    },
    speech: {
      providerId: "tenant-speech",
      model: "explicit-tenant-model",
      voice: "explicit-tenant-voice",
      transport: "openai-audio-speech",
    },
  };
  await saveChannelIntegrationPolicy(h.orgId, "discord", policy);
  await h.service.bind(h.orgId, "discord", h.actor);
  return { ...h, policy, config };
}

test("actual HTTP speech request uses only exact tenant credentials/model/voice and returns verified WAV bytes", async () => {
  const requests: Array<{ auth: string | null; path: string; body: unknown }> =
    [];
  const h = await harness(async (request) => {
    requests.push({
      auth: request.headers.get("authorization"),
      path: new URL(request.url).pathname,
      body: await request.json(),
    });
    return new Response(wav(), { headers: { "content-type": "audio/wav" } });
  });
  const caps = await h.request("/v1/channel-voice/capabilities", h.actor);
  expect(caps.status).toBe(200);
  expect(await caps.json()).toEqual({
    transcription: false,
    speech: true,
    maxSessionSeconds: 60,
    maxUtteranceSeconds: 10,
  });
  expect(requests).toHaveLength(0);
  const response = await h.request("/v1/channel-voice/speech", {
    ...h.actor,
    text: "Read this aloud",
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    data: wav().toString("base64"),
    mediaType: "audio/wav",
    filename: "atlas-speech.wav",
  });
  expect(requests).toEqual([
    {
      auth: "Bearer synthetic-tenant-key",
      path: "/v1/audio/speech",
      body: {
        input: "Read this aloud",
        model: "explicit-tenant-model",
        voice: "explicit-tenant-voice",
        response_format: "wav",
      },
    },
  ]);
});

for (const revoke of ["room", "role", "integration", "voice"] as const) {
  test(`voice ${revoke} denial stops provider HTTP before inference`, async () => {
    let calls = 0;
    const h = await harness(() => {
      calls += 1;
      return new Response(wav());
    });
    if (revoke === "role") {
      await h.db.upsertOrgMember({
        orgId: h.orgId,
        userId: h.userId,
        role: "viewer",
        createdAt: new Date().toISOString(),
      });
    } else {
      await saveChannelIntegrationPolicy(h.orgId, "discord", {
        ...h.policy,
        ...(revoke === "integration"
          ? { enabled: false }
          : {
              voice: {
                ...h.policy.voice!,
                enabled: revoke !== "voice",
                allowedRoomIds:
                  revoke === "room" ? [] : [h.actor.channelChatId],
              },
            }),
      });
    }
    for (const operation of ["capabilities", "speech", "transcribe"] as const) {
      const body = {
        ...h.actor,
        ...(operation === "speech"
          ? { text: "Denied" }
          : operation === "transcribe"
            ? { data: wav().toString("base64"), mediaType: "audio/wav" }
            : {}),
      };
      expect(
        (await h.request(`/v1/channel-voice/${operation}`, body)).status
      ).toBe(403);
    }
    expect(calls).toBe(0);
  });
}

test("voice policy revoked while provider is responding prevents audio delivery", async () => {
  let h: Awaited<ReturnType<typeof harness>>;
  h = await harness(async () => {
    await saveChannelIntegrationPolicy(h.orgId, "discord", {
      ...h.policy,
      voice: { enabled: false, allowedRoomIds: [] },
    });
    return new Response(wav());
  });
  const response = await h.request("/v1/channel-voice/speech", {
    ...h.actor,
    text: "Read",
  });
  expect(response.status).toBe(403);
  expect(await response.text()).not.toContain(wav().toString("base64"));
});

test("foreign worker and forged session cannot invoke speech; malformed provider bytes never become audio", async () => {
  let calls = 0;
  const h = await harness(() => {
    calls += 1;
    return new Response("not a WAV", {
      headers: { "content-type": "audio/wav" },
    });
  });
  const body = { ...h.actor, text: "Read" };
  const token = await createWorkspaceWorkerAuthToken({
    channel: "telegram",
    orgId: h.orgId,
  });
  expect(
    (await h.request("/v1/channel-voice/speech", body, { token })).status
  ).toBe(403);
  expect(
    (
      await h.request("/v1/channel-voice/speech", {
        ...body,
        sessionId: "foreign-session",
      })
    ).status
  ).toBe(404);
  expect(
    (
      await h.request("/v1/channel-voice/speech", body, {
        orgId: "foreign-org",
      })
    ).status
  ).toBe(403);
  expect(calls).toBe(0);
  expect((await h.request("/v1/channel-voice/speech", body)).status).toBe(502);
  expect(calls).toBe(1);
});

test("subscription/foreign/credentialless providers never inherit speech support or host credentials", () => {
  const policy: ChannelIntegrationPolicy = {
    version: 1,
    speech: {
      providerId: "speech",
      model: "explicit",
      voice: "explicit",
      transport: "openai-audio-speech",
    },
  };
  for (const type of ["claude", "chatgpt", "anthropic", "gemini"] as const) {
    expect(
      resolveChannelSpeech(
        {
          defaultProviderId: null,
          providers: [
            {
              id: "speech",
              type,
              apiKey: "synthetic",
              label: type,
              createdAt: "now",
            },
          ],
        },
        policy
      )
    ).toBeNull();
  }
  expect(resolveChannelSpeech(null, policy)).toBeNull();
  expect(
    resolveChannelSpeech(
      {
        defaultProviderId: null,
        providers: [
          {
            id: "speech",
            type: "openai",
            apiKey: "",
            label: "empty",
            createdAt: "now",
          },
        ],
      },
      policy
    )
  ).toBeNull();
  expect(() => assertChannelSpeechWav(wav())).not.toThrow();
  const invalid = wav();
  invalid.writeUInt32LE(999, 40);
  expect(() => assertChannelSpeechWav(invalid)).toThrow();
});

test("scoped voice transcription sends actual WAV multipart, enforces duration and records tenant usage", async () => {
  const uploads: Buffer[] = [];
  const h = await harness(async (request) => {
    expect(new URL(request.url).pathname).toBe("/v1/audio/transcriptions");
    const form = await request.formData();
    expect(form.get("model")).toBe("explicit-transcription-model");
    const file = form.get("file");
    expect(file).toBeInstanceOf(File);
    uploads.push(Buffer.from(await (file as File).arrayBuffer()));
    return Response.json({ text: "Actual multipart received" });
  });
  const config: UserConfig = {
    ...h.config,
    transcriptionModel: "tenant-speech::explicit-transcription-model",
    providers: [
      {
        ...h.config.providers[0]!,
        type: "openai",
        customModels: [
          {
            id: "explicit-transcription-model",
            capabilities: {
              "audio.transcription": {
                source: "admin-override",
                status: "supported",
                verified: false,
              },
            },
          },
        ],
      },
    ],
  };
  await h.db.upsertOrgAiConfig({
    orgId: h.orgId,
    config,
    updatedAt: new Date().toISOString(),
  });
  expect(
    await (await h.request("/v1/channel-voice/capabilities", h.actor)).json()
  ).toMatchObject({ transcription: true });
  const body = {
    ...h.actor,
    data: wav().toString("base64"),
    mediaType: "audio/wav",
    filename: "recording.wav",
  };
  const response = await h.request("/v1/channel-voice/transcribe", body);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ text: "Actual multipart received" });
  expect(uploads).toEqual([wav()]);
  const usage = await h.db.aggregateLlmUsage({
    groupBy: "user",
    orgId: h.orgId,
  });
  expect(usage).toEqual([
    expect.objectContaining({ key: h.userId, requestCount: 1 }),
  ]);
  const oversized = Buffer.alloc(44 + 48_000 * 11);
  wav().copy(oversized, 0, 0, 44);
  oversized.writeUInt32LE(oversized.length - 8, 4);
  oversized.writeUInt32LE(oversized.length - 44, 40);
  expect(
    (
      await h.request("/v1/channel-voice/transcribe", {
        ...body,
        data: oversized.toString("base64"),
      })
    ).status
  ).toBe(400);
  expect(
    (
      await h.request("/v1/channel-voice/transcribe", {
        ...body,
        data: Buffer.from("not PCM").toString("base64"),
      })
    ).status
  ).toBe(400);
  expect(uploads).toHaveLength(1);
});

test("an allowed room cannot be substituted for the server-bound voice session", async () => {
  let calls = 0;
  const h = await harness(() => {
    calls += 1;
    return new Response(wav());
  });
  await saveChannelIntegrationPolicy(h.orgId, "discord", {
    ...h.policy,
    voice: {
      enabled: true,
      allowedRoomIds: ["another-allowed-room", "another-allowed-topic"],
    },
  });
  for (const origin of [
    {},
    { channelChatId: "another-allowed-room" },
    { channelThreadId: "another-allowed-topic" },
    { channelChatId: "another-allowed-room", channelIsGroup: false },
  ]) {
    const response = await h.request("/v1/channel-voice/speech", {
      ...h.actor,
      ...origin,
      text: "Must not send to another room",
    });
    expect(response.status).toBe(403);
  }
  expect(calls).toBe(0);
});
