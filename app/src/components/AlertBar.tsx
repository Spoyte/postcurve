// Drops in across the top of every screen when the canary raises an alert this browser hasn't seen.

import { useApp } from "../lib/appState";
import { unseenAlerts, useCanaryFeed } from "../lib/alerts";
import { short } from "../lib/format";

export function AlertBar() {
  const { cfg, store, update } = useApp();
  const feed = useCanaryFeed(cfg.chainId);
  const fresh = unseenAlerts(feed.alerts, store.seenAlerts);
  const a = fresh[0];
  if (!a) return null;
  const dismiss = () => update((s) => ({ ...s, seenAlerts: [...s.seenAlerts, ...fresh.map((x) => x.id)] }));
  return (
    <div className="banner alarm">
      <span>
        ⚠ <b>Canary</b> · dormant exposed address <span className="mono">{short(a.address)}</span> just moved{" "}
        <b>{Number(a.movement.movedEth).toLocaleString("en-US", { maximumFractionDigits: 4 })} ETH</b> · block {a.movement.observedBlock}
        {fresh.length > 1 ? ` · +${fresh.length - 1} more` : ""}
      </span>
      <span className="row">
        <a className="btn danger" href="#/canary" onClick={dismiss}>
          See the alert
        </a>
        <button className="linkish" onClick={dismiss}>
          Dismiss
        </button>
      </span>
    </div>
  );
}

export function useUnreadAlerts(): number {
  const { cfg, store } = useApp();
  const feed = useCanaryFeed(cfg.chainId);
  return unseenAlerts(feed.alerts, store.seenAlerts).length;
}
