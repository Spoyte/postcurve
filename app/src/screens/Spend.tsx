// Spend a stealth payment with two hash-only approvals, through the paymaster: no ETH, no ECDSA.

import { useEffect, useState } from "react";
import { formatEther, parseAbiItem, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { rpc, toWire } from "@forshtat/hegota-support/rpc";
import { FrameList } from "../components/FrameList";
import { cellsFromUsed, KeyGrid } from "../components/KeyGrid";
import { PageHead } from "../components/Panel";
import { useApp } from "../lib/appState";
import { useBrowserKey } from "../lib/browserKey";
import { abs, publicClient, sidecarRpc, tokenBalance } from "../lib/chain";
import { bridgeDevice } from "../lib/device";
import { short, usdc } from "../lib/format";
import { runSpend, spendAmounts, type SpendReceipt, type SpendStep } from "../lib/spend";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const STEPS: [SpendStep, string][] = [
  ["deploy", "The postcurve operator deploys this payment's account"],
  ["browser", "This browser approves with a one-time key"],
  ["device", "The device approves with its own one-time key"],
  ["submit", "Sent to the alt mempool, gas paid by the paymaster"],
  ["mined", "Mined"],
];

type Status = "todo" | "doing" | "done" | "failed";

/** Every step before `step` is done and `step` is in progress; null means all done. */
function statusAt(step: SpendStep | null): Partial<Record<SpendStep, Status>> {
  const at = step === null ? STEPS.length : STEPS.findIndex(([s]) => s === step);
  return Object.fromEntries(STEPS.map(([s], i) => [s, i < at ? "done" : i === at ? "doing" : "todo"]));
}
type Result = { txHash: Hex; receipt: SpendReceipt; deployTx: Hex | null; amount: bigint; fee: bigint; browserLeaf: number; deviceLeaf: number };
type Seen = { from?: Address; received?: bigint; ethBalance: bigint; gasCost?: bigint };

async function waitReceipt(hash: Hex): Promise<SpendReceipt> {
  for (let i = 0; i < 90; i++) {
    const r = (await rpc(abs("/rpc"), "eth_getTransactionReceipt", [hash])) as SpendReceipt | null;
    if (r) return r;
    await new Promise((res) => setTimeout(res, 1500));
  }
  throw new Error("no receipt after 2 minutes");
}

export function Spend({ account }: { account: string }) {
  const { cfg, store, update } = useApp();
  const browserKey = useBrowserKey();
  const payment = store.payments.find((p) => p.stealth.toLowerCase() === account.toLowerCase());
  const [balance, setBalance] = useState<bigint | null>(null);
  const [to, setTo] = useState<string>(() => privateKeyToAccount(generatePrivateKey()).address);
  const [status, setStatus] = useState<Partial<Record<SpendStep, Status>>>({});
  const [detail, setDetail] = useState<{ browserLeaf?: number; deviceLeaf?: number; deployTx?: Hex | null; txHash?: Hex }>({});
  const [result, setResult] = useState<Result | null>(null);
  const [seen, setSeen] = useState<Seen | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = Object.values(status).some((s) => s === "doing");

  useEffect(() => {
    if (payment) tokenBalance(cfg, payment.stealth).then(setBalance).catch(() => {});
  }, [payment?.stealth, result]);

  if (!payment || !store.meta || !store.identities) {
    return (
      <div className="panel warn">
        <p>
          This payment isn't in your list. Go back to <a href="#/payments">Payments</a>.
        </p>
      </div>
    );
  }
  const amounts = balance === null ? null : spendAmounts(balance);
  const validTo = /^0x[0-9a-fA-F]{40}$/.test(to);

  const go = async () => {
    setError(null);
    setResult(null);
    setSeen(null);
    setStatus(statusAt("deploy"));
    const pub = publicClient(cfg);
    const device = bridgeDevice();
    let current: SpendStep = "deploy";
    try {
      const r = await runSpend(
        { stealth: payment.stealth, opener: payment.opener, spendKey: store.meta!.spendKey, balance: balance! },
        to as Address,
        {
          chainId: cfg.chainId,
          paymaster: cfg.deployment.paymaster,
          token: cfg.deployment.token,
          ids: [store.identities!.browser, store.identities!.device, store.identities!.paper],
          abi: cfg.abi,
          headTime: async () => (await pub.getBlock()).timestamp,
          nonceOf: async (a) => BigInt((await rpc(abs("/rpc"), "eth_getTransactionCount", [a, "latest"])) as string),
          deploy: async (commitment) => {
            const res = await fetch("/operator/deploy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ commitment }) });
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `the operator answered ${res.status}`);
            return res.json();
          },
          browserApprove: async (digest) => (await browserKey()).approve(digest),
          deviceSign: (req) => device.sign(req),
          submit: (tx) => sidecarRpc<Hex>("eth_sendFrameTransaction", [toWire(tx)]),
          receipt: waitReceipt,
          record: (rec) =>
            update((s) => ({ ...s, spends: [...s.spends.filter((x) => !(x.stealth === rec.stealth && x.validUntil === rec.validUntil)), rec] })),
        },
        (step, d) => {
          current = step;
          setStatus(statusAt(step));
          setDetail((prev) => ({ ...prev, ...d }));
        },
      );
      setStatus(statusAt(null));
      setResult({
        txHash: r.txHash,
        receipt: r.receipt,
        deployTx: r.deployTx,
        amount: r.approval.amount,
        fee: r.fee,
        browserLeaf: r.signers[0]!.leaf,
        deviceLeaf: r.signers[1]!.leaf,
      });
      // what anyone can read on chain about this account
      const logs = await pub.getLogs({ address: cfg.deployment.token, event: TRANSFER, args: { to: payment.stealth }, fromBlock: 0n, toBlock: "latest" });
      const price = r.receipt.effectiveGasPrice ? BigInt(r.receipt.effectiveGasPrice) : undefined;
      setSeen({
        from: logs[0]?.args.from,
        received: logs[0]?.args.value,
        ethBalance: await pub.getBalance({ address: payment.stealth }),
        gasCost: price ? price * BigInt(r.receipt.gasUsed) : undefined,
      });
    } catch (e) {
      const failed = current;
      setStatus({ ...statusAt(failed), [failed]: "failed" });
      setError(e instanceof Error ? e.message.split("\n")[0]! : String(e));
    }
  };

  const gas = result?.receipt.frameReceipts.map((f) => Number(f.gasUsed));
  const frameOk = result?.receipt.frameReceipts.map((f) => f.status === "0x1");
  const browserUsed = store.browser?.used ?? [];

  return (
    <>
      <PageHead title="Spend">
        Two of your three hash-only keys approve; the postcurve paymaster pays the gas and takes its fee in tUSDC. You never hold or
        need ETH.
      </PageHead>

      <div className="panel">
        <div className="row between">
          <div>
            <span className="label">From stealth account</span>
            <div className="mono">{payment.stealth}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div className="big">
              {balance === null ? "…" : usdc(balance)} <span className="unit">tUSDC</span>
            </div>
            <span className="muted">test token</span>
          </div>
        </div>
        <div className="grid2">
          <label>
            <span className="label">To (a new address of yours)</span>
            <input className="input mono" value={to} onChange={(e) => setTo(e.target.value.trim())} disabled={running || !!result} />
          </label>
          <div>
            <span className="label">You send · fee to the paymaster</span>
            <div className="mono" style={{ marginTop: 10 }}>
              {result ? `${usdc(result.amount)} tUSDC · ${usdc(result.fee)} tUSDC` : amounts ? `${usdc(amounts.amount)} tUSDC · ${usdc(amounts.fee)} tUSDC` : "—"}{" "}
              <span className="muted">· 0 ETH</span>
            </div>
          </div>
        </div>
        <div className="row">
          <button className="btn" onClick={go} disabled={!amounts || !validTo || running || !!result}>
            {running ? "Spending…" : result ? "Spent" : "Approve and spend"}
          </button>
          {!amounts && !result && balance !== null && <span className="muted">Nothing to spend: the balance doesn't cover the 1.00 tUSDC maximum fee.</span>}
        </div>
      </div>

      <div className="spend-grid">
        <div className="approvers">
          <div className={`panel approver ${detail.browserLeaf !== undefined ? "ok" : ""}`}>
            <div>
              <h3>Browser</h3>
              <span className="muted">this browser's key</span>
            </div>
            {detail.browserLeaf !== undefined ? <span className="mint">✓ one-time key #{detail.browserLeaf}</span> : <span className="muted">—</span>}
          </div>
          <div className={`panel approver ${status.device === "doing" ? "waiting" : detail.deviceLeaf !== undefined ? "ok" : ""}`}>
            <div>
              <h3>
                Device <span className="tag amber">software stand-in</span>
              </h3>
              <span className="muted">its own key, its own terminal</span>
            </div>
            {detail.deviceLeaf !== undefined ? (
              <span className="mint">✓ one-time key #{detail.deviceLeaf}</span>
            ) : status.device === "doing" ? (
              <span className="amber">approve in the device terminal…</span>
            ) : status.device === "failed" ? (
              <span className="red">refused</span>
            ) : (
              <span className="muted">—</span>
            )}
          </div>
          <div className="panel approver dim">
            <div>
              <h3>Paper</h3>
              <span className="muted">recovery only</span>
            </div>
            <span className="muted">not used</span>
          </div>
          <div className="panel inset">
            <ul className="progress">
              {STEPS.map(([step, label]) => {
                const s = status[step] ?? "todo";
                return (
                  <li key={step} className={s}>
                    <span className="dot">{s === "doing" ? <span className="spinner" /> : s === "done" ? <span className="mint">✓</span> : s === "failed" ? "✕" : "·"}</span>
                    <span>
                      {label}
                      {step === "deploy" && s === "done" && detail.deployTx === null ? " (already deployed)" : ""}
                      {step === "mined" && result ? ` in block ${Number(result.receipt.blockNumber)}` : ""}
                    </span>
                  </li>
                );
              })}
            </ul>
            {error && <div className="red">{error}</div>}
          </div>
        </div>

        <div className="panel">
          <div className="row between">
            <h3>The transaction</h3>
            <span className="muted mono">{result ? short(result.txHash, 8, 6) : detail.txHash ? short(detail.txHash, 8, 6) : "one EIP-8141 frame transaction"}</span>
          </div>
          <FrameList
            gas={gas}
            ok={frameOk}
            notes={result ? { 4: `${usdc(result.amount)} to ${short(to)}`, 5: `${usdc(result.fee)} to the paymaster` } : undefined}
          />
          <div className="batchnote">Frames 3–5 form one atomic batch: if the deadline check fails, nothing moves, and the keys are still burned.</div>
        </div>
      </div>

      {result && (
        <div className="grid2">
          <div className="panel">
            <h3>What everyone else sees</h3>
            <div className="seen">
              <div>
                <span className="k">This account</span>
                <span className="mono">{short(payment.stealth, 8, 6)}</span>
              </div>
              <div>
                <span className="k">Paid by</span>
                <span>
                  <span className="mono">{seen?.from ? short(seen.from) : "…"}</span> <span className="muted">(an ordinary account) · {seen?.received !== undefined ? usdc(seen.received) : "…"} tUSDC</span>
                </span>
              </div>
              <div>
                <span className="k">Deployed by</span>
                <span>the postcurve operator</span>
              </div>
              <div>
                <span className="k">Gas paid by</span>
                <span>
                  the paymaster{seen?.gasCost !== undefined ? ` · ${Number(formatEther(seen.gasCost)).toFixed(5)} ETH` : ""}
                </span>
              </div>
              <div>
                <span className="k">ETH it holds</span>
                <span className="mint">{seen ? formatEther(seen.ethBalance) : "…"} · it never needed any</span>
              </div>
              <div>
                <span className="k">Links to you</span>
                <span>none, until this spend: it links the account to {short(to)}</span>
              </div>
            </div>
          </div>
          <div className="panel">
            <h3>The keys this spend used</h3>
            <p className="muted">
              Browser key #{result.browserLeaf} and device key #{result.deviceLeaf}. Each signed once and is now burned on chain: they can
              never sign again.
            </p>
            <span className="label">This browser's 256 one-time keys</span>
            <KeyGrid cells={cellsFromUsed(browserUsed)} pulse={[result.browserLeaf]} next={Math.max(-1, ...browserUsed) + 1} />
            <a href="#/keys">See all keys →</a>
          </div>
        </div>
      )}
    </>
  );
}
