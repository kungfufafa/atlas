import { expect, test } from "bun:test";
import { isNetworkOnline, networkStatusFromConnection } from "./network-status";

test("keeps a LAN-only device online when it has a network connection", () => {
  expect(networkStatusFromConnection(true)).toBe("online");
  expect(isNetworkOnline(true)).toBe(true);
});

test("reports disconnected and unknown network states separately", () => {
  expect(networkStatusFromConnection(false)).toBe("offline");
  expect(networkStatusFromConnection(null)).toBe("checking");
  expect(networkStatusFromConnection(undefined)).toBe("checking");
  expect(isNetworkOnline(false)).toBe(false);
});
