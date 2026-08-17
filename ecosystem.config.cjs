"use strict";

const root = __dirname;

module.exports = {
  apps: [
    {
      args: ["run", "apps/server/src/index.ts"],
      autorestart: true,
      cwd: root,
      env: {
        ATLAS_HOST: process.env.ATLAS_HOST || "0.0.0.0",
        ATLAS_PORT: process.env.ATLAS_PORT || "4310",
        NODE_ENV: "production",
      },
      exec_mode: "fork",
      instances: 1,
      name: "atlas",
      script: "bun",
    },
  ],
};
