import { describe, expect, mock, test } from "bun:test";
import { createBaileysLogger } from "./baileys-logger";

describe("Baileys logger", () => {
  test("suppresses nonfatal init query timeouts", () => {
    const writeError = mock(() => {});
    const logger = createBaileysLogger(writeError);

    logger.error(
      {
        err: {
          isBoom: true,
          message: "Timed Out",
        },
      },
      "unexpected error in 'init queries'"
    );

    expect(writeError).not.toHaveBeenCalled();
  });

  test("reports other Baileys errors", () => {
    const writeError = mock(() => {});
    const logger = createBaileysLogger(writeError);
    const context = { err: new Error("Connection Closed") };

    logger.error(context, "error in validating connection");

    expect(writeError).toHaveBeenCalledWith("WhatsApp protocol error.", {
      errorType: "Error",
    });
  });

  test("never forwards message content, identities, or raw error messages", () => {
    const writeError = mock(() => {});
    const logger = createBaileysLogger(writeError);

    logger.error(
      {
        authState: "secret-auth-state",
        err: Object.assign(new Error("private failure details"), {
          output: { statusCode: 408 },
        }),
        jid: "628123456789@s.whatsapp.net",
      },
      "failed while handling confidential report"
    );

    expect(writeError).toHaveBeenCalledWith("WhatsApp protocol error.", {
      errorType: "Error",
      statusCode: 408,
    });
    const logged = JSON.stringify(writeError.mock.calls);
    expect(logged).not.toContain("secret-auth-state");
    expect(logged).not.toContain("private failure details");
    expect(logged).not.toContain("628123456789");
    expect(logged).not.toContain("confidential report");
  });

  test("hostile error objects cannot break logging", () => {
    const writeError = mock(() => {});
    const logger = createBaileysLogger(writeError);
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("getter secret");
        },
        has() {
          throw new Error("has secret");
        },
      }
    );

    expect(() =>
      logger.error(hostile, "unexpected error in 'init queries'")
    ).not.toThrow();
    expect(writeError).toHaveBeenCalledWith("WhatsApp protocol error.", {
      errorType: "UnknownError",
    });
  });

  test("sanitizes warnings without suppressing them", () => {
    const writeError = mock(() => {});
    const writeWarning = mock(() => {});
    const logger = createBaileysLogger(writeError, writeWarning);

    logger.warn(
      { err: new TypeError("secret"), jid: "628123456789@s.whatsapp.net" },
      "private warning"
    );

    expect(writeWarning).toHaveBeenCalledWith("WhatsApp protocol warning.", {
      errorType: "TypeError",
    });
    expect(JSON.stringify(writeWarning.mock.calls)).not.toContain(
      "628123456789"
    );
  });
});
