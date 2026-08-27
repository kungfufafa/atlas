import type {
  SubscriptionAuthState,
  SubscriptionLoginStartResponse,
  SubscriptionLoginStatusResponse,
  SubscriptionProviderKind,
} from "@atlas/core/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { client, formatError } from "@/lib/client";
import { queryKeys } from "@/lib/query-keys";

const LOGIN_POLL_INTERVAL_MS = 2000;

interface ActiveLogin {
  kind: SubscriptionProviderKind;
  loginId: string;
}

interface LoginSession extends ActiveLogin {
  response: SubscriptionLoginStartResponse;
}

interface ActiveAction {
  id: number;
  kind: SubscriptionProviderKind;
}

interface AuthFeedbackTransition {
  authenticated: boolean;
  expectedAuthenticated: boolean | null;
  hasLocalLogin: boolean;
  previousAuthenticated: boolean | null;
}

export interface SubscriptionLoginOutcome {
  error: string | null;
  statusMessage: string | null;
  terminal: boolean;
}

export function resolveSubscriptionProviderKind(
  provider: string
): SubscriptionProviderKind | null {
  return provider === "chatgpt" || provider === "claude" ? provider : null;
}

export function subscriptionAuthCanManage(
  state: SubscriptionAuthState | undefined
): boolean {
  if (!(state && "canManage" in state)) {
    return true;
  }
  return state.canManage !== false;
}

export function subscriptionConnectBlocked({
  authenticated,
  authRefreshing,
  canManage,
  hasLogin,
}: {
  authenticated: boolean;
  authRefreshing: boolean;
  canManage: boolean;
  hasLogin: boolean;
}): boolean {
  return authenticated || authRefreshing || !canManage || hasLogin;
}

export function safeSubscriptionExternalUrl(
  value: string | undefined
): string | null {
  const candidate = value?.trim();
  if (!candidate) {
    return null;
  }
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

export function subscriptionLoginOutcome(
  status: SubscriptionLoginStatusResponse | undefined
): SubscriptionLoginOutcome {
  if (!status || status.status === "pending") {
    return { error: null, statusMessage: null, terminal: false };
  }
  if (status.status === "completed") {
    return {
      error: null,
      statusMessage: "Subscription connected.",
      terminal: true,
    };
  }
  if (status.status === "cancelled") {
    return {
      error: null,
      statusMessage: "Subscription login cancelled.",
      terminal: true,
    };
  }
  return {
    error: status.error?.trim() || "Subscription login failed.",
    statusMessage: null,
    terminal: true,
  };
}

export function shouldClearSubscriptionAuthFeedback({
  authenticated,
  expectedAuthenticated,
  hasLocalLogin,
  previousAuthenticated,
}: AuthFeedbackTransition): boolean {
  if (
    previousAuthenticated === null ||
    previousAuthenticated === authenticated
  ) {
    return false;
  }
  if (authenticated && hasLocalLogin) {
    return false;
  }
  return expectedAuthenticated !== authenticated;
}

export function SubscriptionAuthPanel({
  density = "default",
  disabled,
  onAuthenticatedChange,
  provider,
}: {
  density?: "default" | "compact";
  disabled?: boolean;
  onAuthenticatedChange?: (authenticated: boolean) => void;
  provider: string;
}) {
  const kind = resolveSubscriptionProviderKind(provider);
  const queryClient = useQueryClient();
  const fieldId = useId();
  const [loginSession, setLoginSession] = useState<LoginSession | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshingAuthAfterLogin, setRefreshingAuthAfterLogin] =
    useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const activeActionRef = useRef<ActiveAction | null>(null);
  const activeLoginRef = useRef<ActiveLogin | null>(null);
  const actionIdRef = useRef(0);
  const authRefreshIdRef = useRef(0);
  const currentKindRef = useRef(kind);
  const expectedAuthenticatedRef = useRef<boolean | null>(null);
  const mountedRef = useRef(true);
  const previousAuthenticatedRef = useRef<boolean | null>(null);
  const previousKindRef = useRef(kind);
  currentKindRef.current = kind;
  const login =
    kind && loginSession?.kind === kind ? loginSession.response : null;

  const authQuery = useQuery({
    enabled: kind !== null,
    queryFn: async () => {
      if (!kind) {
        throw new Error("Unknown subscription provider.");
      }
      return client.getSubscriptionAuth(kind);
    },
    queryKey: queryKeys.subscription.auth(kind ?? "none"),
  });
  const { refetch: refetchAuth } = authQuery;

  const loginStatusQuery = useQuery({
    enabled: kind !== null && login !== null,
    queryFn: async () => {
      if (!(kind && login)) {
        throw new Error("Subscription login is not active.");
      }
      return client.getSubscriptionLoginStatus(kind, login.loginId);
    },
    queryKey: queryKeys.subscription.login(
      kind ?? "none",
      login?.loginId ?? "none"
    ),
    refetchInterval: (query) =>
      !query.state.data || query.state.data.status === "pending"
        ? LOGIN_POLL_INTERVAL_MS
        : false,
    retry: 1,
  });

  const state = authQuery.data;
  const authenticated = state?.authenticated === true;
  const canManage = subscriptionAuthCanManage(state);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      authRefreshIdRef.current += 1;
      const active = activeLoginRef.current;
      activeLoginRef.current = null;
      if (active) {
        void client
          .cancelSubscriptionLogin(active.kind, active.loginId)
          .catch(() => undefined);
      }
    };
  }, []);

  useEffect(() => {
    const previousKind = previousKindRef.current;
    previousKindRef.current = kind;
    if (previousKind === kind) {
      return;
    }

    const active = activeLoginRef.current;
    activeLoginRef.current = null;
    activeActionRef.current = null;
    authRefreshIdRef.current += 1;
    expectedAuthenticatedRef.current = null;
    previousAuthenticatedRef.current = null;
    setActionBusy(false);
    setError(null);
    setLoginSession(null);
    setRefreshingAuthAfterLogin(false);
    setStatusMessage(null);
    if (active) {
      void client
        .cancelSubscriptionLogin(active.kind, active.loginId)
        .catch(() => undefined);
    }
  }, [kind]);

  useEffect(() => {
    onAuthenticatedChange?.(authenticated);

    if (!state) {
      return;
    }

    const previousAuthenticated = previousAuthenticatedRef.current;
    previousAuthenticatedRef.current = authenticated;
    const expectedAuthenticated = expectedAuthenticatedRef.current;
    if (
      previousAuthenticated !== null &&
      previousAuthenticated !== authenticated &&
      expectedAuthenticated === authenticated
    ) {
      expectedAuthenticatedRef.current = null;
    }

    if (!(authenticated && login)) {
      if (
        shouldClearSubscriptionAuthFeedback({
          authenticated,
          expectedAuthenticated,
          hasLocalLogin: false,
          previousAuthenticated,
        })
      ) {
        expectedAuthenticatedRef.current = null;
        setError(null);
        setStatusMessage(null);
      }
      return;
    }
    expectedAuthenticatedRef.current = null;
    activeLoginRef.current = null;
    if (activeActionRef.current?.kind === kind) {
      activeActionRef.current = null;
      setActionBusy(false);
    }
    setLoginSession(null);
    setStatusMessage("Subscription connected.");
  }, [authenticated, kind, login, onAuthenticatedChange, state]);

  useEffect(() => {
    if (!(kind && login)) {
      return;
    }
    const status = loginStatusQuery.data;
    if (!status || status.loginId !== login.loginId) {
      return;
    }
    const outcome = subscriptionLoginOutcome(status);
    if (!outcome.terminal) {
      return;
    }

    const active = activeLoginRef.current;
    if (!active || active.kind !== kind || active.loginId !== login.loginId) {
      return;
    }
    activeLoginRef.current = null;
    if (activeActionRef.current?.kind === kind) {
      activeActionRef.current = null;
      setActionBusy(false);
    }
    setLoginSession(null);
    setError(outcome.error);
    setStatusMessage(
      status.status === "completed" && !status.account
        ? null
        : outcome.statusMessage
    );

    if (status.status === "completed") {
      if (status.account) {
        expectedAuthenticatedRef.current = true;
        queryClient.setQueryData(
          queryKeys.subscription.auth(kind),
          status.account
        );
      } else {
        authRefreshIdRef.current += 1;
        const refreshId = authRefreshIdRef.current;
        expectedAuthenticatedRef.current = true;
        setRefreshingAuthAfterLogin(true);
        const confirmAuthentication = async (): Promise<void> => {
          try {
            const result = await refetchAuth();
            if (
              !mountedRef.current ||
              currentKindRef.current !== kind ||
              authRefreshIdRef.current !== refreshId
            ) {
              return;
            }
            if (result.data?.authenticated) {
              setStatusMessage("Subscription connected.");
              return;
            }
            expectedAuthenticatedRef.current = null;
            setStatusMessage(null);
            setError(
              result.error
                ? formatError(result.error)
                : "Subscription login completed, but authentication could not be confirmed."
            );
          } catch (refreshError) {
            if (
              mountedRef.current &&
              currentKindRef.current === kind &&
              authRefreshIdRef.current === refreshId
            ) {
              expectedAuthenticatedRef.current = null;
              setStatusMessage(null);
              setError(formatError(refreshError));
            }
          } finally {
            if (
              mountedRef.current &&
              currentKindRef.current === kind &&
              authRefreshIdRef.current === refreshId
            ) {
              setRefreshingAuthAfterLogin(false);
            }
          }
        };
        void confirmAuthentication();
      }
      void queryClient.invalidateQueries({
        queryKey: queryKeys.subscription.models(kind),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.models });
    }
  }, [kind, login, loginStatusQuery.data, queryClient, refetchAuth]);

  if (!kind) {
    return null;
  }
  const renderedKind: SubscriptionProviderKind = kind;

  function beginAction(actionKind: SubscriptionProviderKind): number | null {
    if (activeActionRef.current?.kind === actionKind) {
      return null;
    }
    actionIdRef.current += 1;
    const id = actionIdRef.current;
    activeActionRef.current = { id, kind: actionKind };
    setActionBusy(true);
    return id;
  }

  function actionIsCurrent(
    actionKind: SubscriptionProviderKind,
    actionId: number
  ): boolean {
    const active = activeActionRef.current;
    return (
      mountedRef.current &&
      currentKindRef.current === actionKind &&
      active?.kind === actionKind &&
      active.id === actionId
    );
  }

  function finishAction(
    actionKind: SubscriptionProviderKind,
    actionId: number
  ): void {
    if (!actionIsCurrent(actionKind, actionId)) {
      return;
    }
    activeActionRef.current = null;
    setActionBusy(false);
  }

  async function connect() {
    if (
      subscriptionConnectBlocked({
        authenticated,
        authRefreshing: authQuery.isFetching || refreshingAuthAfterLogin,
        canManage,
        hasLogin: login !== null,
      })
    ) {
      return;
    }
    const actionKind = renderedKind;
    const actionId = beginAction(actionKind);
    if (actionId === null) {
      return;
    }
    setError(null);
    setStatusMessage(null);
    try {
      const started = await client.startSubscriptionLogin(actionKind);
      if (!actionIsCurrent(actionKind, actionId)) {
        void client
          .cancelSubscriptionLogin(actionKind, started.loginId)
          .catch(() => undefined);
        return;
      }
      activeLoginRef.current = {
        kind: actionKind,
        loginId: started.loginId,
      };
      setLoginSession({
        kind: actionKind,
        loginId: started.loginId,
        response: started,
      });
    } catch (err) {
      if (actionIsCurrent(actionKind, actionId)) {
        setError(formatError(err));
      }
    } finally {
      finishAction(actionKind, actionId);
    }
  }

  async function cancelLogin() {
    if (!(login && canManage)) {
      return;
    }
    const actionKind = renderedKind;
    const actionId = beginAction(actionKind);
    if (actionId === null) {
      return;
    }
    setError(null);
    try {
      await client.cancelSubscriptionLogin(actionKind, login.loginId);
      if (actionIsCurrent(actionKind, actionId)) {
        activeLoginRef.current = null;
        setLoginSession(null);
        setStatusMessage("Subscription login cancelled.");
      }
    } catch (err) {
      if (actionIsCurrent(actionKind, actionId)) {
        setError(formatError(err));
      }
    } finally {
      finishAction(actionKind, actionId);
    }
  }

  async function logout() {
    if (!canManage) {
      return;
    }
    const actionKind = renderedKind;
    const actionId = beginAction(actionKind);
    if (actionId === null) {
      return;
    }
    setError(null);
    setStatusMessage(null);
    try {
      const nextState = await client.logoutSubscription(actionKind);
      if (actionIsCurrent(actionKind, actionId)) {
        expectedAuthenticatedRef.current = false;
        queryClient.setQueryData(
          queryKeys.subscription.auth(actionKind),
          nextState
        );
        queryClient.removeQueries({
          queryKey: queryKeys.subscription.models(actionKind),
        });
        void queryClient.invalidateQueries({ queryKey: queryKeys.models });
        setStatusMessage("Subscription disconnected.");
      }
    } catch (err) {
      if (actionIsCurrent(actionKind, actionId)) {
        setError(formatError(err));
      }
    } finally {
      finishAction(actionKind, actionId);
    }
  }

  const displayedError =
    error ??
    (loginStatusQuery.error
      ? formatError(loginStatusQuery.error)
      : authQuery.error
        ? formatError(authQuery.error)
        : null);

  return (
    <fieldset className={density === "compact" ? "space-y-2" : "space-y-2.5"}>
      <legend className="font-medium text-foreground text-sm">
        Subscription
      </legend>
      <AuthBody
        actionBusy={actionBusy}
        authRefreshing={
          authQuery.isLoading ||
          authQuery.isFetching ||
          refreshingAuthAfterLogin
        }
        canManage={canManage}
        controlId={`${fieldId}-control`}
        disabled={disabled}
        error={displayedError}
        errorId={`${fieldId}-error`}
        login={login}
        onCancel={() => void cancelLogin()}
        onConnect={() => void connect()}
        onLogout={() => void logout()}
        state={state}
        statusId={`${fieldId}-status`}
        statusMessage={statusMessage}
      />
    </fieldset>
  );
}

function AuthBody({
  actionBusy,
  authRefreshing,
  canManage,
  controlId,
  disabled,
  error,
  errorId,
  login,
  onCancel,
  onConnect,
  onLogout,
  state,
  statusId,
  statusMessage,
}: {
  actionBusy: boolean;
  authRefreshing: boolean;
  canManage: boolean;
  controlId: string;
  disabled?: boolean;
  error: string | null;
  errorId: string;
  login: SubscriptionLoginStartResponse | null;
  onCancel: () => void;
  onConnect: () => void;
  onLogout: () => void;
  state: SubscriptionAuthState | undefined;
  statusId: string;
  statusMessage: string | null;
}) {
  const describedBy = [error ? errorId : null, statusMessage ? statusId : null]
    .filter(Boolean)
    .join(" ");
  const authUrl = safeSubscriptionExternalUrl(login?.authUrl);
  const verificationUrl = safeSubscriptionExternalUrl(login?.verificationUrl);
  const hasUnsafeLoginUrl = Boolean(
    (login?.authUrl && !authUrl) || (login?.verificationUrl && !verificationUrl)
  );
  const loginCommand = login?.loginCommand ?? state?.loginCommand;

  let content: ReactNode;
  if ((actionBusy || authRefreshing) && !state) {
    content = <Spinner className="size-4" />;
  } else if (state?.authenticated) {
    content = (
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm">
          {state.email ?? "Connected"}
          {state.plan ? ` · ${state.plan}` : ""}
        </p>
        {canManage ? (
          <Button
            aria-describedby={describedBy || undefined}
            disabled={disabled || actionBusy || authRefreshing}
            id={controlId}
            onClick={onLogout}
            size="sm"
            type="button"
            variant="outline"
          >
            {actionBusy ? "Logging out…" : "Log out"}
          </Button>
        ) : null}
      </div>
    );
  } else {
    content = (
      <div className="space-y-3">
        {state?.message ? (
          <p className="text-muted-foreground text-sm">{state.message}</p>
        ) : null}
        {login?.instructions ? (
          <p className="text-muted-foreground text-sm">{login.instructions}</p>
        ) : null}
        {loginCommand ? (
          <p className="break-all font-mono text-sm">{loginCommand}</p>
        ) : null}
        {authUrl ? (
          <a
            className="inline-block break-all text-sm underline"
            href={authUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            Open subscription login
          </a>
        ) : null}
        {verificationUrl ? (
          <div className="space-y-1 text-sm">
            <a
              className="inline-block break-all underline"
              href={verificationUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              Open verification page
            </a>
            {login?.userCode ? (
              <p>
                Device code: <code>{login.userCode}</code>
              </p>
            ) : null}
          </div>
        ) : null}
        {login ? (
          <p className="text-muted-foreground text-sm" role="status">
            Waiting for sign-in…
          </p>
        ) : null}
        {canManage ? (
          login ? (
            <Button
              aria-describedby={describedBy || undefined}
              disabled={disabled || actionBusy || authRefreshing}
              id={controlId}
              onClick={onCancel}
              size="sm"
              type="button"
              variant="outline"
            >
              {actionBusy ? "Cancelling…" : "Cancel login"}
            </Button>
          ) : (
            <Button
              aria-describedby={describedBy || undefined}
              disabled={disabled || actionBusy || authRefreshing}
              id={controlId}
              onClick={onConnect}
              size="sm"
              type="button"
            >
              {actionBusy ? "Connecting…" : "Connect"}
            </Button>
          )
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {content}
      {hasUnsafeLoginUrl ? (
        <p className="text-destructive text-sm" role="alert">
          Subscription login returned an unsupported URL.
        </p>
      ) : null}
      {error ? (
        <p className="text-destructive text-sm" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
      {statusMessage ? (
        <p
          className="text-muted-foreground text-sm"
          id={statusId}
          role="status"
        >
          {statusMessage}
        </p>
      ) : null}
    </div>
  );
}
