// The app's one piece of shared state: the configuration and the stored data. `update` writes
// through to localStorage synchronously before React re-renders, so a later step of an async flow
// (a spend) always reads what an earlier step recorded.

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { deploymentId, type AppConfig } from "./config";
import { readStore, writeStore, type Stored } from "./store";

export type AppState = {
  cfg: AppConfig;
  store: Stored;
  /** The latest stored data, for async flows that outlive a render. */
  current: () => Stored;
  update: (fn: (s: Stored) => Stored) => Stored;
  redeployed: boolean;
  dismissRedeployed: () => void;
};

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ cfg, children }: { cfg: AppConfig; children: ReactNode }) {
  const [initial] = useState(() => readStore(deploymentId(cfg)));
  const ref = useRef<Stored>(initial);
  const [store, setStore] = useState<Stored>(initial);
  const [redeployed, setRedeployed] = useState(initial.redeployed === true);
  const update = useCallback((fn: (s: Stored) => Stored) => {
    const next = fn(ref.current);
    writeStore(next);
    ref.current = next;
    setStore(next);
    return next;
  }, []);
  const current = useCallback(() => ref.current, []);
  return (
    <Ctx.Provider value={{ cfg, store, current, update, redeployed, dismissRedeployed: () => setRedeployed(false) }}>
      {children}
    </Ctx.Provider>
  );
}

export function useApp(): AppState {
  const s = useContext(Ctx);
  if (!s) throw new Error("useApp outside AppProvider");
  return s;
}
