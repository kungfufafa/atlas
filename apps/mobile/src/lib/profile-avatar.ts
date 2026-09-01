const AVATAR_BASE64_CHUNK_BYTES = 32_768;
const FALLBACK_AVATAR_MEDIA_TYPE = "image/png";
const PROFILE_AVATAR_MAX_DIMENSION = 512;

export function shouldPreserveAvatarTransparency(
  mediaType: string | null | undefined
): boolean {
  const normalized = mediaType?.toLowerCase();
  return (
    normalized === "image/gif" ||
    normalized === "image/png" ||
    normalized === "image/webp"
  );
}

export function profileAvatarResizeActions(
  width: number,
  height: number
): { resize: { height: number; width: number } }[] {
  const longestEdge = Math.max(width, height);
  if (longestEdge <= PROFILE_AVATAR_MAX_DIMENSION) {
    return [];
  }

  const scale = PROFILE_AVATAR_MAX_DIMENSION / longestEdge;
  return [
    {
      resize: {
        height: Math.max(1, Math.round(height * scale)),
        width: Math.max(1, Math.round(width * scale)),
      },
    },
  ];
}

export function arrayBufferToAvatarUri(
  data: ArrayBuffer,
  contentType: string
): string {
  const bytes = new Uint8Array(data);
  const binaryChunks: string[] = [];

  for (
    let offset = 0;
    offset < bytes.length;
    offset += AVATAR_BASE64_CHUNK_BYTES
  ) {
    const chunk = bytes.subarray(
      offset,
      Math.min(offset + AVATAR_BASE64_CHUNK_BYTES, bytes.length)
    );
    binaryChunks.push(String.fromCharCode(...chunk));
  }

  const mediaType = contentType.startsWith("image/")
    ? contentType
    : FALLBACK_AVATAR_MEDIA_TYPE;
  return `data:${mediaType};base64,${btoa(binaryChunks.join(""))}`;
}
