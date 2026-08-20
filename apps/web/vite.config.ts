import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const serverUrl = process.env.ATLAS_SERVER_URL ?? "http://127.0.0.1:4310";

export default defineConfig({
  optimizeDeps: {
    exclude: ["nodemailer", "imapflow", "mailparser"],
  },
  plugins: [react(), tailwindcss()],
  preview: {
    port: 3000,
  },
  resolve: {
    alias: {
      "@": path.resolve(root, "src"),
      "@atlas/core/local-auth": path.resolve(
        root,
        "src/shims/core-local-auth.ts"
      ),
      "@atlas/core/runtime": path.resolve(root, "src/shims/core-runtime.ts"),
      "@atlas/core/thinking-content": path.resolve(
        root,
        "../../packages/core/src/thinking-content.ts"
      ),
      "node:async_hooks": path.resolve(root, "src/shims/async-hooks.ts"),
      // Native N-API converter — server-only; keep the browser bundle free of .node binaries.
      [path.resolve(root, "../../packages/core/src/anydoc-text.ts")]:
        path.resolve(root, "src/shims/anydoc-text.ts"),
      "@firecrawl/anydoc": path.resolve(root, "src/shims/firecrawl-anydoc.ts"),
      imapflow: path.resolve(root, "src/shims/imapflow.ts"),
      mailparser: path.resolve(root, "src/shims/mailparser.ts"),
      nodemailer: path.resolve(root, "src/shims/nodemailer.ts"),
    },
  },
  server: {
    port: 3000,
    proxy: {
      "/health": serverUrl,
      "/v1": serverUrl,
    },
  },
});
