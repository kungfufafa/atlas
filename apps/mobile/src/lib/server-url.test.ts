import { expect, test } from "bun:test";
import {
  assertPersistableServerUrl,
  coerceServerUrl,
  displayNameFromUrl,
  evaluateServerConnection,
  isInsecureServerUrl,
  isPrivateOrLocalHostname,
  isValidServerUrl,
  normalizeServerUrl,
  serverIdFromUrl,
} from "./server-url";

test("strips trailing slashes from a server URL", () => {
  expect(normalizeServerUrl(" http://127.0.0.1:4310/ ")).toBe(
    "http://127.0.0.1:4310"
  );
});

test("accepts http and https Atlas URLs", () => {
  expect(isValidServerUrl("http://10.0.2.2:4310")).toBe(true);
  expect(isValidServerUrl("https://atlas.example.com")).toBe(true);
  expect(isValidServerUrl("http://atlas.example.com")).toBe(false);
  expect(isValidServerUrl("ftp://atlas.example.com")).toBe(false);
  expect(isValidServerUrl("")).toBe(false);
});

test("fills https for public hosts and http for private hosts", () => {
  expect(coerceServerUrl("atlas.example.com")).toBe(
    "https://atlas.example.com"
  );
  expect(coerceServerUrl("atlas.example.com:443")).toBe(
    "https://atlas.example.com"
  );
  expect(coerceServerUrl("10.0.0.12:4310")).toBe("http://10.0.0.12:4310");
  expect(coerceServerUrl("127.0.0.1:4310")).toBe("http://127.0.0.1:4310");
  expect(coerceServerUrl("localhost:4310")).toBe("http://localhost:4310");
});

test("only permits explicit HTTP for local and private servers", () => {
  expect(coerceServerUrl("http://atlas.example.com")).toBe("");
  expect(coerceServerUrl("http://fe80.evil.example")).toBe("");
  expect(coerceServerUrl("http://fd12.evil.example")).toBe("");
  expect(isInsecureServerUrl("http://atlas.example.com")).toBe(false);
  expect(isInsecureServerUrl("http://192.168.1.8:4310")).toBe(true);
  expect(coerceServerUrl("https://192.168.1.8:4310")).toBe(
    "https://192.168.1.8:4310"
  );
});

test("rejects URLs that include credentials, queries, or fragments", () => {
  expect(coerceServerUrl("https://user:pass@atlas.example.com")).toBe("");
  expect(coerceServerUrl("https://atlas.example.com?token=value")).toBe("");
  expect(coerceServerUrl("https://atlas.example.com#login")).toBe("");
});

test("drops login and API suffixes but keeps a real base path", () => {
  expect(coerceServerUrl("https://atlas.example.com/login")).toBe(
    "https://atlas.example.com"
  );
  expect(coerceServerUrl("https://atlas.example.com/v1")).toBe(
    "https://atlas.example.com"
  );
  expect(coerceServerUrl("https://company.com/atlas")).toBe(
    "https://company.com/atlas"
  );
});

test("builds a key-safe, collision-resistant server ID from the full URL", () => {
  const serverId = serverIdFromUrl("https://Atlas.Example.com:4310/");

  expect(serverId).toBe(serverIdFromUrl("https://atlas.example.com:4310"));
  expect(serverId).toStartWith("atlas-server-v2-");
  expect(serverId).toMatch(/^[a-zA-Z0-9._-]+$/);
  expect(serverIdFromUrl("https://company.com/a-b")).not.toBe(
    serverIdFromUrl("https://company.com/a/b")
  );
  expect(serverIdFromUrl("https://company.com/a//b")).not.toBe(
    serverIdFromUrl("https://company.com/a/b")
  );
  expect(serverIdFromUrl("http://127.0.0.1:4310")).not.toBe(
    serverIdFromUrl("https://127.0.0.1:4310")
  );
});

test("uses the host as the default display name", () => {
  expect(displayNameFromUrl("http://127.0.0.1:4310")).toBe("127.0.0.1:4310");
});

test("detects loopback and private hostnames", () => {
  expect(isPrivateOrLocalHostname("localhost")).toBe(true);
  expect(isPrivateOrLocalHostname("localhost.")).toBe(true);
  expect(isPrivateOrLocalHostname("atlas.local.")).toBe(true);
  expect(isPrivateOrLocalHostname("172.16.0.4")).toBe(true);
  expect(isPrivateOrLocalHostname("169.254.10.4")).toBe(true);
  expect(isPrivateOrLocalHostname("fd12::1")).toBe(true);
  expect(isPrivateOrLocalHostname("fe80::1")).toBe(true);
  expect(isPrivateOrLocalHostname("[::1]")).toBe(true);
  expect(isPrivateOrLocalHostname("atlas.example.com")).toBe(false);
  expect(isPrivateOrLocalHostname("172.15.0.4")).toBe(false);
  expect(isPrivateOrLocalHostname("172.32.0.4")).toBe(false);
});

test("canonicalizes trailing dots and IPv6 brackets in saved URLs", () => {
  expect(normalizeServerUrl("http://localhost.:4310")).toBe(
    "http://localhost:4310"
  );
  expect(normalizeServerUrl("https://atlas.example.com.")).toBe(
    "https://atlas.example.com"
  );
  expect(normalizeServerUrl("http://[::1]:4310")).toBe("http://[::1]:4310");
});

test("requires confirmation before persisting a local HTTP server", () => {
  expect(evaluateServerConnection("http://127.0.0.1:4310")).toEqual({
    status: "needs-insecure-confirmation",
    url: "http://127.0.0.1:4310",
  });
  expect(
    evaluateServerConnection("http://127.0.0.1:4310", {
      insecureConfirmed: true,
    })
  ).toEqual({
    status: "ready",
    url: "http://127.0.0.1:4310",
  });
  expect(evaluateServerConnection("https://atlas.example.com")).toEqual({
    status: "ready",
    url: "https://atlas.example.com",
  });
  expect(evaluateServerConnection("http://atlas.example.com")).toEqual({
    status: "invalid",
    url: "",
  });

  expect(() => assertPersistableServerUrl("http://192.168.1.8:4310")).toThrow();
  expect(
    assertPersistableServerUrl("http://192.168.1.8:4310", {
      allowInsecure: true,
    })
  ).toBe("http://192.168.1.8:4310");
  expect(assertPersistableServerUrl("https://atlas.example.com")).toBe(
    "https://atlas.example.com"
  );
});
