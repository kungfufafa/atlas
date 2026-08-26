import { describe, expect, test } from "bun:test";
import {
  assertSafeProviderDiscoveryRedirect,
  assertSafeProviderDiscoveryUrl,
  fetchSafeProviderDiscoveryEndpoint,
  isUnsafeProviderDiscoveryAddress,
  type ProviderDiscoveryDnsResolver,
  ProviderDiscoverySafetyError,
  type ProviderDiscoverySafetyErrorCode,
} from "./provider-discovery-safety";

const publicDns: ProviderDiscoveryDnsResolver = async () => [
  { address: "203.0.114.10", family: 4 },
  { address: "2606:4700:4700::1111", family: 6 },
];

function resolverFor(...addresses: string[]): ProviderDiscoveryDnsResolver {
  return async () => addresses.map((address) => ({ address }));
}

async function expectSafetyCode(
  promise: Promise<unknown>,
  code: ProviderDiscoverySafetyErrorCode
): Promise<void> {
  try {
    await promise;
    throw new Error("Expected provider discovery safety validation to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderDiscoverySafetyError);
    expect((error as ProviderDiscoverySafetyError).code).toBe(code);
  }
}

describe("provider discovery URL safety", () => {
  test("allows public HTTPS endpoints after checking every DNS address", async () => {
    const checkedHosts: string[] = [];
    const url = await assertSafeProviderDiscoveryUrl(
      "https://models.example.test/v1",
      {
        resolveDns: async (hostname) => {
          checkedHosts.push(hostname);
          return publicDns(hostname);
        },
      }
    );

    expect(url.toString()).toBe("https://models.example.test/v1");
    expect(checkedHosts).toEqual(["models.example.test"]);
  });

  test.each(["file:///etc/passwd", "ftp://example.com/models", "data:,x"])(
    "rejects non-HTTP(S) URL %s",
    async (url) => {
      await expectSafetyCode(
        assertSafeProviderDiscoveryUrl(url, { resolveDns: publicDns }),
        "unsupported-protocol"
      );
    }
  );

  test.each([
    "https://user@example.com/models",
    "https://user:secret@example.com/models",
  ])("rejects URL credentials in %s", async (url) => {
    await expectSafetyCode(
      assertSafeProviderDiscoveryUrl(url, { resolveDns: publicDns }),
      "credentials-not-allowed"
    );
  });

  test.each([
    "http://localhost:11434/v1",
    "http://api.localhost:11434/v1",
    "http://localhost.localdomain:11434/v1",
    "http://127.0.0.1:11434/v1",
    "http://[::1]:11434/v1",
  ])("denies local endpoint %s by default", async (url) => {
    await expectSafetyCode(
      assertSafeProviderDiscoveryUrl(url, { resolveDns: publicDns }),
      url.includes("localhost") ? "localhost-not-allowed" : "blocked-address"
    );
  });

  test.each([
    "http://localhost:11434/v1",
    "http://127.0.0.1:11434/v1",
    "http://[::1]:11434/v1",
  ])(
    "allows the exact Ollama local origin when explicitly enabled",
    async (url) => {
      const validated = await assertSafeProviderDiscoveryUrl(url, {
        localAccess: { kind: "ollama-local" },
      });
      expect(validated.toString()).toBe(url);
    }
  );

  test.each([
    "http://localhost:11435/v1",
    "https://localhost:11434/v1",
    "http://127.0.0.2:11434/v1",
    "http://192.168.1.8:11434/v1",
  ])("keeps the Ollama local exception narrowly scoped for %s", async (url) => {
    await expect(
      assertSafeProviderDiscoveryUrl(url, {
        localAccess: { kind: "ollama-local" },
      })
    ).rejects.toBeInstanceOf(ProviderDiscoverySafetyError);
  });

  test.each([
    "http://localhost:1234/v1",
    "http://127.0.0.1:8000/v1",
    "http://[::1]:8080/v1",
  ])(
    "allows an explicit OpenAI-compatible loopback endpoint %s",
    async (url) => {
      const validated = await assertSafeProviderDiscoveryUrl(url, {
        localAccess: { kind: "openai-compatible-local" },
      });
      expect(validated.toString()).toBe(url);
    }
  );

  test.each([
    "http://localhost/v1",
    "https://localhost:1234/v1",
    "http://192.168.1.8:1234/v1",
    "http://169.254.169.254:1234/latest/meta-data",
  ])("keeps compatible local access loopback-only for %s", async (url) => {
    await expect(
      assertSafeProviderDiscoveryUrl(url, {
        localAccess: { kind: "openai-compatible-local" },
      })
    ).rejects.toBeInstanceOf(ProviderDiscoverySafetyError);
  });

  test.each([
    "0.0.0.0",
    "10.1.2.3",
    "100.100.100.200",
    "127.0.0.2",
    "169.254.169.254",
    "172.31.255.255",
    "192.168.10.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:10.0.0.1",
    "::ffff:0:127.0.0.1",
    "64:ff9b::a9fe:a9fe",
    "100:0:0:1::1",
    "3fff::1",
    "5f00::1",
    "fc00::1",
    "fd00:ec2::254",
    "fe80::a9fe:a9fe",
    "ff02::1",
  ])("classifies private or reserved address %s as unsafe", (address) => {
    expect(isUnsafeProviderDiscoveryAddress(address)).toBe(true);
  });

  test.each([
    "8.8.8.8",
    "1.1.1.1",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
  ])("classifies public address %s as safe", (address) => {
    expect(isUnsafeProviderDiscoveryAddress(address)).toBe(false);
  });

  test("rejects a hostname if any DNS answer is private", async () => {
    await expectSafetyCode(
      assertSafeProviderDiscoveryUrl("https://mixed.example/models", {
        resolveDns: resolverFor("8.8.8.8", "10.0.0.4"),
      }),
      "blocked-address"
    );
  });

  test("rejects empty, invalid, and failed DNS results", async () => {
    await expectSafetyCode(
      assertSafeProviderDiscoveryUrl("https://empty.example/models", {
        resolveDns: resolverFor(),
      }),
      "dns-no-addresses"
    );
    await expectSafetyCode(
      assertSafeProviderDiscoveryUrl("https://invalid.example/models", {
        resolveDns: resolverFor("not-an-ip"),
      }),
      "invalid-dns-address"
    );
    await expectSafetyCode(
      assertSafeProviderDiscoveryUrl("https://failed.example/models", {
        resolveDns: async () => {
          throw new Error("fixture DNS failure");
        },
      }),
      "dns-resolution-failed"
    );
  });
});

describe("provider discovery redirects", () => {
  test("does not send provider credentials over public HTTP", async () => {
    let fetchCount = 0;
    await expectSafetyCode(
      fetchSafeProviderDiscoveryEndpoint(
        "http://8.8.8.8/models",
        { headers: { Authorization: "Bearer secret" } },
        {
          fetchImpl: async () => {
            fetchCount += 1;
            return new Response(null, { status: 200 });
          },
        }
      ),
      "insecure-credential-transport"
    );
    expect(fetchCount).toBe(0);
  });

  test("validates relative redirects and forces manual redirect mode", async () => {
    const requestedUrls: string[] = [];
    const redirectModes: Array<RequestRedirect | undefined> = [];
    const responses = [
      new Response(null, {
        headers: { Location: "/v1/models" },
        status: 302,
      }),
      new Response('{"data":[]}', { status: 200 }),
    ];

    const response = await fetchSafeProviderDiscoveryEndpoint(
      "https://models.example.test/start",
      { redirect: "follow" },
      {
        fetchImpl: async (input, init) => {
          requestedUrls.push(input.toString());
          redirectModes.push(init?.redirect);
          const next = responses.shift();
          if (!next) {
            throw new Error("Unexpected fetch call");
          }
          return next;
        },
        resolveDns: publicDns,
      }
    );

    expect(response.status).toBe(200);
    expect(requestedUrls).toEqual([
      "https://models.example.test/start",
      "https://models.example.test/v1/models",
    ]);
    expect(redirectModes).toEqual(["manual", "manual"]);
  });

  test("rejects redirects to local, credentialed, or cross-origin targets", async () => {
    await expectSafetyCode(
      assertSafeProviderDiscoveryRedirect(
        "https://models.example.test/start",
        "http://169.254.169.254/latest/meta-data",
        { resolveDns: publicDns }
      ),
      "blocked-address"
    );
    await expectSafetyCode(
      assertSafeProviderDiscoveryRedirect(
        "https://models.example.test/start",
        "https://user:secret@models.example.test/models",
        { resolveDns: publicDns }
      ),
      "credentials-not-allowed"
    );
    await expectSafetyCode(
      assertSafeProviderDiscoveryRedirect(
        "https://models.example.test/start",
        "https://other.example.test/models",
        { resolveDns: publicDns }
      ),
      "unsafe-redirect"
    );
  });

  test("does not fetch an unsafe redirect target", async () => {
    let fetchCount = 0;
    let bodyCancelled = false;
    await expectSafetyCode(
      fetchSafeProviderDiscoveryEndpoint(
        "https://models.example.test/start",
        {},
        {
          fetchImpl: async () => {
            fetchCount += 1;
            return new Response(
              new ReadableStream({
                cancel: () => {
                  bodyCancelled = true;
                },
              }),
              {
                headers: { Location: "http://127.0.0.1:3000/secrets" },
                status: 302,
              }
            );
          },
          resolveDns: publicDns,
        }
      ),
      "blocked-address"
    );
    expect(fetchCount).toBe(1);
    expect(bodyCancelled).toBe(true);
  });

  test("re-resolves the hostname before following each redirect", async () => {
    let lookupCount = 0;
    let fetchCount = 0;
    await expectSafetyCode(
      fetchSafeProviderDiscoveryEndpoint(
        "https://models.example.test/start",
        {},
        {
          fetchImpl: async () => {
            fetchCount += 1;
            return new Response(null, {
              headers: { Location: "/models" },
              status: 307,
            });
          },
          resolveDns: async () => {
            lookupCount += 1;
            return [{ address: lookupCount === 1 ? "8.8.8.8" : "10.0.0.8" }];
          },
        }
      ),
      "blocked-address"
    );
    expect(fetchCount).toBe(1);
    expect(lookupCount).toBe(2);
  });

  test("rejects redirects without a location and over the configured limit", async () => {
    await expectSafetyCode(
      fetchSafeProviderDiscoveryEndpoint(
        "https://models.example.test/start",
        {},
        {
          fetchImpl: async () => new Response(null, { status: 302 }),
          resolveDns: publicDns,
        }
      ),
      "redirect-missing-location"
    );

    let fetchCount = 0;
    await expectSafetyCode(
      fetchSafeProviderDiscoveryEndpoint(
        "https://models.example.test/start",
        {},
        {
          fetchImpl: async () => {
            fetchCount += 1;
            return new Response(null, {
              headers: { Location: `/hop-${fetchCount}` },
              status: 302,
            });
          },
          maxRedirects: 1,
          resolveDns: publicDns,
        }
      ),
      "redirect-limit-exceeded"
    );
    expect(fetchCount).toBe(2);
  });
});
