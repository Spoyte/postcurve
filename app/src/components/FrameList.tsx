// The six frames of a spend (docs/design.md, "How a spend works"), lit one by one as the receipt arrives.

import { useEffect, useState } from "react";

export const FRAMES = [
  { name: "verify", who: "stealth account", what: "checks the frame layout" },
  { name: "pay", who: "paymaster", what: "checks 2 of 3 hash-only signatures, pays the gas" },
  { name: "commit", who: "paymaster", what: "burns the one-time keys" },
  { name: "checkDeadline", who: "paymaster", what: "opens the atomic batch" },
  { name: "transfer", who: "tUSDC", what: "to the destination" },
  { name: "fee", who: "tUSDC", what: "to the paymaster" },
] as const;

export function FrameList({ gas, ok, notes }: { gas?: number[]; ok?: boolean[]; notes?: Partial<Record<number, string>> }) {
  const [lit, setLit] = useState(0);
  useEffect(() => {
    if (!gas) return setLit(0);
    setLit(0);
    const timers = FRAMES.map((_, i) => setTimeout(() => setLit(i + 1), 220 * (i + 1)));
    return () => timers.forEach(clearTimeout);
  }, [gas?.join(",")]);
  return (
    <ol className="frames">
      {FRAMES.map((f, i) => {
        const on = i < lit;
        const failed = on && ok && ok[i] === false;
        return (
          <li key={f.name} className={`${on ? (failed ? "failed" : "on") : ""} ${i >= 3 ? "batch" : ""}`}>
            <span className="fi">{i}</span>
            <span className="fn mono">{f.name}</span>
            <span className="fw">
              {f.who} · {notes?.[i] ?? f.what}
            </span>
            <span className="fg mono">{on && gas ? gas[i]!.toLocaleString("en-US") : ""}</span>
            <span className="fs">{on ? (failed ? "✕" : "✓") : ""}</span>
          </li>
        );
      })}
    </ol>
  );
}
