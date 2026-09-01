export function readFileAsDataUrl(
  file: Blob,
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    const cleanup = () => {
      signal?.removeEventListener("abort", handleAbort);
    };
    const handleAbort = () => {
      reader.abort();
      cleanup();
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };

    if (signal?.aborted) {
      handleAbort();
      return;
    }

    reader.onload = () => {
      cleanup();
      resolve(reader.result as string);
    };
    reader.onerror = () => {
      cleanup();
      reject(reader.error ?? new Error("Failed to read file."));
    };
    reader.onabort = cleanup;
    signal?.addEventListener("abort", handleAbort, { once: true });
    reader.readAsDataURL(file);
  });
}
