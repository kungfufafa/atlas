import { pathToFileURL } from "node:url";

const mode = process.argv[2];
const modulePath = process.argv[3];
if ((mode !== "--inspect" && mode !== "--run") || !modulePath) {
  throw new Error("Skill runner requires --inspect or --run and a module.");
}
console.debug = (...args) => console.error(...args);
console.info = (...args) => console.error(...args);
console.log = (...args) => console.error(...args);

// Bun parses TS inside this already-confined child. No host import or build hook.
const imported = await import(pathToFileURL(modulePath).href);
const source =
  imported.default && typeof imported.default === "object"
    ? imported.default
    : imported;
if (typeof source.run !== "function") {
  throw new Error("Skill module must export run(input, context).");
}
if (mode === "--inspect") {
  process.stdout.write(
    JSON.stringify({
      description:
        typeof source.description === "string" ? source.description : undefined,
      name: typeof source.name === "string" ? source.name : undefined,
      parameters:
        source.parameters && typeof source.parameters === "object"
          ? source.parameters
          : undefined,
    })
  );
} else {
  const payload = JSON.parse((await Bun.stdin.text()) || "{}");
  const context = {
    ...payload.context,
    workspaceRoot: process.env.ATLAS_WORKSPACE_ROOT,
  };
  for (const name of [
    "beforeToolCall",
    "emitSubAgentActivity",
    "forceSkillWriteProposal",
    "loadAttachment",
    "onToolTurnEnd",
    "recordToolOutputSavings",
    "recordTurnUsage",
    "requestChannelAction",
    "requestToolApproval",
  ]) {
    Object.defineProperty(context, name, {
      get() {
        throw new Error(
          `Skill subprocess cannot use host callback ${name}; use an Atlas built-in tool or a supported JSON/context interface.`
        );
      },
    });
  }
  process.stdout.write(
    JSON.stringify(await source.run(payload.input, context))
  );
}
