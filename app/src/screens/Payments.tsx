// Alice's payments, found by scanning every announcement with her private scanning key.

import { stealth } from "@postcurve/sdk";
import { PageHead } from "../components/Panel";
import { useApp } from "../lib/appState";
import { short, usdc } from "../lib/format";
import { mergePayments, usePaymentScan } from "../lib/payments";
import { go } from "../lib/route";

export function Payments() {
  const { store } = useApp();
  const scan = usePaymentScan();
  const payments = mergePayments(store.payments, []);
  const mine = payments.length;

  return (
    <>
      <PageHead title="Payments">
        Your browser tries every payment announcement on the chain with your private scanning key. Only the ones meant for you
        open; nobody else can tell which those are.
      </PageHead>
      <div className="panel inset scanbar">
        <span className="spinner slow" />
        <span>
          <b>{scan.scanned}</b> announcement{scan.scanned === 1 ? "" : "s"} scanned · <b className="mint">{mine}</b> {mine === 1 ? "is" : "are"} yours
        </span>
        <span className="muted mono">block {scan.head || "…"}</span>
        {scan.error && <span className="amber">{scan.error}</span>}
      </div>
      {mine === 0 ? (
        <div className="panel">
          <p className="muted">
            No payments yet. Share your link from <a href="#/receive">Receive</a>, or open it as Bob to send a test payment.
          </p>
        </div>
      ) : (
        <div className="paylist">
          {[...payments].reverse().map((p) => {
            const bal = scan.balances[p.stealth.toLowerCase()];
            const spent = store.spends.some((s) => s.stealth.toLowerCase() === p.stealth.toLowerCase() && s.status === "mined");
            const spendable = bal !== undefined && bal > stealth.SPEND_MAX_FEE && !spent;
            return (
              <div key={p.stealth} className={`panel payment ${spendable ? "ok" : ""}`}>
                <div className="row between">
                  <div>
                    <div className="big">
                      {usdc(p.amount)} <span className="unit">tUSDC</span>
                    </div>
                    <div className="mono muted">
                      to stealth {short(p.stealth, 8, 6)} · found in block {p.block}
                    </div>
                  </div>
                  <div className="row">
                    {spent ? (
                      <span className="tag">spent</span>
                    ) : bal === 0n ? (
                      <span className="tag">empty</span>
                    ) : (
                      <span className="tag mint">unspent · {bal === undefined ? "…" : usdc(bal)}</span>
                    )}
                    <button className="btn" disabled={!spendable} onClick={() => go(`#/spend/${p.stealth}`)}>
                      Spend
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
