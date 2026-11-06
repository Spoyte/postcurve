// Every key signs once: each approver's 256 one-time keys, and a live attempt to reuse two of them.

import { useCallback, useEffect, useState } from "react";
import { KeyGrid } from "../components/KeyGrid";
import { PageHead } from "../components/Panel";
import { useApp } from "../lib/appState";
import { short } from "../lib/format";
import { mergeKeyStates, onchainUsed, replaySpend, type KeyState } from "../lib/keyGrid";

type Grids = { browser: KeyState[]; device: KeyState[]; paper: KeyState[] };

function count(cells: KeyState[]) {
  return cells.filter((c) => c !== "unused").length;
}

export function Keys() {
  const { cfg, store } = useApp();
  const ids = store.identities;
  const [grids, setGrids] = useState<Grids | null>(null);
  const [replay, setReplay] = useState<{ busy: boolean; result?: { accepted: boolean; raw: string; explained: string } }>({ busy: false });
  const lastSpend = [...store.spends].reverse().find((s) => s.status === "mined");
  const lastPayment = lastSpend && store.payments.find((p) => p.stealth.toLowerCase() === lastSpend.stealth.toLowerCase());

  const refresh = useCallback(async () => {
    if (!ids) return;
    const [b, d, p] = await Promise.all([onchainUsed(cfg, ids.browser), onchainUsed(cfg, ids.device), onchainUsed(cfg, ids.paper)]);
    setGrids({ browser: mergeKeyStates(b, store.browser?.used ?? []), device: mergeKeyStates(d, []), paper: mergeKeyStates(p, []) });
  }, [cfg, ids, store.browser?.used.join(",")]);

  useEffect(() => {
    refresh().catch(() => {});
    const t = setInterval(() => refresh().catch(() => {}), 15000);
    return () => clearInterval(t);
  }, [refresh]);

  const tryReuse = async () => {
    if (!lastSpend || !lastPayment || !ids) return;
    setReplay({ busy: true });
    const result = await replaySpend(cfg, lastSpend, lastPayment, [ids.browser, ids.device, ids.paper]);
    setReplay({ busy: false, result });
    refresh().catch(() => {});
  };

  const nextBrowser = grids?.browser.findIndex((c) => c === "unused");
  const cards: [keyof Grids, string, string][] = [
    ["browser", "Browser", "this browser's key"],
    ["device", "Device", "software stand-in"],
    ["paper", "Paper", "recovery only"],
  ];

  return (
    <>
      <PageHead title="Every key signs once">
        Each approver holds 256 one-time keys (WOTS leaves of an XMSS tree, hash-only). A spend uses one key from each of two
        approvers; the paymaster records them on chain, and a used key can never sign again.
      </PageHead>
      <div className="legend">
        <span>
          <i style={{ background: "#1a2e2c" }} />
          unused
        </span>
        <span>
          <i style={{ background: "#4a2b2e", outline: "1px solid #6b3b3b" }} />
          used, recorded on chain
        </span>
        <span>
          <i style={{ outline: "1px solid var(--amber)" }} />
          used here, never landed (still never reused)
        </span>
        <span>
          <i style={{ background: "var(--mint)" }} />
          next key
        </span>
      </div>
      <div className="keys3">
        {cards.map(([k, title, sub]) => {
          const cells = grids?.[k];
          const used = cells ? count(cells) : 0;
          return (
            <div key={k} className="panel">
              <div className="row between">
                <div>
                  <h3>{title}</h3>
                  <span className="muted">{sub}</span>
                </div>
                {ids && <span className="mono muted">{short(ids[k].root)}</span>}
              </div>
              {cells ? <KeyGrid size="lg" cells={cells} next={k === "browser" ? nextBrowser : undefined} /> : <span className="spinner" />}
              <span className="muted">{cells ? `${used} used · ${256 - used} left` : "reading the chain…"}</span>
            </div>
          );
        })}
      </div>

      <div className={`panel ${replay.result ? (replay.result.accepted ? "alarm" : "alarm") : ""}`}>
        <div className="row between">
          <div>
            <h3>Try to reuse a key</h3>
            <p className="muted">
              {lastSpend
                ? `Sends your last spend again, word for word: the same two signatures, keys #${lastSpend.signers.map((s) => s.leaf).join(" and #")}.`
                : "Make a spend first; this sends it again, word for word."}
            </p>
          </div>
          <button className="btn danger" onClick={tryReuse} disabled={!lastSpend || !lastPayment || replay.busy}>
            {replay.busy ? "Sending…" : "Try to reuse a key"}
          </button>
        </div>
        {replay.result && (
          <>
            <h2>{replay.result.explained}</h2>
            <div className="box">{replay.result.raw}</div>
            <span className="muted">The alt mempool ran the paymaster's check and refused the transaction before it reached a block.</span>
          </>
        )}
      </div>
    </>
  );
}
