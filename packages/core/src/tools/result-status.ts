/** A completed callback can still report a failed operation in its payload. */
export function isFailedToolResult(result: unknown): boolean {
  if (!result || typeof result !== "object") {
    return false;
  }
  const record = result as Record<string, unknown>;
  return Boolean(
    record.error ||
      record.success === false ||
      record.ok === false ||
      record.isError === true
  );
}
