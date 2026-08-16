import { useEffect, useState } from "react";

/**
 * Header actions slot rendered by the app Layout. Resolved after mount so the
 * portal works on first full page load too, not only on client-side
 * re-renders.
 */
export function usePageHeaderActions(): HTMLElement | null {
  const [element, setElement] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setElement(
      document.querySelector<HTMLElement>("[data-page-header-actions]")
    );
  }, []);

  return element;
}
