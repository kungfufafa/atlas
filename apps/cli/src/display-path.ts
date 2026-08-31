import { homedir } from "node:os";

/** True when the CLI was started with `--verbose`. */
export function isCliVerbose(argv = process.argv.slice(2)): boolean {
  return argv.includes("--verbose");
}

/**
 * Paths shown in CLI output. By default this masks home and tenant/profile ids
 * so shared terminals and recordings do not disclose local identifiers.
 */
export function formatCliDisplayPath(
  absolutePath: string,
  verbose = false
): string {
  if (verbose) {
    return absolutePath;
  }

  let output = absolutePath;
  const home = homedir();

  if (
    home &&
    home !== "/" &&
    (output === home || output.startsWith(`${home}/`))
  ) {
    output = `~${output.slice(home.length)}`;
  } else {
    output = output
      .replace(/\/(?:Users|home)\/[^/]+/g, "~")
      .replace(/[A-Za-z]:\\Users\\[^\\]+/g, "~");
  }

  return output
    .replace(/\/orgs\/[^/]+/g, "/orgs/<org>")
    .replace(/\/profiles\/[^/]+/g, "/profiles/<profile>");
}
