import type { AtlasClient } from "@atlas/client";
import { formatError } from "@atlas/client";
import type {
  AuthUserResponse,
  SetupAuthRequest,
  UserOrgSummary,
} from "@atlas/core/contract";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNetwork } from "@/features/network/network-context";
import { useServer } from "@/features/server/server-context";
import {
  clearCachedAuthSession,
  loadCachedAuthSession,
  saveCachedAuthSession,
} from "@/lib/auth-cache";
import { createAtlasClient } from "@/lib/client";
import { clearOfflineQueryCache } from "@/lib/query-cache";
import { queryClient } from "@/lib/query-client";
import {
  clearSessionToken,
  loadSessionToken,
  saveSessionToken,
} from "@/lib/secure-store";
import { isInvalidSessionError } from "@/lib/session-auth";

export interface AuthContextValue {
  acceptInvite: (token: string, password?: string) => Promise<void>;
  activeOrg: UserOrgSummary | null;
  applyUser: (nextUser: AuthUserResponse) => void;
  client: AtlasClient | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  orgs: UserOrgSummary[];
  setup: (request: SetupAuthRequest) => Promise<void>;
  switchOrg: (orgId: string) => Promise<void>;
  user: AuthUserResponse | null;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { activeServer, isCurrentServer } = useServer();
  const { isOffline } = useNetwork();
  const [client, setClient] = useState<AtlasClient | null>(null);
  const [user, setUser] = useState<AuthUserResponse | null>(null);
  const [orgs, setOrgs] = useState<UserOrgSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const activeClient = client?.baseUrl === activeServer?.url ? client : null;
  const activeServerId = activeServer?.id ?? null;
  const isOfflineRef = useRef(isOffline);

  useEffect(() => {
    isOfflineRef.current = isOffline;
  }, [isOffline]);

  useEffect(() => {
    let cancelled = false;

    async function hydrate(): Promise<void> {
      if (!activeServer) {
        setClient(null);
        setUser(null);
        setOrgs([]);
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      const nextClient = createAtlasClient({ baseUrl: activeServer.url });
      let token: string | null;
      try {
        token = await loadSessionToken(activeServer.id);
      } catch {
        if (!cancelled) {
          setClient(nextClient);
          setUser(null);
          setOrgs([]);
          setIsLoading(false);
        }
        return;
      }
      if (token) {
        nextClient.setAuthToken(token);
      }

      if (cancelled) {
        return;
      }
      setClient(nextClient);

      if (!token) {
        setUser(null);
        setOrgs([]);
        setIsLoading(false);
        return;
      }

      const cachedSession = await loadCachedAuthSession(activeServer.id).catch(
        () => null
      );
      if (cancelled) {
        return;
      }
      if (isOfflineRef.current) {
        setUser(cachedSession?.user ?? null);
        setOrgs(cachedSession?.orgs ?? []);
        setIsLoading(false);
        return;
      }

      try {
        const [nextUser, orgList] = await Promise.all([
          nextClient.getMe(),
          nextClient.listUserOrgs(),
        ]);
        if (cancelled) {
          return;
        }
        setUser(nextUser);
        setOrgs(orgList.orgs);
        void saveCachedAuthSession(activeServer.id, {
          orgs: orgList.orgs,
          user: nextUser,
        });
      } catch (error) {
        if (cancelled) {
          return;
        }

        const invalidSession = isInvalidSessionError(error);
        if (invalidSession) {
          try {
            await clearSessionToken(activeServer.id);
          } catch {
            // Keep the app signed out even if the device could not update storage.
          }
          nextClient.setAuthToken(null);
          void clearCachedAuthSession(activeServer.id);
        }
        if (cancelled) {
          return;
        }
        setUser(invalidSession ? null : (cachedSession?.user ?? null));
        setOrgs(invalidSession ? [] : (cachedSession?.orgs ?? []));
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void hydrate();
    return () => {
      cancelled = true;
    };
  }, [activeServer]);

  const applyUser = useCallback(
    (nextUser: AuthUserResponse) => {
      if (!isCurrentServer(activeServerId)) {
        return;
      }
      setUser({ ...nextUser, sessionToken: undefined });
    },
    [activeServerId, isCurrentServer]
  );

  const persistSession = useCallback(
    async (nextUser: AuthUserResponse) => {
      if (!(activeClient && activeServer)) {
        throw new Error("Connect a server first.");
      }
      if (!nextUser.sessionToken) {
        throw new Error("This Atlas server did not return a session token.");
      }
      const sourceServerId = activeServer.id;
      await saveSessionToken(sourceServerId, nextUser.sessionToken);
      const orgList = await activeClient.listUserOrgs();
      if (!isCurrentServer(sourceServerId)) {
        throw new Error("The active server changed. Please try again.");
      }
      applyUser(nextUser);
      setOrgs(orgList.orgs);
      void saveCachedAuthSession(activeServer.id, {
        orgs: orgList.orgs,
        user: nextUser,
      });
      queryClient.clear();
    },
    [activeClient, activeServer, applyUser, isCurrentServer]
  );

  const login = useCallback(
    async (email: string, password: string) => {
      if (!activeClient) {
        throw new Error("Connect a server first.");
      }

      await persistSession(await activeClient.login(email, password));
    },
    [activeClient, persistSession]
  );

  const setup = useCallback(
    async (request: SetupAuthRequest) => {
      if (!activeClient) {
        throw new Error("Connect a server first.");
      }

      await persistSession(await activeClient.setupUser(request));
    },
    [activeClient, persistSession]
  );

  const acceptInvite = useCallback(
    async (token: string, password?: string) => {
      if (!(activeClient && activeServer)) {
        throw new Error("Connect a server first.");
      }

      const sourceServerId = activeServer.id;
      const accepted = await activeClient.acceptOrgInvite({
        password,
        token,
      });
      if (accepted.sessionToken) {
        await saveSessionToken(sourceServerId, accepted.sessionToken);
      }
      const [nextUser, orgList] = await Promise.all([
        activeClient.getMe(),
        activeClient.listUserOrgs(),
      ]);
      if (!isCurrentServer(sourceServerId)) {
        throw new Error("The active server changed. Please try again.");
      }
      applyUser(nextUser);
      setOrgs(orgList.orgs);
      void saveCachedAuthSession(sourceServerId, {
        orgs: orgList.orgs,
        user: nextUser,
      });
      queryClient.clear();
    },
    [activeClient, activeServer, applyUser, isCurrentServer]
  );

  const logout = useCallback(async () => {
    const sourceServerId = activeServer?.id ?? null;
    let storageError: unknown;

    if (activeClient) {
      try {
        await activeClient.logout();
      } catch {
        // Still drop the local session if the server is unreachable.
      }
    }
    if (sourceServerId) {
      try {
        await clearSessionToken(sourceServerId);
      } catch (caught) {
        storageError = caught;
      }
    }
    activeClient?.setAuthToken(null);
    activeClient?.setOrgId(null);

    if (!isCurrentServer(sourceServerId)) {
      if (storageError) {
        throw storageError;
      }
      return;
    }
    setUser(null);
    setOrgs([]);
    queryClient.clear();
    void clearOfflineQueryCache().catch(() => {
      // Local storage failures must not prevent a local sign-out.
    });
    if (sourceServerId) {
      void clearCachedAuthSession(sourceServerId);
    }
    if (storageError) {
      throw new Error(
        "Signed out locally, but the saved session could not be removed."
      );
    }
  }, [activeClient, activeServer?.id, isCurrentServer]);

  const switchOrg = useCallback(
    async (orgId: string) => {
      if (!(activeClient && activeServer)) {
        throw new Error("Not connected.");
      }
      const sourceServerId = activeServer.id;
      const nextUser = await activeClient.setActiveOrg(orgId);
      if (!isCurrentServer(sourceServerId)) {
        throw new Error("The active server changed. Please try again.");
      }
      applyUser(nextUser);
      void saveCachedAuthSession(sourceServerId, {
        orgs,
        user: nextUser,
      });
      await queryClient.resetQueries();
    },
    [activeClient, activeServer, applyUser, isCurrentServer, orgs]
  );

  const visibleUser = activeClient ? user : null;
  const visibleOrgs = activeClient ? orgs : [];
  const activeOrg = useMemo(() => {
    const activeOrgId = visibleUser?.activeOrgId ?? visibleUser?.orgId ?? null;
    if (!activeOrgId) {
      return null;
    }
    return visibleOrgs.find((org) => org.id === activeOrgId) ?? null;
  }, [visibleOrgs, visibleUser]);

  const isLoadingActiveServer =
    isLoading || (activeServer !== null && activeClient === null);

  const value = useMemo(
    () => ({
      acceptInvite,
      activeOrg,
      applyUser,
      client: activeClient,
      isAuthenticated: visibleUser !== null,
      isLoading: isLoadingActiveServer,
      login,
      logout,
      orgs: visibleOrgs,
      setup,
      switchOrg,
      user: visibleUser,
    }),
    [
      acceptInvite,
      activeOrg,
      applyUser,
      activeClient,
      isLoadingActiveServer,
      login,
      logout,
      visibleOrgs,
      setup,
      switchOrg,
      visibleUser,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return value;
}

export function formatAuthError(error: unknown): string {
  return formatError(error);
}
