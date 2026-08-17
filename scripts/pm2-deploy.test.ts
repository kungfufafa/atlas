import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

describe("pm2 deploy config", () => {
  test("starts one atlas process on 0.0.0.0:4310", async () => {
    const config = (await import(join(root, "ecosystem.config.cjs"))) as {
      default?: { apps: Array<Record<string, unknown>> };
      apps?: Array<Record<string, unknown>>;
    };
    const apps = config.apps ?? config.default?.apps ?? [];
    const atlas = apps[0] as
      | {
          cwd: string;
          env: { ATLAS_HOST: string; ATLAS_PORT: string };
          instances: number;
          name: string;
          script: string;
        }
      | undefined;

    expect(apps).toHaveLength(1);
    expect(atlas?.name).toBe("atlas");
    expect(atlas?.script).toBe("bun");
    expect(atlas?.instances).toBe(1);
    expect(atlas?.cwd).toBe(root);
    expect(atlas?.env.ATLAS_HOST).toBe("0.0.0.0");
    expect(atlas?.env.ATLAS_PORT).toBe("4310");
  });

  test("installs LibreOffice so Office artifact previews work", async () => {
    const { readFile } = await import("node:fs/promises");
    const dockerfile = await readFile(join(root, "Dockerfile"), "utf8");
    const ensure = await readFile(
      join(root, "scripts/ensure-office-converter.sh"),
      "utf8"
    );
    const deploy = await readFile(join(root, "scripts/pm2-deploy.sh"), "utf8");

    expect(dockerfile).toContain("libreoffice-writer");
    expect(dockerfile).toContain("libreoffice-impress");
    expect(dockerfile).toContain("libreoffice-calc");
    expect(dockerfile).toContain(
      "ATLAS_OFFICE_CONVERTER_PATH=/usr/bin/soffice"
    );
    expect(ensure).toContain("soffice");
    expect(deploy).toContain("ensure-office-converter.sh");
  });
});
