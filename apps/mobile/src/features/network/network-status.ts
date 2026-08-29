export type NetworkStatus = "checking" | "offline" | "online";

/**
 * A device can reach a self-hosted Atlas server on its local network even when
 * it cannot reach the public internet. `isConnected` is therefore the signal
 * that matters here; `isInternetReachable` would incorrectly mark LAN-only
 * installations as offline.
 */
export function networkStatusFromConnection(
  isConnected: boolean | null | undefined
): NetworkStatus {
  if (isConnected === true) {
    return "online";
  }

  if (isConnected === false) {
    return "offline";
  }

  return "checking";
}

export function isNetworkOnline(
  isConnected: boolean | null | undefined
): boolean {
  return networkStatusFromConnection(isConnected) === "online";
}
