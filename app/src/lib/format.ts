import { formatEther, formatUnits } from "viem";

export const short = (h: string, head = 6, tail = 4) => (h.length > head + tail + 2 ? `${h.slice(0, head + 2)}…${h.slice(-tail)}` : h);

/** tUSDC has 6 decimals; show two. */
export const usdc = (v: bigint | string) => {
  const n = Number(formatUnits(BigInt(v), 6));
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

export const eth = (v: bigint) => {
  const n = Number(formatEther(v));
  return n === 0 ? "0" : n < 0.0001 ? n.toExponential(2) : n.toLocaleString("en-US", { maximumFractionDigits: 4 });
};
