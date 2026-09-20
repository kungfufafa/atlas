export function parseCommand(text: string): string {
  return text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

export function isStopCommand(text: string): boolean {
  return parseCommand(text) === "/stop";
}

export type WhatsAppChatControl = "stop" | "pause" | "resume";

const PAUSE_REQUEST =
  /^(?:(?:atlas|bot)[, ]+)?(?:(?:tolong|please|bisa|boleh|can you|could you) )?(?:(?:diem|diam|hening)(?: dulu| sebentar)?|(?:jangan|ga usah|gak usah|nggak usah) (?:balas|jawab)(?: dulu)?|(?:be |stay )?quiet(?: for now)?|pause(?: replies)?)(?: (?:ga|gak|nggak|ya|dong|please))?$/i;
const RESUME_REQUEST =
  /^(?:(?:atlas|bot)[, ]+)?(?:(?:boleh|silakan|silahkan|please) )?(?:(?:balas|jawab|bicara) lagi|(?:resume|unpause)(?: replies)?)$/i;
const CONTROL_PUNCTUATION = /[.!?,]+$/;

/** Match whole requests only; quoted examples and longer tasks remain chat text. */
export function parseWhatsAppChatControl(
  text: string
): WhatsAppChatControl | null {
  if (isStopCommand(text)) {
    return "stop";
  }
  const command = parseCommand(text);
  if (command === "/pause" || command === "/mute") {
    return "pause";
  }
  if (command === "/resume" || command === "/unmute") {
    return "resume";
  }
  const request = text.trim().replace(CONTROL_PUNCTUATION, "").trim();
  if (PAUSE_REQUEST.test(request)) {
    return "pause";
  }
  return RESUME_REQUEST.test(request) ? "resume" : null;
}

/** Text must have only verified bot mentions stripped, as in the handler. */
export function isWhatsAppChatControlCandidate(text: string): boolean {
  return parseWhatsAppChatControl(text) !== null;
}
