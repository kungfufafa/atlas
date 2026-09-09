import { expect, test } from "bun:test";
import type {
  ChatMessage,
  GenerateTextInput,
  GenerateTextResult,
  ProviderClient,
  ProviderInstance,
  UserConfig,
} from "@atlas/core";
import {
  createInMemoryDatabaseAdapter,
  createSqliteDatabase,
  type DatabaseAdapter,
} from "@atlas/db";
import { SessionTitleService } from "./session-title-service";

const NOW = "2026-09-07T00:00:00.000Z";
const ORG = "title-org";
const PROFILE = "title-profile";
const ID = "title-session";
const TARGET: ProviderInstance = {
  apiKey: "fixture-key",
  baseUrl: "https://example.invalid/v1",
  createdAt: NOW,
  customModels: [{ id: "explicit-title-model" }],
  id: "title-provider",
  label: "Title provider",
  type: "openai_compatible",
};
const CONFIG: UserConfig = {
  defaultProviderId: "other-provider",
  providers: [{ ...TARGET, id: "other-provider" }, TARGET],
};
type UserContent = Extract<ChatMessage, { role: "user" }>["content"];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function provider(
  generateText: (input: GenerateTextInput) => Promise<GenerateTextResult>
): ProviderClient {
  return {
    async generateChat() {
      throw new Error("Unused fixture");
    },
    generateText,
    name: "openai_compatible",
    async streamChat() {
      throw new Error("Unused fixture");
    },
  };
}
async function fixture(
  kind: "memory" | "sqlite",
  content: UserContent = "Plan the launch"
) {
  const sqlite =
    kind === "sqlite" ? await createSqliteDatabase(":memory:") : null;
  const db: DatabaseAdapter =
    sqlite?.adapter ?? createInMemoryDatabaseAdapter();
  await db.upsertOrganization({
    createdAt: NOW,
    id: ORG,
    name: ORG,
    slug: ORG,
    updatedAt: NOW,
  });
  await db.upsertOrganization({
    createdAt: NOW,
    id: "moved-org",
    name: "Moved",
    slug: "moved",
    updatedAt: NOW,
  });
  await db.upsertProfile({
    createdAt: NOW,
    id: PROFILE,
    isSuper: false,
    model: `${TARGET.id}::explicit-title-model`,
    name: PROFILE,
    orgId: ORG,
    systemPrompt: "",
    updatedAt: NOW,
  });
  await db.upsertSession({
    agentQuestionnaire: null,
    agentTodos: [],
    channel: "web",
    createdAt: NOW,
    id: ID,
    modelOverride: "other-provider::another-model",
    orgId: ORG,
    profileId: PROFILE,
    title: null,
    userId: null,
  });
  await db.appendMessagesForSession(ID, [
    {
      createdAt: NOW,
      id: "user",
      payload: { content, role: "user" },
      seq: 0,
      sessionId: ID,
    },
    {
      createdAt: NOW,
      id: "assistant",
      payload: { content: "The requested work is ready.", role: "assistant" },
      seq: 1,
      sessionId: ID,
    },
  ]);
  return { close: () => sqlite?.close(), db };
}
function service(
  db: DatabaseAdapter,
  generate: ProviderClient,
  config: UserConfig | null = CONFIG,
  selected?: string[]
) {
  return new SessionTitleService(
    db,
    () => config,
    (instance, model) => {
      selected?.push(`${instance.id}::${model}`);
      return generate;
    },
    { generationTimeoutMs: 25 }
  );
}

for (const kind of ["memory", "sqlite"] as const) {
  test(`${kind}: failed title generation commits useful first-user fallback`, async () => {
    const f = await fixture(kind);
    try {
      await service(
        f.db,
        provider(async () => {
          throw new Error("Fixture title unavailable");
        })
      ).generateSessionTitle(ID);
      expect((await f.db.getSession(ID))?.title).toBe("Plan the launch");
    } finally {
      f.close();
    }
  });

  test(`${kind}: unavailable provider uses local fallback without invoking another target`, async () => {
    const f = await fixture(kind);
    let calls = 0;
    try {
      await service(
        f.db,
        provider(async () => {
          calls++;
          return { content: "Unexpected" };
        }),
        null
      ).generateSessionTitle(ID);
      expect(calls).toBe(0);
      expect((await f.db.getSession(ID))?.title).toBe("Plan the launch");
    } finally {
      f.close();
    }
  });

  test(`${kind}: cancellation retains the in-flight job through cleanup and ignores late success`, async () => {
    const f = await fixture(kind);
    const entered = deferred<GenerateTextInput>();
    const finish = deferred<GenerateTextResult>();
    let calls = 0;
    const title = service(
      f.db,
      provider((input) => {
        calls++;
        entered.resolve(input);
        return finish.promise;
      })
    );
    const operation = title.generateSessionTitle(ID);
    try {
      const input = await entered.promise;
      expect(input.signal).toBeInstanceOf(AbortSignal);
      if (!input.signal) {
        throw new Error("Expected title cancellation signal");
      }
      const signal = input.signal;
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      expect(signal.aborted).toBe(true);
      await title.generateSessionTitle(ID);
      expect(calls).toBe(1);
      expect((await f.db.getSession(ID))?.title).toBeNull();
      finish.resolve({ content: "Late AI result" });
      await operation;
      expect((await f.db.getSession(ID))?.title).toBe("Plan the launch");
      await title.generateSessionTitle(ID);
      expect(calls).toBe(1);
    } finally {
      finish.resolve({ content: "Late AI result" });
      await operation;
      f.close();
    }
  });

  test(`${kind}: successful AI title keeps exact configured profile target`, async () => {
    const f = await fixture(kind);
    const selected: string[] = [];
    try {
      await service(
        f.db,
        provider(async () => ({ content: '"Launch Plan"' })),
        CONFIG,
        selected
      ).generateSessionTitle(ID);
      expect((await f.db.getSession(ID))?.title).toBe("Launch Plan");
      expect(selected).toEqual(["title-provider::explicit-title-model"]);
    } finally {
      f.close();
    }
  });

  test(`${kind}: manual title wins the final database compare-and-set`, async () => {
    const f = await fixture(kind);
    const commit = f.db.updateSessionTitle.bind(f.db);
    let commits = 0;
    const updateTitle: DatabaseAdapter["updateSessionTitle"] = async (
      id,
      value
    ) => {
      commits++;
      await commit(id, "Manual title wins");
      return commit(id, value);
    };
    const commitDb = new Proxy(f.db, {
      get(target, property, receiver) {
        return property === "updateSessionTitle"
          ? updateTitle
          : Reflect.get(target, property, receiver);
      },
    });
    try {
      await service(
        commitDb,
        provider(async () => ({ content: "Automatic title" }))
      ).generateSessionTitle(ID);
      expect(commits).toBe(1);
      expect((await f.db.getSession(ID))?.title).toBe("Manual title wins");
    } finally {
      f.close();
    }
  });

  for (const mutation of [
    "manual",
    "deleted",
    "session-moved",
    "profile-moved",
    "archived",
  ] as const) {
    test(`${kind}: ${mutation} while generation is pending prevents a stale fallback`, async () => {
      const f = await fixture(kind);
      const entered = deferred<void>();
      const finish = deferred<void>();
      const title = service(
        f.db,
        provider(async () => {
          entered.resolve();
          await finish.promise;
          throw new Error("Fixture title failed");
        })
      );
      const operation = title.generateSessionTitle(ID);
      try {
        await entered.promise;
        if (mutation === "manual") {
          await f.db.updateSessionTitle(ID, "User title");
        }
        if (mutation === "deleted") {
          await f.db.deleteSession(ID);
        }
        if (mutation === "session-moved") {
          const session = await f.db.getSession(ID);
          if (!session) {
            throw new Error("Missing fixture session");
          }
          await f.db.upsertSession({ ...session, orgId: "moved-org" });
        }
        if (mutation === "profile-moved") {
          const profile = await f.db.getProfile(PROFILE);
          if (!profile) {
            throw new Error("Missing fixture profile");
          }
          await f.db.upsertProfile({ ...profile, orgId: "moved-org" });
        }
        if (mutation === "archived") {
          const org = await f.db.getOrganizationById(ORG);
          if (!org) {
            throw new Error("Missing fixture organization");
          }
          await f.db.upsertOrganization({ ...org, archivedAt: NOW });
        }
        finish.resolve();
        await operation;
        expect((await f.db.getSession(ID))?.title ?? null).toBe(
          mutation === "manual" ? "User title" : null
        );
      } finally {
        finish.resolve();
        await operation;
        f.close();
      }
    });
  }
}

test("fallback preserves whole Unicode graphemes within a finite stored length", async () => {
  const cluster = "👨‍👩‍👧‍👦";
  const f = await fixture("memory", `  Café\n ${cluster.repeat(30)}  `);
  try {
    await service(
      f.db,
      provider(async () => {
        throw new Error("Fixture unavailable");
      })
    ).generateSessionTitle(ID);
    const title = (await f.db.getSession(ID))?.title ?? "";
    expect(title.startsWith("Café ")).toBe(true);
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(81);
    expect(title.isWellFormed()).toBe(true);
    const segments = [
      ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
        title.slice(5, -1)
      ),
    ];
    expect(segments.length).toBeGreaterThan(0);
    expect(segments.every((x) => x.segment === cluster)).toBe(true);
  } finally {
    f.close();
  }
});

test("empty first-user text retains the neutral fallback", async () => {
  const f = await fixture("memory", " \n ");
  try {
    await service(
      f.db,
      provider(async () => {
        throw new Error("Must not call provider for empty prompt");
      })
    ).generateSessionTitle(ID);
    expect((await f.db.getSession(ID))?.title).toBe("Untitled");
  } finally {
    f.close();
  }
});

for (const mode of [
  "missing explicit provider",
  "provider factory rejects",
] as const) {
  test(`${mode} uses local label without changing provider selection`, async () => {
    const f = await fixture("memory");
    let calls = 0;
    try {
      const config =
        mode === "missing explicit provider"
          ? {
              ...CONFIG,
              providers: CONFIG.providers.filter(
                (entry) => entry.id !== TARGET.id
              ),
            }
          : CONFIG;
      const title = new SessionTitleService(
        f.db,
        () => config,
        () => {
          calls++;
          throw new Error("Fixture factory unavailable");
        }
      );
      await title.generateSessionTitle(ID);
      expect(calls).toBe(mode === "missing explicit provider" ? 0 : 1);
      expect((await f.db.getSession(ID))?.title).toBe("Plan the launch");
    } finally {
      f.close();
    }
  });
}

test("attachment-only first user text keeps neutral fallback on provider failure", async () => {
  const f = await fixture("memory", [
    { data: "fixture-bytes", mediaType: "image/png", type: "image" },
  ]);
  let calls = 0;
  try {
    await service(
      f.db,
      provider(async () => {
        calls++;
        throw new Error("Fixture unavailable");
      })
    ).generateSessionTitle(ID);
    expect(calls).toBe(1);
    expect((await f.db.getSession(ID))?.title).toBe("Untitled");
  } finally {
    f.close();
  }
});

test("oversized first grapheme has a finite neutral fallback", async () => {
  const f = await fixture("memory", `a${"\u0301".repeat(1000)}`);
  try {
    await service(
      f.db,
      provider(async () => {
        throw new Error("Fixture unavailable");
      })
    ).generateSessionTitle(ID);
    expect((await f.db.getSession(ID))?.title).toBe("Untitled");
  } finally {
    f.close();
  }
});

test("fallback repairs unpaired surrogate input without truncating later text", async () => {
  const f = await fixture("memory", "Review \ud800 budget");
  try {
    await service(
      f.db,
      provider(async () => ({ content: " " }))
    ).generateSessionTitle(ID);
    const title = (await f.db.getSession(ID))?.title;
    expect(title).toBe("Review \ufffd budget");
    expect(title?.isWellFormed()).toBe(true);
  } finally {
    f.close();
  }
});

test("unsafe timer values are rejected before dispatch or database work", () => {
  const db = createInMemoryDatabaseAdapter();
  let calls = 0;
  for (const generationTimeoutMs of [
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    0.5,
    2_147_483_648,
  ]) {
    expect(
      () =>
        new SessionTitleService(
          db,
          () => {
            calls++;
            return null;
          },
          undefined,
          { generationTimeoutMs }
        )
    ).toThrow(RangeError);
  }
  expect(calls).toBe(0);
});
