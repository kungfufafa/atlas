import { describe, expect, test } from "bun:test";
import {
  isExplicitWhatsAppShareIntent,
  isPureWhatsAppAttachIntent,
} from "./channel-artifact-flow";

describe("WhatsApp artifact intent", () => {
  test("short-circuits only pure attachment requests", () => {
    expect(isPureWhatsAppAttachIntent("/attach")).toBe(true);
    expect(isPureWhatsAppAttachIntent("send me the file")).toBe(true);
    expect(isPureWhatsAppAttachIntent("edit the file and send it")).toBe(false);
    expect(isPureWhatsAppAttachIntent("/attach after editing the report")).toBe(
      false
    );
  });

  test("recognizes explicit public share-link requests", () => {
    expect(isExplicitWhatsAppShareIntent("send me a public link")).toBe(true);
    expect(isExplicitWhatsAppShareIntent("send me the file")).toBe(false);
  });
});
