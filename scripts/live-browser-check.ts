import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createClient } from "@atlas/client";
import { getUserConfigDir } from "@atlas/core/config";
import { loadLocalAuthToken } from "@atlas/core/local-auth";
import { resolveServerUrl } from "@atlas/core/runtime";

const authToken = await loadLocalAuthToken();
if (!authToken) {
  throw new Error("no auth token");
}

const client = createClient({ authToken, baseUrl: resolveServerUrl() });
const health = await client.health();
if (!health.ok) {
  throw new Error("health failed");
}

const orgs = await client.listUserOrgs();
const org = orgs.orgs[0];
if (!org) {
  throw new Error("no org");
}

client.setOrgId(org.id);
const profiles = await client.listProfiles();
const profile =
  profiles.profiles.find((item) => item.isDefault && !item.isSuper) ??
  profiles.profiles[0];
if (!profile) {
  throw new Error("no profile");
}

const session = await client.createSession("cli", { profileId: profile.id });
const tools: string[] = [];
const started = Date.now();
const reply = await session.sendStream(
  "Buka https://www.tokopedia.com/about dengan tool browser, baca heading utama, ambil screenshot, tutup browser. Kalau gagal laporkan error tool apa adanya, jangan klaim sukses.",
  {
    onChunk: () => undefined,
    onToolEnd: (event) => {
      console.log(
        "end",
        event.tool,
        JSON.stringify(event.result).slice(0, 500)
      );
    },
    onToolStart: (event) => {
      tools.push(event.tool);
      console.log("start", event.tool, JSON.stringify(event.input));
    },
  }
);

console.log("duration_ms", Date.now() - started);
console.log("tools", tools.join(","));
console.log("reply", reply);

const artifactsDir = join(
  getUserConfigDir(),
  "orgs",
  org.id,
  "profiles",
  profile.id,
  "artifacts"
);
const names = (await readdir(artifactsDir)).filter((name) =>
  name.endsWith(".png")
);
console.log("pngs", names.join(", ") || "(none)");
