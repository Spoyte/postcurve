// One browser key worker per page, opened on first use. Its used-key list is written to storage
// (synchronously) before any signature exists.

import { useApp } from "./appState";
import { BrowserKey } from "./keys";

let opened: Promise<BrowserKey> | null = null;

export function useBrowserKey(): () => Promise<BrowserKey> {
  const { current, update } = useApp();
  return () => {
    const b = current().browser;
    if (!b) return Promise.reject(new Error("no browser key: finish setup first"));
    opened ??= BrowserKey.open(b.seed, b.used, (used) => update((s) => ({ ...s, browser: { ...s.browser!, used } })));
    opened.catch(() => (opened = null));
    return opened;
  };
}
