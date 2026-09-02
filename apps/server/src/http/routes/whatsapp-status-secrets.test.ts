import { describe, expect, test } from "bun:test";
import type { OrgRole } from "@atlas/core";
import { writePrivateTextFile } from "@atlas/core/fs";
import {
  getWhatsAppConfigDir,
  getWhatsAppConfigPath,
} from "@atlas/core/whatsapp-config";
import {
  getWhatsAppDevicePairingCodePath,
  getWhatsAppQrCodePath,
} from "@atlas/core/whatsapp-worker";
import type { AuthService } from "../../services/auth-service";
import { setupTestConfigDir } from "../../test-config-dir";
import { createMinimalHonoApp } from "../test-app-helpers";
import { loginUserSession } from "../test-session-helpers";

setupTestConfigDir("atlas-whatsapp-status-secrets-");

const ORG_ID = "org_whatsapp_status";
const PASSWORD = "password123";
const QR_SECRET = "synthetic-qr-secret";
const DEVICE_CODE_SECRET = "synthetic-device-code";

async function seedUser(
  databaseAdapter: ReturnType<typeof createMinimalHonoApp>["databaseAdapter"],
  authService: AuthService,
  role: OrgRole
): Promise<string> {
  const now = new Date().toISOString();
  const email = `${role}@example.com`;
  const userId = `user_${role}`;
  await databaseAdapter.createUser({
    createdAt: now,
    email,
    id: userId,
    passwordHash: await authService.hashPassword(PASSWORD),
    updatedAt: now,
  });
  await databaseAdapter.upsertOrganization({
    createdAt: now,
    id: ORG_ID,
    name: "WhatsApp Status Org",
    slug: "whatsapp-status-org",
    updatedAt: now,
  });
  await databaseAdapter.upsertOrgMember({
    createdAt: now,
    orgId: ORG_ID,
    role,
    userId,
  });
  return email;
}

async function writePairingSecrets(): Promise<void> {
  await writePrivateTextFile(
    getWhatsAppConfigPath(ORG_ID),
    "profile_id=default\naccess_mode=pairing\n",
    { ensureDir: getWhatsAppConfigDir(ORG_ID) }
  );
  await writePrivateTextFile(getWhatsAppQrCodePath(ORG_ID), QR_SECRET, {
    ensureDir: getWhatsAppConfigDir(ORG_ID),
  });
  await writePrivateTextFile(
    getWhatsAppDevicePairingCodePath(ORG_ID),
    DEVICE_CODE_SECRET,
    { ensureDir: getWhatsAppConfigDir(ORG_ID) }
  );
}

describe("WhatsApp status secret boundary", () => {
  for (const role of ["member", "viewer"] as const) {
    test(`general system status redacts pairing secrets for ${role}`, async () => {
      const { app, authService, databaseAdapter } = createMinimalHonoApp({
        systemStatus: {
          getStatus: async () => ({
            checkedAt: "2026-08-31T00:00:00.000Z",
            whatsappWorker: {
              configured: true,
              connected: false,
              devicePairingCode: DEVICE_CODE_SECRET,
              ok: true,
              paired: false,
              qrCode: QR_SECRET,
              running: true,
            },
          }),
        },
      });
      const email = await seedUser(databaseAdapter, authService, role);
      const session = await loginUserSession(app, email, PASSWORD, ORG_ID);

      const response = await app.fetch(
        new Request("http://localhost:4310/v1/system/status", {
          headers: session.headers(),
        })
      );
      const raw = await response.text();
      const body = JSON.parse(raw) as {
        whatsappWorker: {
          devicePairingCode: string | null;
          qrCode: string | null;
          running: boolean;
        };
      };

      expect(response.status).toBe(200);
      expect(raw).not.toContain(QR_SECRET);
      expect(raw).not.toContain(DEVICE_CODE_SECRET);
      expect(body.whatsappWorker).toMatchObject({
        devicePairingCode: null,
        qrCode: null,
        running: true,
      });
    });

    test(`pairing-secret endpoint is forbidden for ${role}`, async () => {
      const { app, authService, databaseAdapter } = createMinimalHonoApp();
      const email = await seedUser(databaseAdapter, authService, role);
      const session = await loginUserSession(app, email, PASSWORD, ORG_ID);

      const response = await app.fetch(
        new Request(
          "http://localhost:4310/v1/settings/whatsapp/pairing-status",
          { headers: session.headers() }
        )
      );

      expect(response.status).toBe(403);
    });
  }

  test("pairing-secret endpoint returns only pairing secrets to an admin", async () => {
    const { app, authService, databaseAdapter } = createMinimalHonoApp();
    const email = await seedUser(databaseAdapter, authService, "admin");
    const session = await loginUserSession(app, email, PASSWORD, ORG_ID);
    await writePairingSecrets();

    const response = await app.fetch(
      new Request("http://localhost:4310/v1/settings/whatsapp/pairing-status", {
        headers: session.headers(),
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      devicePairingCode: DEVICE_CODE_SECRET,
      qrCode: QR_SECRET,
    });
  });
});
