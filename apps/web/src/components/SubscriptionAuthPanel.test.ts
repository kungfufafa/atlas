import { describe, expect, test } from "bun:test";
import type {
  SubscriptionAuthState,
  SubscriptionLoginStatusResponse,
} from "@atlas/core/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { queryKeys } from "@/lib/query-keys";
import {
  resolveSubscriptionProviderKind,
  SubscriptionAuthPanel,
  safeSubscriptionExternalUrl,
  shouldClearSubscriptionAuthFeedback,
  subscriptionAuthCanManage,
  subscriptionConnectBlocked,
  subscriptionLoginOutcome,
} from "./SubscriptionAuthPanel";

const unauthenticatedState = (
  provider: "chatgpt" | "claude",
  canManage?: boolean
): SubscriptionAuthState => ({
  authenticated: false,
  ...(canManage === undefined ? {} : { canManage }),
  provider,
  status: "not_authenticated",
});

describe("subscription authentication helpers", () => {
  test("recognizes only subscription provider kinds", () => {
    expect(resolveSubscriptionProviderKind("chatgpt")).toBe("chatgpt");
    expect(resolveSubscriptionProviderKind("claude")).toBe("claude");
    expect(resolveSubscriptionProviderKind("openai")).toBeNull();
  });

  test("allows only HTTP(S) login destinations", () => {
    expect(
      safeSubscriptionExternalUrl("https://example.com/authorize?flow=1")
    ).toBe("https://example.com/authorize?flow=1");
    expect(safeSubscriptionExternalUrl("http://localhost:4310/login")).toBe(
      "http://localhost:4310/login"
    );
    expect(safeSubscriptionExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeSubscriptionExternalUrl("data:text/html,login")).toBeNull();
    expect(safeSubscriptionExternalUrl("not a URL")).toBeNull();
  });

  test("defaults management permission to allowed and honors explicit denial", () => {
    expect(subscriptionAuthCanManage(undefined)).toBe(true);
    expect(subscriptionAuthCanManage(unauthenticatedState("chatgpt"))).toBe(
      true
    );
    expect(
      subscriptionAuthCanManage(unauthenticatedState("chatgpt", false))
    ).toBe(false);
  });

  test("blocks duplicate login while authentication is refreshing", () => {
    expect(
      subscriptionConnectBlocked({
        authenticated: false,
        authRefreshing: true,
        canManage: true,
        hasLogin: false,
      })
    ).toBe(true);
    expect(
      subscriptionConnectBlocked({
        authenticated: false,
        authRefreshing: false,
        canManage: true,
        hasLogin: false,
      })
    ).toBe(false);
    expect(
      subscriptionConnectBlocked({
        authenticated: true,
        authRefreshing: false,
        canManage: true,
        hasLogin: false,
      })
    ).toBe(true);
    expect(
      subscriptionConnectBlocked({
        authenticated: false,
        authRefreshing: false,
        canManage: false,
        hasLogin: false,
      })
    ).toBe(true);
    expect(
      subscriptionConnectBlocked({
        authenticated: false,
        authRefreshing: false,
        canManage: true,
        hasLogin: true,
      })
    ).toBe(true);
  });

  test("distinguishes pending and every terminal login result", () => {
    const status = (
      value: SubscriptionLoginStatusResponse["status"]
    ): SubscriptionLoginStatusResponse => ({
      loginId: "login-1",
      status: value,
    });

    expect(subscriptionLoginOutcome(status("pending")).terminal).toBe(false);
    expect(subscriptionLoginOutcome(status("completed"))).toMatchObject({
      error: null,
      terminal: true,
    });
    expect(subscriptionLoginOutcome(status("cancelled"))).toMatchObject({
      error: null,
      terminal: true,
    });
    expect(
      subscriptionLoginOutcome({
        error: "runtime stopped",
        loginId: "login-1",
        status: "failed",
      })
    ).toMatchObject({ error: "runtime stopped", terminal: true });
  });

  test("clears stale feedback only for external auth transitions", () => {
    expect(
      shouldClearSubscriptionAuthFeedback({
        authenticated: true,
        expectedAuthenticated: null,
        hasLocalLogin: false,
        previousAuthenticated: false,
      })
    ).toBe(true);
    expect(
      shouldClearSubscriptionAuthFeedback({
        authenticated: false,
        expectedAuthenticated: null,
        hasLocalLogin: false,
        previousAuthenticated: true,
      })
    ).toBe(true);
    expect(
      shouldClearSubscriptionAuthFeedback({
        authenticated: true,
        expectedAuthenticated: true,
        hasLocalLogin: false,
        previousAuthenticated: false,
      })
    ).toBe(false);
    expect(
      shouldClearSubscriptionAuthFeedback({
        authenticated: true,
        expectedAuthenticated: null,
        hasLocalLogin: true,
        previousAuthenticated: false,
      })
    ).toBe(false);
  });
});

describe("subscription authentication controls", () => {
  test("uses unique control ids for multiple provider panels", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      queryKeys.subscription.auth("chatgpt"),
      unauthenticatedState("chatgpt")
    );
    queryClient.setQueryData(
      queryKeys.subscription.auth("claude"),
      unauthenticatedState("claude")
    );

    const markup = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          "div",
          null,
          createElement(SubscriptionAuthPanel, { provider: "chatgpt" }),
          createElement(SubscriptionAuthPanel, { provider: "claude" })
        )
      )
    );
    const controlIds = [...markup.matchAll(/id="([^"]+-control)"/g)].map(
      (match) => match[1]
    );

    expect(controlIds).toHaveLength(2);
    expect(new Set(controlIds).size).toBe(2);
    expect(markup).toContain(">Connect<");
    expect(markup).not.toContain("Connecting…");
  });

  test("keeps passive authenticated refreshes distinct from logout", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.subscription.auth("chatgpt"), {
      authenticated: true,
      provider: "chatgpt",
      status: "authenticated",
    } satisfies SubscriptionAuthState);

    const markup = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(SubscriptionAuthPanel, { provider: "chatgpt" })
      )
    );

    expect(markup).toContain(">Log out<");
    expect(markup).not.toContain("Logging out…");
  });

  test("does not render management controls when permission is denied", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      queryKeys.subscription.auth("chatgpt"),
      unauthenticatedState("chatgpt", false)
    );

    const markup = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(SubscriptionAuthPanel, { provider: "chatgpt" })
      )
    );

    expect(markup).not.toContain("<button");
  });
});
