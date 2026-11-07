// The device approver on a phone (#/device?pair=…): a software stand-in for the Firefly, with its own
// key in this phone's storage. It shows each request's fields and signs only what you approve, with a
// digest it computes itself.

import { useEffect, useRef, useState } from "react";
import { bytesToHex, hexToBytes, type Hex } from "viem";
import { describeSignRequest, mnemonicFromSeed, parseSignRequest } from "@postcurve/sdk";
import { cellsFromUsed, KeyGrid } from "../components/KeyGrid";
import { approveOnPhone } from "../lib/device";
import { BrowserKey, identityFromSeed } from "../lib/keys";

const DEVICE_KEY = "postcurve/device/v1";
type DeviceStore = { seed: Hex; used: number[]; registered?: string };

function load(): DeviceStore | null {
  try {
    return JSON.parse(localStorage.getItem(DEVICE_KEY) ?? "null");
  } catch {
    return null;
  }
}
const save = (s: DeviceStore) => localStorage.setItem(DEVICE_KEY, JSON.stringify(s));

export function Device({ pair }: { pair: string }) {
  const [dev, setDev] = useState<DeviceStore | null>(load);
  const [backedUp, setBackedUp] = useState(!!dev?.registered);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState<{ requestId: string; request: unknown } | null>(null);
  const [signed, setSigned] = useState<number[]>([]);
  const key = useRef<Promise<BrowserKey> | null>(null);
  const base = `/operator/relay/${pair}`;
  const valid = /^[0-9a-f]{32}$/.test(pair);

  const create = () => {
    const s = { seed: bytesToHex(crypto.getRandomValues(new Uint8Array(32))), used: [] };
    save(s);
    setDev(s);
  };

  const register = async () => {
    if (!dev) return;
    setStatus("Preparing this device's keys…");
    const identity = await identityFromSeed(dev.seed);
    const r = await fetch(`${base}/identity`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identity }) });
    if (!r.ok && r.status !== 409) return setStatus(`The relay answered ${r.status}`);
    if (r.status === 409) {
      const existing = await (await fetch(`${base}/identity`)).json();
      if (existing.root !== identity.root) return setStatus("This pairing already belongs to another device.");
    }
    const s = { ...dev, registered: pair };
    save(s);
    setDev(s);
    setBackedUp(true);
    setStatus(null);
  };

  // a phone whose words are already backed up joins a new pairing link straight away
  useEffect(() => {
    if (valid && dev?.registered && dev.registered !== pair) register();
  }, [pair, dev?.registered]);

  // wait for requests once paired
  useEffect(() => {
    if (!dev?.registered || dev.registered !== pair) return;
    let live = true;
    const tick = async () => {
      if (pending) return;
      const r = await fetch(`${base}/requests/next`).catch(() => null);
      if (live && r?.status === 200) setPending(await r.json());
    };
    tick();
    const t = setInterval(tick, 1500);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [dev?.registered, pair, pending]);

  const answer = async (approve: boolean) => {
    if (!pending || !dev) return;
    try {
      let body: unknown = { refused: true };
      if (approve) {
        key.current ??= BrowserKey.open(dev.seed, load()?.used ?? [], (used) => save({ ...(load() ?? dev), used }));
        const a = await approveOnPhone(pending.request, await key.current);
        body = a;
        setSigned((prev) => [...prev, a.leaf]);
      }
      await fetch(`${base}/responses/${pending.requestId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
      setDev(load());
    }
  };

  let fields: [string, string][] = [];
  try {
    if (pending) fields = describeSignRequest(parseSignRequest(pending.request));
  } catch {
    fields = [["request", "malformed: refuse it"]];
  }

  return (
    <div className="solo phone">
      <div className="solo-head">
        <div className="wordmark" style={{ padding: 0 }}>
          <i />
          postcurve · device
        </div>
        <span className="tag amber">software stand-in, on your phone</span>
      </div>
      {!valid ? (
        <div className="panel warn">Not a valid pairing link. Scan the QR code from postcurve's setup again.</div>
      ) : !dev ? (
        <div className="panel ok">
          <h2>Be the second approver</h2>
          <p className="muted">This phone gets its own hash-only key. It shows every request in full and signs only what you approve.</p>
          <button className="btn" onClick={create}>
            Create this device's key
          </button>
        </div>
      ) : !backedUp ? (
        <div className="panel ok">
          <h2>This device's backup words</h2>
          <ol className="words phone-words">
            {mnemonicFromSeed(hexToBytes(dev.seed))
              .split(" ")
              .map((w, i) => (
                <li key={i}>
                  <span>{i + 1}</span>
                  {w}
                </li>
              ))}
          </ol>
          <button className="btn" onClick={register}>
            I saved them: pair this device
          </button>
          {status && <p className="muted">{status}</p>}
        </div>
      ) : pending ? (
        <div className="panel warn request">
          <span className="label">Approval request</span>
          <div className="seen">
            {fields.map(([k, v]) => (
              <div key={k}>
                <span className="k">{k}</span>
                <span className="mono">{v}</span>
              </div>
            ))}
          </div>
          <div className="row">
            <button className="btn" onClick={() => answer(true)}>
              Approve
            </button>
            <button className="btn danger" onClick={() => answer(false)}>
              Refuse
            </button>
          </div>
        </div>
      ) : (
        <div className="panel ok">
          <div className="row">
            <span className="spinner slow" />
            <span>Paired. Waiting for a request…</span>
          </div>
          {signed.length > 0 && <p className="mint">✓ signed with one-time key #{signed.at(-1)}</p>}
          {status && <p className="amber">{status}</p>}
          <span className="label">This device's one-time keys</span>
          <KeyGrid size="sm" cells={cellsFromUsed(dev.used)} />
        </div>
      )}
    </div>
  );
}
