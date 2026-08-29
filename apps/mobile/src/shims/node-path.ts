export function dirname(filePath: string): string {
  const trimmed = filePath.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  if (index <= 0) {
    return "/";
  }
  return trimmed.slice(0, index);
}

export function join(...parts: string[]): string {
  return parts
    .flatMap((part) => part.split("/"))
    .filter((part) => part.length > 0)
    .join("/");
}
