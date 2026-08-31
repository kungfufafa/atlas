// Unit tests that exercise higher-level tool registration should not depend on
// nested OS sandbox support. Security tests opt back into the production
// boundary with SpawnJsonToolOptions.requireSandbox.
process.env.ATLAS_ALLOW_UNSANDBOXED_CUSTOM_TOOLS ??= "1";
