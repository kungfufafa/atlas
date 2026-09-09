import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cassetteFilePath,
  loadCassette,
  normalizeCassetteExchanges,
  withMswCassette,
} from "./llm-msw-cassette";

test("records and replays the real upstream 401 status and body without replacing it with a handler error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-cassette-status-"));
  const body = { error: { code: "invalid_api_key", type: "authentication" } };
  let requests = 0;
  const upstream = Bun.serve({
    fetch: () => {
      requests += 1;
      return Response.json(body, { status: 401 });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const url = `${upstream.url}chat/completions`;
  const name = "upstream-authentication-failure";
  const request = async () => {
    const response = await fetch(url, {
      body: JSON.stringify({ messages: [], model: "synthetic" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    return { body: await response.json(), status: response.status };
  };
  try {
    const recorded = await withMswCassette(name, request, {
      cassettesDir: directory,
      mode: "record",
      url,
    });
    expect(recorded).toEqual({ body, status: 401 });
    expect(requests).toBe(1);
    const cassette = await loadCassette(cassetteFilePath(name, directory));
    expect(cassette).not.toBeNull();
    const exchanges = normalizeCassetteExchanges(cassette!);
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]?.response.status).toBe(401);
    expect(exchanges[0]?.response.body).toEqual(body);

    await upstream.stop(true);
    const replayed = await withMswCassette(name, request, {
      cassettesDir: directory,
      mode: "replay",
      url,
    });
    expect(replayed).toEqual(recorded);
    expect(requests).toBe(1);
  } finally {
    await upstream.stop(true);
    await rm(directory, { force: true, recursive: true });
  }
});

test("a missing replay cassette fails before any operation is invoked", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-cassette-missing-"));
  let invoked = false;
  try {
    await expect(
      withMswCassette(
        "missing",
        async () => {
          invoked = true;
        },
        { cassettesDir: directory, mode: "replay" }
      )
    ).rejects.toThrow();
    expect(invoked).toBe(false);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
