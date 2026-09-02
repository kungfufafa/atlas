const archiveDownloadUrlRevokeDelayMs = 1000;

type ArchiveUrlRevokeScheduler = (
  callback: () => void,
  delayMs: number
) => unknown;

export function scheduleArchiveDownloadCleanup(
  url: string,
  schedule: ArchiveUrlRevokeScheduler = window.setTimeout.bind(window),
  revoke: (target: string) => void = URL.revokeObjectURL.bind(URL),
  removeAnchor: () => void = () => undefined
): void {
  schedule(() => {
    removeAnchor();
    revoke(url);
  }, archiveDownloadUrlRevokeDelayMs);
}

export function downloadArchive(filename: string, data: ArrayBuffer): void {
  const url = URL.createObjectURL(
    new Blob([data], { type: "application/zip" })
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  scheduleArchiveDownloadCleanup(url, undefined, undefined, () =>
    anchor.remove()
  );
}
