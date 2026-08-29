import NetInfo from "@react-native-community/netinfo";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  type NetworkStatus,
  networkStatusFromConnection,
} from "./network-status";

export interface NetworkContextValue {
  isOffline: boolean;
  isOnline: boolean;
  status: NetworkStatus;
}

const NetworkContext = createContext<NetworkContextValue | null>(null);

export function NetworkProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<NetworkStatus>("checking");

  useEffect(() => {
    let active = true;
    const updateStatus = (isConnected: boolean | null | undefined) => {
      if (active) {
        setStatus(networkStatusFromConnection(isConnected));
      }
    };
    const unsubscribe = NetInfo.addEventListener((state) => {
      updateStatus(state.isConnected);
    });

    void NetInfo.fetch()
      .then((state) => {
        updateStatus(state.isConnected);
      })
      .catch(() => {
        updateStatus(false);
      });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const value = useMemo(
    () => ({
      isOffline: status === "offline",
      isOnline: status === "online",
      status,
    }),
    [status]
  );

  return (
    <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>
  );
}

export function useNetwork(): NetworkContextValue {
  const value = useContext(NetworkContext);
  if (!value) {
    throw new Error("useNetwork must be used within NetworkProvider");
  }
  return value;
}
