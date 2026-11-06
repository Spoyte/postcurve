// Canary alerts and watchlist from the canary service (canary/tools/canary-service.ts, reached at
// /canary). Shapes follow canary/workflow/types.ts (postcurve.canary.alert/v1); only the fields the
// app shows are typed here, so the app doesn't depend on the canary's zod schemas.

import { useEffect, useState } from "react";

export type Alert = {
  id: string;
  severity: "watch" | "alarm";
  raisedAt: number;
  chain: { id: number; label: string };
  address: string;
  label?: string;
  exposure: { kind: string; evidenceTx?: string | null; source: string };
  dormancy: { seconds: number; days: number; lastOutgoingBlock: number };
  movement: { movedEth: string; movedFraction: number; observedBlock: number; txHash: string | null };
  claim: string;
};

export type WatchEntry = {
  address: string;
  label?: string;
  balanceWeiAtBuild?: string;
  exposure: { kind: string; evidenceTx?: string | null; source: string };
  lastOutgoingBlock?: number;
};

export type Watchlist = { chainId: number; chainLabel: string; source: string; entries: WatchEntry[] };

export function unseenAlerts(alerts: Alert[], seen: string[]): Alert[] {
  const s = new Set(seen);
  return alerts.filter((a) => !s.has(a.id)).sort((a, b) => b.raisedAt - a.raisedAt);
}

export type CanaryFeed = { up: boolean; alerts: Alert[]; watchlist: Watchlist | null };

let shared: { feed: CanaryFeed; listeners: Set<(f: CanaryFeed) => void>; timer?: ReturnType<typeof setInterval> } = {
  feed: { up: false, alerts: [], watchlist: null },
  listeners: new Set(),
};

let chainId = 1337;

async function poll() {
  try {
    const [a, w] = await Promise.all([fetch(`/canary/alerts?chainId=${chainId}`), fetch(`/canary/watchlist?chainId=${chainId}`)]);
    if (!a.ok) throw new Error(`canary answered ${a.status}`);
    const alerts = (await a.json()) as Alert[];
    const watchlist = w.ok ? ((await w.json()) as Watchlist) : null;
    shared.feed = { up: true, alerts: Array.isArray(alerts) ? alerts : [], watchlist };
  } catch {
    shared.feed = { ...shared.feed, up: false };
  }
  for (const l of shared.listeners) l(shared.feed);
}

/** One 5-second poller shared by the alert bar and the Canary screen. */
export function useCanaryFeed(forChain = 1337): CanaryFeed {
  chainId = forChain;
  const [feed, setFeed] = useState(shared.feed);
  useEffect(() => {
    shared.listeners.add(setFeed);
    if (!shared.timer) {
      poll();
      shared.timer = setInterval(poll, 5000);
    }
    return () => {
      shared.listeners.delete(setFeed);
      if (shared.listeners.size === 0 && shared.timer) {
        clearInterval(shared.timer);
        shared.timer = undefined;
      }
    };
  }, []);
  return feed;
}
