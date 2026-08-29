import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

const projectRoot = import.meta.dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const shims = {
  "@atlas/core/local-auth": path.resolve(
    projectRoot,
    "src/shims/local-auth.ts"
  ),
  "@atlas/core/runtime": path.resolve(projectRoot, "src/shims/runtime.ts"),
  "node:async_hooks": path.resolve(projectRoot, "src/shims/async-hooks.ts"),
  "node:crypto": path.resolve(projectRoot, "src/shims/empty.ts"),
  "node:fs": path.resolve(projectRoot, "src/shims/empty.ts"),
  "node:path": path.resolve(projectRoot, "src/shims/node-path.ts"),
};

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
config.resolver.extraNodeModules = {
  "@atlas/client": path.resolve(workspaceRoot, "packages/client"),
  "@atlas/core": path.resolve(workspaceRoot, "packages/core"),
  "@atlas/design-tokens": path.resolve(workspaceRoot, "packages/design-tokens"),
};

const defaultResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const shim = shims[moduleName];
  if (shim) {
    return { filePath: shim, type: "sourceFile" };
  }

  if (typeof defaultResolve === "function") {
    return defaultResolve(context, moduleName, platform);
  }

  return context.resolveRequest(context, moduleName, platform);
};

export default withNativeWind(config, {
  inlineRem: 16,
  input: "./src/global.css",
});
