import { describe, expect, it } from "bun:test";
import { ChannelRateLimiter } from "./channel-rate-limiter";

describe("ChannelRateLimiter", () => {
  it("allows requests up to max limit within window", () => {
    const limiter = new ChannelRateLimiter({
      maxRequests: 3,
      windowMs: 1000,
    });

    expect(limiter.isAllowed("user1")).toBe(true);
    expect(limiter.isAllowed("user1")).toBe(true);
    expect(limiter.isAllowed("user1")).toBe(true);
    expect(limiter.isAllowed("user1")).toBe(false);

    // Another user is independent
    expect(limiter.isAllowed("user2")).toBe(true);
  });

  it("throttles cooldown notices to prevent spam loops", () => {
    const limiter = new ChannelRateLimiter({
      cooldownThrottleMs: 1000,
      maxRequests: 1,
      windowMs: 1000,
    });

    expect(limiter.isAllowed("user1")).toBe(true);
    expect(limiter.isAllowed("user1")).toBe(false);

    // First time notice should be allowed
    expect(limiter.shouldSendCooldownNotice("user1")).toBe(true);
    // Subsequent rapid notices must be blocked
    expect(limiter.shouldSendCooldownNotice("user1")).toBe(false);
    expect(limiter.shouldSendCooldownNotice("user1")).toBe(false);
  });
});
