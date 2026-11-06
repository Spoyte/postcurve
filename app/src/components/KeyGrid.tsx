// 256 one-time keys of one approver: unused, used on chain, or used locally but never landed.

export type KeyCell = "unused" | "onchain" | "local";

export function KeyGrid({ cells, pulse = [], next, size = "md" }: { cells: KeyCell[]; pulse?: number[]; next?: number; size?: "sm" | "md" | "lg" }) {
  return (
    <div className={`keygrid ${size}`}>
      {cells.map((c, i) => (
        <i key={i} className={`${c} ${pulse.includes(i) ? "pulse" : ""} ${i === next ? "next" : ""}`} title={`one-time key #${i}: ${c === "unused" ? "unused" : c === "onchain" ? "used on chain" : "used locally, never landed"}`} />
      ))}
    </div>
  );
}

export function cellsFromUsed(used: Iterable<number>, kind: KeyCell = "onchain"): KeyCell[] {
  const set = new Set(used);
  return Array.from({ length: 256 }, (_, i) => (set.has(i) ? kind : "unused"));
}
