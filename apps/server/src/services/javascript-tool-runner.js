import { pathToFileURL } from "node:url";

const mode = process.argv[2];
const modulePath = process.argv[3];

if ((mode !== "--inspect" && mode !== "--run") || !modulePath) {
  console.error("Usage: javascript-tool-runner.js <--inspect|--run> <module>");
  process.exit(1);
}

// Keep ordinary tool logging out of the JSON protocol on stdout.
console.debug = (...args) => console.error(...args);
console.info = (...args) => console.error(...args);
console.log = (...args) => console.error(...args);

const imported = await import(pathToFileURL(modulePath).href);
const defaultExport =
  typeof imported.default === "object" && imported.default !== null
    ? imported.default
    : null;
const source = defaultExport ?? imported;
const run = source.run;

if (typeof run !== "function") {
  console.error("Tool module must export a run(input, context) function.");
  process.exit(1);
}

if (mode === "--inspect") {
  const parameters =
    typeof source.parameters === "object" && source.parameters !== null
      ? source.parameters
      : typeof imported.parameters === "object" && imported.parameters !== null
        ? imported.parameters
        : undefined;

  process.stdout.write(
    JSON.stringify({
      parallelSafe:
        source.parallelSafe === true || imported.parallelSafe === true,
      parameters,
      retrySafe: source.retrySafe === true || imported.retrySafe === true,
    })
  );
} else {
  const payload = JSON.parse((await Bun.stdin.text()) || "{}");
  const result = await run(payload, {
    workspaceRoot: process.env.ATLAS_WORKSPACE_ROOT,
  });
  process.stdout.write(JSON.stringify(result));
}
