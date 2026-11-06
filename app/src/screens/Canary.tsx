// The canary: large, long-dormant addresses whose public key is exposed. If one suddenly moves, someone
// may be breaking keys. The watching is a Chainlink CRE workflow (canary/); this screen reads its feed.

import { PageHead } from "../components/Panel";
import { useCanaryFeed } from "../lib/alerts";
import { useApp } from "../lib/appState";
import { eth, short } from "../lib/format";

const KIND: Record<string, string> = {
  "transaction-sender": "sent a transaction (public key on chain)",
};

export function Canary() {
  const { cfg } = useApp();
  const feed = useCanaryFeed(cfg.chainId);
  const alerts = [...feed.alerts].sort((a, b) => b.raisedAt - a.raisedAt);
  return (
    <>
      <PageHead title="The canary">
        Big, long-dormant addresses whose public key is already on chain are the first thing a key-breaker would take. A Chainlink CRE
        workflow watches them; a sudden sweep is an early sign that ECDSA is falling, whether to a quantum computer or to new math.
      </PageHead>

      {!feed.up && (
        <div className="panel warn">
          <h3>Canary service not running</h3>
          <p>Start it beside the devnet (see canary/README.md):</p>
          <div className="box">
            cd canary && bun run tools/canary-service.ts --port 8787 --rpc http://127.0.0.1:18545 --watchlist watchlist/watchlist.devnet.json --data .state/demo
          </div>
        </div>
      )}

      {alerts.length > 0 && (
        <div className="alerts">
          {alerts.map((a) => (
            <div key={a.id} className="panel alarm alert-card">
              <div className="row between">
                <span className="tag" style={{ borderColor: "var(--red-line)", color: "var(--red)" }}>
                  {a.severity}
                </span>
                <span className="mono">block {a.movement.observedBlock}</span>
              </div>
              <h2>
                {short(a.address, 8, 6)} moved {Number(a.movement.movedEth).toLocaleString("en-US", { maximumFractionDigits: 4 })} ETH (
                {Math.round(a.movement.movedFraction * 100)}% of it)
              </h2>
              <div className="seen">
                <div>
                  <span className="k">Exposed since</span>
                  <span>{KIND[a.exposure.kind] ?? a.exposure.kind}</span>
                </div>
                <div>
                  <span className="k">Dormant for</span>
                  <span>
                    {a.dormancy.days >= 1 ? `${a.dormancy.days.toFixed(1)} days` : `${a.dormancy.seconds} s`} · last move in block {a.dormancy.lastOutgoingBlock}
                  </span>
                </div>
                <div>
                  <span className="k">Sweep</span>
                  <span className="mono">{a.movement.txHash ? short(a.movement.txHash, 10, 8) : "transaction not located"}</span>
                </div>
                <div>
                  <span className="k">Chain</span>
                  <span>{a.chain.label}</span>
                </div>
              </div>
              <p className="muted">{a.claim}</p>
            </div>
          ))}
        </div>
      )}

      <div className="panel">
        <div className="row between">
          <h3>Watchlist</h3>
          <span className="muted">
            {feed.watchlist ? `${feed.watchlist.entries.length} addresses · ${feed.watchlist.chainLabel}` : feed.up ? "no watchlist loaded" : "—"}
          </span>
        </div>
        {feed.watchlist && (
          <table className="table">
            <thead>
              <tr>
                <th>Address</th>
                <th>Label</th>
                <th>Balance when listed</th>
                <th>Why exposed</th>
                <th>Last move</th>
              </tr>
            </thead>
            <tbody>
              {feed.watchlist.entries.map((e) => {
                const hit = alerts.some((a) => a.address.toLowerCase() === e.address.toLowerCase());
                return (
                  <tr key={e.address} className={hit ? "hit" : ""}>
                    <td className="mono">{short(e.address, 8, 6)}</td>
                    <td>{e.label ?? <span className="muted">—</span>}</td>
                    <td className="mono">{e.balanceWeiAtBuild ? `${eth(BigInt(e.balanceWeiAtBuild))} ETH` : "—"}</td>
                    <td>{KIND[e.exposure.kind] ?? e.exposure.kind}</td>
                    <td className="mono">{e.lastOutgoingBlock !== undefined ? `block ${e.lastOutgoingBlock}` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
