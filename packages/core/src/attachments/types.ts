export interface SavedInlineAttachment {
  attachmentId: string;
  size: number;
}

export interface SaveInlineAttachmentInput {
  bytes: Buffer;
  filename?: string;
  kind: "image" | "document";
  mediaType: string;
}

export type SaveInlineAttachment = (
  input: SaveInlineAttachmentInput
) => Promise<SavedInlineAttachment>;

export interface LoadedAttachmentBytes {
  bytes: Buffer;
  filename?: string | null;
  mediaType: string;
}

export type LoadAttachmentBytes = (
  attachmentId: string
) => Promise<LoadedAttachmentBytes | null>;
