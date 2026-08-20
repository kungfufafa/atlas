import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATLAS_API_VERSION } from "./contract";
import { isServerHealthy } from "./ensure-server";
import { loadLocalAuthToken } from "./local-auth";

const REQUIRED_TOOLS = [
  "write_file",
  "delete_file",
  "edit_file",
  "read_file",
  "search_files",
  "web_search",
];

describe("isServerHealthy", () => {
  let configDir = "";
  const servers: Array<ReturnType<typeof Bun.serve>> = [];

  afterEach(async () => {
    for (const server of servers) {
      server.stop(true);
    }
    servers.length = 0;

    if (configDir) {
      await rm(configDir, { force: true, recursive: true });
      configDir = "";
    }

    delete process.env.ATLAS_CONFIG_DIR;
  });

  test("rejects when the tools catalog stays unauthorized", async () => {
    await withLocalAuthConfig();
    const server = serveAtlas({
      requireAuthForTools: true,
      tools: REQUIRED_TOOLS,
    });

    await expect(isServerHealthy(originOf(server))).resolves.toBe(false);
  });

  test("accepts a server that lists required builtins for the local client", async () => {
    const token = await withLocalAuthConfig();
    const server = serveAtlas({
      requireAuthForTools: true,
      token,
      tools: REQUIRED_TOOLS,
    });

    await expect(isServerHealthy(originOf(server))).resolves.toBe(true);
  });

  test("retries tools with a workspace header when local-token needs org context", async () => {
    const token = await withLocalAuthConfig();
    const server = serveAtlas({
      orgId: "org_workspace",
      requireAuthForTools: true,
      requireOrgForTools: true,
      token,
      tools: REQUIRED_TOOLS,
    });

    await expect(isServerHealthy(originOf(server))).resolves.toBe(true);
  });

  async function withLocalAuthConfig(): Promise<string> {
    configDir = await mkdtemp(join(tmpdir(), "atlas-ensure-server-"));
    process.env.ATLAS_CONFIG_DIR = configDir;
    const token = await loadLocalAuthToken();
    if (!token) {
      throw new Error("expected a local auth token");
    }
    return token;
  }

  function serveAtlas(options: {
    orgId?: string;
    requireAuthForTools: boolean;
    requireOrgForTools?: boolean;
    token?: string;
    tools: string[];
  }): ReturnType<typeof Bun.serve> {
    const server = Bun.serve({
      fetch(request) {
        const url = new URL(request.url);

        if (url.pathname === "/health") {
          return Response.json({
            apiVersion: ATLAS_API_VERSION,
            ok: true,
          });
        }

        if (url.pathname === "/v1/tasks/__capability_probe__/messages") {
          return Response.json({ error: "Task not found." }, { status: 404 });
        }

        if (url.pathname === "/v1/auth/orgs") {
          if (!hasBearer(request, options.token)) {
            return Response.json({}, { status: 401 });
          }
          return Response.json({
            orgs: [{ id: options.orgId ?? "org_workspace" }],
          });
        }

        if (url.pathname === "/v1/tools") {
          if (
            options.requireAuthForTools &&
            !hasBearer(request, options.token)
          ) {
            return Response.json({}, { status: 401 });
          }
          if (
            options.requireOrgForTools &&
            request.headers.get("X-Org-Id") !==
              (options.orgId ?? "org_workspace")
          ) {
            return Response.json({}, { status: 400 });
          }
          return Response.json({
            tools: options.tools.map((name) => ({ name })),
          });
        }

        return new Response(null, { status: 404 });
      },
      hostname: "127.0.0.1",
      port: 0,
    });
    servers.push(server);
    return server;
  }
});

function originOf(server: ReturnType<typeof Bun.serve>): string {
  return `http://${server.hostname}:${server.port}`;
}

function hasBearer(request: Request, token: string | undefined): boolean {
  if (!token) {
    return false;
  }
  return request.headers.get("Authorization") === `Bearer ${token}`;
}
