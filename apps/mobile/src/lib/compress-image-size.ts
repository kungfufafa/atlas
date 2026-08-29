export const COMPRESS_IMAGE_OVER_BYTES = 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 2048;

export function base64ByteLength(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

export function scaleImageDimensions(
  width: number,
  height: number,
  maxDimension: number
): { height: number; width: number } {
  const longestEdge = Math.max(width, height);
  if (longestEdge <= maxDimension) {
    return { height, width };
  }

  const scale = maxDimension / longestEdge;
  return {
    height: Math.max(1, Math.round(height * scale)),
    width: Math.max(1, Math.round(width * scale)),
  };
}
