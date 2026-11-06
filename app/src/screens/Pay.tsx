// Bob's window: an ordinary ECDSA test account pays Alice's private payment link. The payment goes to
// a fresh stealth address (pq-sap) with an ERC-5564 announcement, exactly as sdk/scripts/e2e-stealth.ts.

import { useCallback, useEffect, useState } from "react";
import { encodeFunctionData, parseUnits, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { stealth } from "@postcurve/sdk";
import { useApp } from "../lib/appState";
import { publicClient, sendLegacy, tokenBalance } from "../lib/chain";
import { sdkDeployment } from "../lib/config";
import { eth, short, usdc } from "../lib/format";
import { decodePayLink } from "../lib/link";

const BOB_KEY = "postcurve/bob";
const MIN_PAY = parseUnits("1", 6);

function bobKey(): Hex {
  let k = localStorage.getItem(BOB_KEY) as Hex | null;
  if (!k) {
    k = generatePrivateKey();
    localStorage.setItem(BOB_KEY, k);
  }
  return k;
}

type Step = { label: string; state: "doing" | "done" | "failed"; detail?: string };

export function Pay() {
  const { cfg } = useApp();
  const meta = decodePayLink(location.href);
  const [key] = useState(bobKey);
  const bob = privateKeyToAccount(key).address;
  const [balances, setBalances] = useState<{ eth: bigint; usdc: bigint } | null>(null);
  const [amount, setAmount] = useState("25");
  const [funding, setFunding] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [paid, setPaid] = useState<{ address: Address; transfer: Hex; announce: Hex } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [e, u] = await Promise.all([publicClient(cfg).getBalance({ address: bob }), tokenBalance(cfg, bob)]);
    setBalances({ eth: e, usdc: u });
  }, [cfg, bob]);

  useEffect(() => {
    refresh().catch(() => {});
    const t = setInterval(() => refresh().catch(() => {}), 4000);
    return () => clearInterval(t);
  }, [refresh]);

  const fund = async () => {
    setFunding(true);
    setError(null);
    try {
      const r = await fetch("/operator/faucet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: bob }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `faucet answered ${r.status}`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setFunding(false);
    }
  };

  let units: bigint | null = null;
  try {
    units = parseUnits(amount || "0", 6);
  } catch {
    units = null;
  }
  const canPay = !!meta && units !== null && units >= MIN_PAY && !!balances && balances.usdc >= units && balances.eth > 0n && steps.length === 0;

  const pay = async () => {
    if (!meta || units === null) return;
    setError(null);
    const log = (s: Step) => setSteps((prev) => [...prev.filter((p) => p.label !== s.label), s]);
    try {
      const s = stealth.send(meta, sdkDeployment(cfg));
      const pub = publicClient(cfg);
      const [nonce, code] = await Promise.all([pub.getTransactionCount({ address: s.address }), pub.getCode({ address: s.address })]);
      const fresh = nonce === 0 && (!code || code === "0x");
      log({ label: "Derive a brand-new address from Alice's link", state: "done", detail: `${short(s.address)} · ${fresh ? "no history" : "has history?!"}` });
      log({ label: `Send ${usdc(units)} tUSDC to it`, state: "doing" });
      const transfer = await sendLegacy(cfg, key, cfg.deployment.token, encodeFunctionData({ abi: cfg.abi.token, functionName: "transfer", args: [s.address, units] }));
      log({ label: `Send ${usdc(units)} tUSDC to it`, state: "done", detail: short(transfer, 8, 6) });
      log({ label: "Announce it (only Alice can recognise it)", state: "doing" });
      const announce = await sendLegacy(
        cfg,
        key,
        cfg.deployment.announcer,
        encodeFunctionData({ abi: cfg.abi.announcer, functionName: "announce", args: [2n, s.address, s.ephemeralPubKey, toHex(new Uint8Array([s.viewTag]))] }),
      );
      log({ label: "Announce it (only Alice can recognise it)", state: "done", detail: short(announce, 8, 6) });
      setPaid({ address: s.address, transfer, announce });
      refresh().catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message.split("\n")[0]! : String(e));
      setSteps((prev) => prev.map((p) => (p.state === "doing" ? { ...p, state: "failed" } : p)));
    }
  };

  return (
    <div className="solo">
      <div className="solo-head">
        <div className="wordmark" style={{ padding: 0 }}>
          <i />
          postcurve · pay
        </div>
        <span className="tag amber">Bob · ordinary ECDSA test account</span>
      </div>

      {!meta ? (
        <div className="panel warn">
          <h3>Not a valid postcurve payment link</h3>
          <p>The link is incomplete or was changed. Ask the recipient to share it again.</p>
        </div>
      ) : (
        <>
          <div className="panel">
            <div className="row between">
              <div>
                <span className="label">Bob's wallet</span>
                <div className="mono">{short(bob, 10, 8)}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div className="mono">{balances ? `${usdc(balances.usdc)} tUSDC` : "…"}</div>
                <div className="mono muted">{balances ? `${eth(balances.eth)} ETH` : ""}</div>
              </div>
            </div>
            <div>
              <button className="btn ghost" onClick={fund} disabled={funding}>
                {funding ? "Getting test funds…" : "Get test funds"}
              </button>
              <span className="muted" style={{ marginLeft: 10 }}>
                0.05 ETH and 100 tUSDC from the postcurve operator (local devnet)
              </span>
            </div>
          </div>

          <div className="panel ok">
            <h2>Pay privately</h2>
            <p className="muted">
              This creates a brand-new address for this payment. Only the recipient can tell it's theirs, and only their hash-only keys
              can spend from it.
            </p>
            <div className="row">
              <input className="input" style={{ maxWidth: 180 }} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
              <span className="muted">tUSDC · test token · at least 1.00</span>
            </div>
            <div>
              <button className="btn" onClick={pay} disabled={!canPay}>
                Pay {units !== null && units > 0n ? usdc(units) : ""} tUSDC
              </button>
            </div>
            {steps.length > 0 && (
              <ul className="steps">
                {steps.map((s) => (
                  <li key={s.label}>
                    <span className="dot">{s.state === "doing" ? <span className="spinner" /> : s.state === "done" ? <span className="mint">✓</span> : <span className="red">✕</span>}</span>
                    <span>{s.label}</span>
                    {s.detail && <span className="mono muted">{s.detail}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {paid && (
            <div className="panel ok">
              <span className="label">Done</span>
              <p>
                You paid <span className="mono mint">{paid.address}</span>, an address with no history before this payment.
              </p>
              <p className="muted">Bob knows only this address. He can't see the recipient's other payments, or tell when they spend.</p>
            </div>
          )}
          {error && <div className="panel warn">{error}</div>}
        </>
      )}
    </div>
  );
}
