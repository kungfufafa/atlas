import { useSyncExternalStore } from "react";

const PAGE_HEADER_ACTIONS_SELECTOR = "[data-page-header-actions]";

function subscribeToPageHeaderActions(onStoreChange: () => void): () => void {
  if (typeof MutationObserver === "undefined") {
    return () => undefined;
  }

  const observer = new MutationObserver(onStoreChange);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
  return () => observer.disconnect();
}

function getPageHeaderActionsSnapshot(): HTMLElement | null {
  return document.querySelector<HTMLElement>(PAGE_HEADER_ACTIONS_SELECTOR);
}

function getPageHeaderActionsServerSnapshot(): HTMLElement | null {
  return null;
}

/**
 * Header actions slot rendered by the app Layout. Resolved from the live DOM
 * so the portal works on first full page load too, not only on client-side
 * re-renders.
 */
export function usePageHeaderActions(): HTMLElement | null {
  return useSyncExternalStore(
    subscribeToPageHeaderActions,
    getPageHeaderActionsSnapshot,
    getPageHeaderActionsServerSnapshot
  );
}
