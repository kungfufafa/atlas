import {
  loadWhatsAppConfigFile,
  normalizePhoneNumberDigits,
} from "@atlas/core/whatsapp-config";
import { downloadWhatsAppMedia } from "../../apps/platform/whatsapp/src/attachments";
import { sendWhatsAppArtifact } from "../../apps/platform/whatsapp/src/send-artifact-media";
import {
  authorizeLivePrincipal,
  type LiveManifest,
  type LiveTransport,
  loadScopedPrerequisites,
  MAX_FILE_BYTES,
  parseManifest,
  type Receipt,
  type RunState,
  requireProof,
  requireSendAuthorization,
  type SentFile,
} from "./live-messengers";

type Socket = NonNullable<Parameters<typeof sendWhatsAppArtifact>[0]>;
type Message = Parameters<typeof downloadWhatsAppMedia>[0];

interface DedicatedOptions {
  /** Controlled-test override; live use must keep the canonical default. */
  authorizeCurrent?: () => Promise<void>;
  authorizedManifestSha256: string;
  dedicatedRuntime: true;
  download?: typeof downloadWhatsAppMedia;
  operationalWorkerAlive: false;
  socket: Socket;
}

/**
 * Attaches to an already connected, explicitly dedicated test socket supplied by
 * its owner. Never loads/copies auth, connects/reconnects, sends text, changes ACL,
 * or starts the operational worker. CLI deliberately cannot manufacture one.
 */
export class DedicatedWhatsAppProofTransport implements LiveTransport {
  private sentMessage: Message | null = null;
  private sendAttempted = false;
  private returnedMessage: Message | null = null;
  private expectedFilename: string | null = null;

  constructor(
    private readonly manifest: LiveManifest,
    private readonly options: DedicatedOptions
  ) {
    requireProof(
      manifest.channel === "whatsapp" &&
        manifest.destination === manifest.receiverUserId,
      "WHATSAPP_DIRECT_DESTINATION_REQUIRED"
    );
    requireProof(
      options.dedicatedRuntime === true &&
        options.operationalWorkerAlive === false,
      "DEDICATED_IDLE_WHATSAPP_RUNTIME_REQUIRED"
    );
  }

  async probe(): Promise<void> {
    parseManifest(this.manifest);
    requireProof(
      this.options.socket.user?.id,
      "DEDICATED_WHATSAPP_NOT_CONNECTED"
    );
    await this.authorizeCurrent();
  }

  private async authorizeCurrent(): Promise<void> {
    if (this.options.authorizeCurrent) {
      return this.options.authorizeCurrent();
    }
    const config = await loadWhatsAppConfigFile(this.manifest.orgId);
    const scope = await loadScopedPrerequisites(this.manifest);
    const phone = this.options.socket.user?.id?.split("@")[0]?.split(":")[0];
    requireProof(
      config &&
        phone === normalizePhoneNumberDigits(config.phoneNumber) &&
        !scope.workerAlive,
      "WHATSAPP_SOCKET_WORKSPACE_MISMATCH"
    );
    await authorizeLivePrincipal(this.manifest);
  }

  async send(bytes: Uint8Array, filename: string): Promise<SentFile> {
    requireSendAuthorization(
      JSON.stringify(this.manifest),
      this.options.authorizedManifestSha256
    );
    requireProof(!this.sendAttempted, "WHATSAPP_SEND_ALREADY_ATTEMPTED");
    await this.probe();
    this.sendAttempted = true;
    let message: Message | undefined;
    const socket = {
      sendMessage: async (
        jid: string,
        content: Parameters<Socket["sendMessage"]>[1]
      ) => {
        requireProof(
          jid === this.manifest.destination,
          "WHATSAPP_SEND_SCOPE_MISMATCH"
        );
        message = await this.options.socket.sendMessage(jid, content);
        return message;
      },
    } as unknown as Socket;
    this.expectedFilename = filename;
    const delivered = await sendWhatsAppArtifact(
      socket,
      this.manifest.destination,
      { bytes, filename, mimeType: "text/plain" }
    );
    requireProof(
      delivered.ok &&
        message?.key?.id &&
        message.key.fromMe === true &&
        message.key.remoteJid === this.manifest.destination,
      "WHATSAPP_UPLOAD_NOT_CONFIRMED"
    );
    this.sentMessage = message;
    const messageId = message.key.id;
    requireProof(messageId, "WHATSAPP_SENT_MESSAGE_ID_REQUIRED");
    return {
      fileId: messageId,
      messageId,
      sentAt: Number(message.messageTimestamp) * 1000,
    };
  }

  /** Caller forwards real messages.upsert entries; only the exact reply is kept. */
  expectReply(state: RunState): void {
    requireProof(!this.sentMessage, "WHATSAPP_REPLY_ALREADY_BOUND");
    this.sentMessage = {
      key: {
        fromMe: true,
        id: state.sent.messageId,
        remoteJid: this.manifest.destination,
      },
      messageTimestamp: Math.floor(state.sent.sentAt / 1000),
    };
    this.expectedFilename = state.filename;
    this.sendAttempted = true;
  }

  offerInbound(message: Message): boolean {
    if (this.returnedMessage || !this.sentMessage) {
      return false;
    }
    const doc = message.message?.documentMessage;
    if (
      !(
        message.key.fromMe === false &&
        message.key.remoteJid === this.manifest.destination &&
        !message.key.participant &&
        doc?.fileName === this.expectedFilename &&
        doc.contextInfo?.stanzaId === this.sentMessage.key.id &&
        Number(message.messageTimestamp) >=
          Number(this.sentMessage.messageTimestamp)
      )
    ) {
      return false;
    }
    this.returnedMessage = message;
    return true;
  }

  private async download(message: Message): Promise<Uint8Array> {
    await this.authorizeCurrent();
    // Expired media must fail, never request another external reupload message.
    const socket = {
      updateMediaMessage: () => {
        throw new Error("LIVE_PROOF_REUPLOAD_DENIED");
      },
    } as unknown as Socket;
    return (this.options.download ?? downloadWhatsAppMedia)(message, socket, {
      idleTimeoutMs: 10_000,
      maxBytes: MAX_FILE_BYTES,
      overallTimeoutMs: 20_000,
    });
  }

  downloadSent(sent: SentFile): Promise<Uint8Array> {
    requireProof(
      this.sentMessage && this.sentMessage.key.id === sent.messageId,
      "WHATSAPP_SENT_MESSAGE_MISMATCH"
    );
    return this.download(this.sentMessage);
  }

  async receive(state: RunState): Promise<Receipt | null> {
    const message = this.returnedMessage;
    if (!message) {
      return null;
    }
    const doc = message.message?.documentMessage;
    requireProof(
      message.key.id &&
        doc?.contextInfo?.stanzaId === state.sent.messageId &&
        doc.fileName === state.filename,
      "WHATSAPP_RECEIPT_MISMATCH"
    );
    return {
      bytes: await this.download(message),
      destination: this.manifest.destination,
      filename: state.filename,
      messageId: message.key.id,
      receivedAt: Number(message.messageTimestamp) * 1000,
      receiverUserId: this.manifest.receiverUserId,
      replyToMessageId: state.sent.messageId,
    };
  }
}
