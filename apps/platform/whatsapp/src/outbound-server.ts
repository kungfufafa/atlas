import {
  loadWhatsAppConfigFile,
  resolveWhatsAppOutboundDestination,
  resolveWhatsAppOutboundListenPort,
  saveWhatsAppOutboundPort,
} from "@atlas/core";
import { splitWhatsAppMessage } from "./format";

export interface WhatsAppOutboundSendHandle {
  sendMessage: (jid: string, content: { text: string }) => Promise<unknown>;
}

export interface WhatsAppOutboundServerOptions {
  getSendHandle: () => WhatsAppOutboundSendHandle | null;
  orgId?: string | null;
}

export async function startWhatsAppOutboundServer(
  options: WhatsAppOutboundServerOptions
): Promise<{ port: number; stop: () => void }> {
  const config = await loadWhatsAppConfigFile(options.orgId);
  const port = resolveWhatsAppOutboundListenPort(config);
  let stopped = false;

  const server = Bun.serve({
    async fetch(request) {
      if (stopped) {
        return new Response("Server stopped", { status: 503 });
      }

      const url = new URL(request.url);

      if (request.method === "POST" && url.pathname === "/send") {
        const latestConfig = await loadWhatsAppConfigFile(options.orgId);
        const pairedJid = latestConfig?.pairedJid?.trim();

        if (!(latestConfig && pairedJid)) {
          return Response.json(
            { error: "WhatsApp is not paired." },
            { status: 400 }
          );
        }

        let body: { text?: string; to?: string };

        try {
          body = (await request.json()) as { text?: string; to?: string };
        } catch {
          return Response.json(
            { error: "Invalid JSON body." },
            { status: 400 }
          );
        }

        const text = body.text?.trim();

        if (!text) {
          return Response.json({ error: "text is required." }, { status: 400 });
        }

        const destination = resolveWhatsAppOutboundDestination(
          latestConfig,
          body.to
        );
        if ("error" in destination) {
          return Response.json({ error: destination.error }, { status: 400 });
        }

        const handle = options.getSendHandle();

        if (!handle) {
          return Response.json(
            { error: "WhatsApp socket is not ready." },
            { status: 503 }
          );
        }

        try {
          for (const chunk of splitWhatsAppMessage(text)) {
            await handle.sendMessage(destination.jid, { text: chunk });
          }
          return Response.json({
            jid: destination.jid,
            ok: true,
            sender: pairedJid,
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return Response.json({ error: message }, { status: 500 });
        }
      }

      return new Response("Not found", { status: 404 });
    },
    hostname: "127.0.0.1",
    port,
  });

  if (server.port) {
    await saveWhatsAppOutboundPort(server.port, options.orgId);
  }

  return {
    port: server.port ?? port,
    stop: () => {
      stopped = true;
      server.stop(true);
    },
  };
}
