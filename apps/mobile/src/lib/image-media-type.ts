const DATA_URL_PREFIX = /^data:[^,]*,/u;

function hasBytes(binary: string, expected: readonly number[]): boolean {
  if (binary.length < expected.length) {
    return false;
  }
  return expected.every((value, index) => binary.charCodeAt(index) === value);
}

export function resolvePickedImageMediaType(
  data: string,
  declaredMediaType: string
): string {
  try {
    const payload = data.replace(DATA_URL_PREFIX, "");
    const binary = atob(payload.slice(0, 24));

    if (hasBytes(binary, [137, 80, 78, 71, 13, 10, 26, 10])) {
      return "image/png";
    }
    if (hasBytes(binary, [255, 216, 255])) {
      return "image/jpeg";
    }
    if (binary.startsWith("GIF87a") || binary.startsWith("GIF89a")) {
      return "image/gif";
    }
    if (binary.startsWith("RIFF") && binary.slice(8, 12) === "WEBP") {
      return "image/webp";
    }
  } catch {
    // Keep the picker-provided MIME type when the prefix cannot be decoded.
  }

  return declaredMediaType;
}
