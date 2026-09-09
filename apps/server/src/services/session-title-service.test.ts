import { describe, expect, mock, test } from "bun:test";
import type { ProviderClient, ProviderInstance, UserConfig } from "@atlas/core";
import { createInMemoryDatabaseAdapter, type DatabaseAdapter } from "@atlas/db";
import { SessionTitleService } from "./session-title-service";

const NOW = "2026-08-26T00:00:00.000Z";
const ARCHIVED_AT = "2026-08-26T00:01:00.000Z";
const ORG_ID = "org_1";
const PROFILE_ID = "profile_1";
const PROVIDER_ID = "provider_1";
const SESSION_ID = "session_1";

const PROVIDER_INSTANCE: ProviderInstance = {
  apiKey: "test-key",
  createdAt: NOW,
  id: PROVIDER_ID,
  label: "OpenAI",
  type: "openai",
};

const USER_CONFIG: UserConfig = {
  defaultProviderId: PROVIDER_ID,
  providers: [PROVIDER_INSTANCE],
};

interface SeedOptions {
  archivedAt?: string | null;
  includeOrganization?: boolean;
  includeProfile?: boolean;
  profileOrgId?: string | null;
  sessionOrgId?: string | null;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function seedEligibleSession(
  db: DatabaseAdapter,
  options: SeedOptions = {}
): Promise<void> {
  const profileOrgId = options.profileOrgId ?? ORG_ID;
  const sessionOrgId = options.sessionOrgId ?? ORG_ID;

  if (options.includeOrganization ?? true) {
    await db.upsertOrganization({
      archivedAt: options.archivedAt ?? null,
      createdAt: NOW,
      id: ORG_ID,
      name: "Organization",
      slug: "organization",
      updatedAt: NOW,
    });
  }

  if (options.includeProfile ?? true) {
    await db.upsertProfile({
      createdAt: NOW,
      id: PROFILE_ID,
      isSuper: false,
      model: `${PROVIDER_ID}::gpt-5.4`,
      name: "Assistant",
      orgId: profileOrgId,
      systemPrompt: "",
      updatedAt: NOW,
    });
  }

  await db.upsertSession({
    agentQuestionnaire: null,
    agentTodos: [],
    channel: "web",
    createdAt: NOW,
    id: SESSION_ID,
    modelOverride: null,
    orgId: sessionOrgId,
    profileId: PROFILE_ID,
    title: null,
    userId: "user_1",
  });
  await db.appendMessagesForSession(SESSION_ID, [
    {
      createdAt: NOW,
      id: "message_1",
      payload: { content: "Plan the launch", role: "user" },
      seq: 0,
      sessionId: SESSION_ID,
    },
    {
      createdAt: NOW,
      id: "message_2",
      payload: { content: "Let's make a checklist.", role: "assistant" },
      seq: 1,
      sessionId: SESSION_ID,
    },
  ]);
}

async function archiveOrganization(db: DatabaseAdapter): Promise<void> {
  const organization = await db.getOrganizationById(ORG_ID);

  if (!organization) {
    throw new Error("Expected the test organization to exist");
  }

  await db.upsertOrganization({
    ...organization,
    archivedAt: ARCHIVED_AT,
    updatedAt: ARCHIVED_AT,
  });
}

function createProvider(
  generateText: ProviderClient["generateText"]
): ProviderClient {
  return {
    async generateChat() {
      throw new Error("unused");
    },
    generateText,
    name: "openai",
    async streamChat() {
      throw new Error("unused");
    },
  };
}

async function generateSessionTitle(
  service: SessionTitleService
): Promise<void> {
  await service.generateSessionTitle(SESSION_ID);
}

describe("SessionTitleService organization guards", () => {
  test("fails closed for an already archived organization before provider work", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedEligibleSession(db, { archivedAt: ARCHIVED_AT });
    const getUserConfig = mock(() => USER_CONFIG);
    const providerFactory = mock(() =>
      createProvider(async () => ({ content: "Launch Plan" }))
    );
    const service = new SessionTitleService(db, getUserConfig, providerFactory);

    await generateSessionTitle(service);

    expect(getUserConfig).toHaveBeenCalledTimes(0);
    expect(providerFactory).toHaveBeenCalledTimes(0);
    expect((await db.getSession(SESSION_ID))?.title).toBeNull();
  });

  test.each([
    ["missing profile", { includeProfile: false }],
    ["missing organization", { includeOrganization: false }],
    ["session/profile organization mismatch", { sessionOrgId: "org_2" }],
  ] as const)(
    "fails closed for %s before provider work",
    async (_name, options) => {
      const db = createInMemoryDatabaseAdapter();
      await seedEligibleSession(db, options);
      const getUserConfig = mock(() => USER_CONFIG);
      const providerFactory = mock(() =>
        createProvider(async () => ({ content: "Launch Plan" }))
      );
      const service = new SessionTitleService(
        db,
        getUserConfig,
        providerFactory
      );

      await generateSessionTitle(service);

      expect(getUserConfig).toHaveBeenCalledTimes(0);
      expect(providerFactory).toHaveBeenCalledTimes(0);
      expect((await db.getSession(SESSION_ID))?.title).toBeNull();
    }
  );

  test("does not commit a generated title when the organization is archived during generation", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedEligibleSession(db);
    const generationStarted = deferred<void>();
    const resumeGeneration = deferred<void>();
    const provider = createProvider(async () => {
      generationStarted.resolve();
      await resumeGeneration.promise;
      return { content: "Launch Plan" };
    });
    const service = new SessionTitleService(
      db,
      () => USER_CONFIG,
      () => provider
    );

    const generation = generateSessionTitle(service);
    await generationStarted.promise;
    await archiveOrganization(db);
    resumeGeneration.resolve();
    await generation;

    expect((await db.getSession(SESSION_ID))?.title).toBeNull();
  });

  test("does not commit the fallback when the organization is archived while resolving config", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedEligibleSession(db);
    const providerFactory = mock(() =>
      createProvider(async () => ({ content: "Launch Plan" }))
    );
    const service = new SessionTitleService(
      db,
      async () => {
        await archiveOrganization(db);
        return null;
      },
      providerFactory
    );

    await generateSessionTitle(service);

    expect(providerFactory).toHaveBeenCalledTimes(0);
    expect((await db.getSession(SESSION_ID))?.title).toBeNull();
  });

  test("does not create or invoke a provider when config resolution archives the organization", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedEligibleSession(db);
    const generateText = mock(async () => ({ content: "Launch Plan" }));
    const providerFactory = mock(() => createProvider(generateText));
    const service = new SessionTitleService(
      db,
      async () => {
        await archiveOrganization(db);
        return USER_CONFIG;
      },
      providerFactory
    );

    await generateSessionTitle(service);

    expect(providerFactory).toHaveBeenCalledTimes(0);
    expect(generateText).toHaveBeenCalledTimes(0);
    expect((await db.getSession(SESSION_ID))?.title).toBeNull();
  });

  test("rechecks that the title is null before committing provider output", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedEligibleSession(db);
    const generationStarted = deferred<void>();
    const resumeGeneration = deferred<void>();
    const provider = createProvider(async () => {
      generationStarted.resolve();
      await resumeGeneration.promise;
      return { content: "Generated Title" };
    });
    const service = new SessionTitleService(
      db,
      () => USER_CONFIG,
      () => provider
    );

    const generation = generateSessionTitle(service);
    await generationStarted.promise;
    await db.updateSessionTitle(SESSION_ID, "Manual Title");
    resumeGeneration.resolve();
    await generation;

    expect((await db.getSession(SESSION_ID))?.title).toBe("Manual Title");
  });

  test("commits the first-user fallback while the organization remains active", async () => {
    const db = createInMemoryDatabaseAdapter();
    await seedEligibleSession(db);
    const service = new SessionTitleService(db, () => null);

    await generateSessionTitle(service);

    expect((await db.getSession(SESSION_ID))?.title).toBe("Plan the launch");
  });
});
