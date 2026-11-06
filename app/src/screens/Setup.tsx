// First run: three approver keys in three places, any two of which can spend (docs/design.md, part 6).
// The browser keeps its own key; the device key stays in the device; the paper seed is shown once
// and only what derives from it (its public identity and the scanning key) is kept.

import { useEffect, useState, type ReactNode } from "react";
import { bytesToHex, hexToBytes, type Hex } from "viem";
import { mnemonicFromSeed, stealth, type Identity } from "@postcurve/sdk";
import { PageHead } from "../components/Panel";
import { useApp } from "../lib/appState";
import { identityFromSeed } from "../lib/keys";
import { go } from "../lib/route";

const randomSeed = (): Hex => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

function Step({ n, title, state, summary, children }: { n: number; title: string; state: "done" | "now" | "later"; summary?: ReactNode; children?: ReactNode }) {
  return (
    <section className={`panel step ${state}`}>
      <div className="row between">
        <div className="row">
          <span className={`step-n ${state}`}>{state === "done" ? "✓" : n}</span>
          <h3>{title}</h3>
        </div>
        {state === "done" && summary}
      </div>
      {state === "now" && children}
    </section>
  );
}

function Words({ words, paper }: { words: string; paper?: boolean }) {
  return (
    <ol className={`words ${paper ? "paper" : ""}`}>
      {words.split(" ").map((w, i) => (
        <li key={i}>
          <span>{i + 1}</span>
          {w}
        </li>
      ))}
    </ol>
  );
}

function Preparing({ what }: { what: string }) {
  return (
    <div className="row muted">
      <span className="spinner" /> {what}
    </div>
  );
}

export function Setup() {
  const { store, update } = useApp();
  const [browserId, setBrowserId] = useState<Identity | null>(null);
  const [browserSaved, setBrowserSaved] = useState(false);
  const [deviceId, setDeviceId] = useState<Identity | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [paperSeed, setPaperSeed] = useState<Hex | null>(null);
  const [paperWritten, setPaperWritten] = useState(false);
  const [paper, setPaper] = useState<{ identity: Identity; ek: Hex; dk: Hex } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // 1. the browser key: made once and kept, so a reload mid-setup doesn't lose it
  useEffect(() => {
    if (!store.browser) return;
    let live = true;
    identityFromSeed(store.browser.seed).then((id) => live && setBrowserId(id));
    return () => {
      live = false;
    };
  }, [store.browser?.seed]);

  const makeBrowserKey = () => update((s) => ({ ...s, browser: { seed: randomSeed(), used: [] } }));

  const pairDevice = async () => {
    setDeviceError(null);
    setBusy("device");
    try {
      const r = await fetch("/device/identity");
      if (!r.ok) throw new Error(`the device answered ${r.status}`);
      setDeviceId((await r.json()) as Identity);
    } catch (e) {
      setDeviceError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const keepPaper = async () => {
    if (!paperSeed) return;
    setBusy("paper");
    try {
      const identity = await identityFromSeed(paperSeed);
      const vk = stealth.viewKeyFromSeed(hexToBytes(paperSeed));
      setPaper({ identity, ek: bytesToHex(vk.ek), dk: bytesToHex(vk.dk) });
      setPaperSeed(null); // the paper seed is never kept
    } finally {
      setBusy(null);
    }
  };

  const finish = () => {
    if (!browserId || !deviceId || !paper) return;
    const spendKey = stealth.spendKey(2, [browserId, deviceId, paper.identity]);
    const metaAddress = stealth.encodeMetaAddress(spendKey, hexToBytes(paper.ek));
    update((s) => ({
      ...s,
      identities: { browser: browserId, device: deviceId, paper: paper.identity },
      device: { kind: "bridge" },
      meta: { threshold: 2, spendKey, metaAddress, ek: paper.ek, dk: paper.dk },
    }));
    go("#/receive");
  };

  const s1 = browserId && browserSaved ? "done" : "now";
  const s2 = s1 !== "done" ? "later" : deviceId ? "done" : "now";
  const s3 = s2 !== "done" ? "later" : paper ? "done" : "now";
  const s4 = s3 !== "done" ? "later" : "now";

  return (
    <div className="setup">
      <PageHead title="Set up postcurve">
        Three approver keys in three places. Any two of them can spend; no single one can. Every key is hash-only (WOTS/XMSS):
        no elliptic curve anywhere in a spend.
      </PageHead>

      <Step n={1} title="This browser's key" state={s1} summary={browserId && <span className="mono muted">{short(browserId.root)}</span>}>
        {!store.browser ? (
          <div className="row">
            <button className="btn" onClick={makeBrowserKey}>
              Create the browser key
            </button>
            <span className="muted">It stays in this browser. It can never spend alone.</span>
          </div>
        ) : !browserId ? (
          <Preparing what="Preparing your keys: 256 one-time keys, built from the seed" />
        ) : (
          <>
            <p className="muted">These 24 words restore this browser's key. Write them down somewhere safe.</p>
            <Words words={mnemonicFromSeed(hexToBytes(store.browser.seed))} />
            <div>
              <button className="btn" onClick={() => setBrowserSaved(true)}>
                I saved them
              </button>
            </div>
          </>
        )}
      </Step>

      <Step
        n={2}
        title="Your device"
        state={s2}
        summary={
          deviceId && (
            <span className="row">
              <span className="tag amber">software stand-in</span>
              <span className="mono muted">{short(deviceId.root)}</span>
            </span>
          )
        }
      >
        <p className="muted">
          The device holds its own key and shows every request before you approve it. Until the Firefly firmware exists, it is a{" "}
          <b className="amber">software stand-in</b> running in its own terminal on this computer.
        </p>
        <div className="row">
          <button className="btn" onClick={pairDevice} disabled={busy === "device"}>
            {busy === "device" ? "Pairing…" : "Pair the device terminal"}
          </button>
        </div>
        {deviceError && (
          <div className="panel warn">
            <p>The device isn't answering ({deviceError}). Start it in a terminal, then pair again:</p>
            <div className="box">cd sdk && bun scripts/device-signer.ts init &nbsp;# once{"\n"}</div>
            <div className="box">cd sdk && bun scripts/device-signer.ts serve</div>
          </div>
        )}
      </Step>

      <Step n={3} title="Paper recovery seed" state={s3} summary={paper && <span className="mono muted">{short(paper.identity.root)}</span>}>
        <p className="muted">
          For recovery only: it never signs in everyday use. These words are shown once and never stored here. postcurve keeps only
          their public key and the key that finds your payments.
        </p>
        {!paperSeed ? (
          <div>
            <button className="btn" onClick={() => setPaperSeed(randomSeed())}>
              Show my paper seed
            </button>
          </div>
        ) : (
          <>
            <Words words={mnemonicFromSeed(hexToBytes(paperSeed))} paper />
            <label className="row check">
              <input type="checkbox" checked={paperWritten} onChange={(e) => setPaperWritten(e.target.checked)} />I wrote these down
              on paper
            </label>
            <div>
              {busy === "paper" ? (
                <Preparing what="Preparing the paper key" />
              ) : (
                <button className="btn" disabled={!paperWritten} onClick={keepPaper}>
                  Continue
                </button>
              )}
            </div>
          </>
        )}
      </Step>

      <Step n={4} title="Your private payment address" state={s4}>
        <p className="muted">
          Browser, device and paper make one 2-of-3 quorum. Senders turn your payment address into a brand-new account for every
          payment; only these keys can spend from it.
        </p>
        <div className="quorum">
          <span className="tag mint">browser</span>
          <span className="tag amber">device · software</span>
          <span className="tag">paper · recovery</span>
          <span className="muted">any 2 of 3</span>
        </div>
        <div>
          <button className="btn" onClick={finish}>
            Create my payment address
          </button>
        </div>
      </Step>
    </div>
  );
}
