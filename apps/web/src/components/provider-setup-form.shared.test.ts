import { describe, expect, test } from "bun:test";
import {
  isCurrentProviderOperation,
  isProviderSelectionDisabled,
} from "./provider-setup-form.shared";

describe("provider setup async isolation", () => {
  test("locks all provider controls while a connection test is pending", () => {
    expect(
      isProviderSelectionDisabled({ saving: false, testingConnection: true })
    ).toBe(true);
    expect(
      isProviderSelectionDisabled({ saving: false, testingConnection: false })
    ).toBe(false);
  });

  test("rejects completion from a superseded provider generation", () => {
    expect(isCurrentProviderOperation(3, 3)).toBe(true);
    expect(isCurrentProviderOperation(3, 4)).toBe(false);
  });
});
