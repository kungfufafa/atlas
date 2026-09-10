export function parseCommand(text: string): string {
  return text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

export function isStopCommand(text: string): boolean {
  return parseCommand(text) === "/stop";
}
