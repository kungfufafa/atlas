export interface SentryDsn {
  endpoint: string;
  publicKey: string;
}

export function parseSentryDsn(dsn: string): SentryDsn | null {
  const trimmed = dsn.trim();

  if (!trimmed) {
    return null;
  }

  let url: URL;

  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (!(url.protocol === "http:" || url.protocol === "https:")) {
    return null;
  }

  const publicKey = url.username;
  const segments = url.pathname.split("/").filter(Boolean);
  const projectId = segments.pop();

  if (!(publicKey && projectId)) {
    return null;
  }

  const prefix = segments.length > 0 ? `/${segments.join("/")}` : "";

  return {
    endpoint: `${url.protocol}//${url.host}${prefix}/api/${projectId}/store/`,
    publicKey,
  };
}
