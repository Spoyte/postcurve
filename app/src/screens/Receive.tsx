// Alice's private payment link: every payment to it lands at a brand-new address only she can find.

import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import { PageHead } from "../components/Panel";
import { useApp } from "../lib/appState";
import { encodePayLink } from "../lib/link";

export function Receive() {
  const { store } = useApp();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [copied, setCopied] = useState(false);
  const link = store.meta ? encodePayLink(location.origin, store.meta.metaAddress) : "";

  useEffect(() => {
    if (!canvas.current || !link) return;
    QRCode.toCanvas(canvas.current, link, { errorCorrectionLevel: "L", margin: 1, width: 300, color: { dark: "#0b0f14", light: "#f4f7fa" } }).catch(
      () => {},
    );
  }, [link]);

  const copy = async () => {
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <>
      <PageHead title="Receive privately">
        Share this link. Every payment to it lands at a brand-new address that only you can find, and that only your hash-only
        keys can spend.
      </PageHead>
      <div className="receive">
        <div className="qr">
          <canvas ref={canvas} />
        </div>
        <div className="panel" style={{ flex: 1 }}>
          <span className="label">Your payment link</span>
          <div className="box link">{link}</div>
          <div className="row">
            <button className="btn" onClick={copy}>
              {copied ? "Copied" : "Copy link"}
            </button>
            <button className="btn ghost" onClick={() => window.open(link, "_blank", "noopener")}>
              Open as Bob (a sender)
            </button>
          </div>
          <div className="facts">
            <div>
              <span className="label">What a sender learns</span>
              <p>One fresh address, nothing more. Not your other payments, not when you spend.</p>
            </div>
            <div>
              <span className="label">What protects what</span>
              <p>
                Finding payments: ML-KEM-768 (privacy only). <span className="mint">Spending: WOTS/XMSS, hash-only, 2 of 3.</span>
              </p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
