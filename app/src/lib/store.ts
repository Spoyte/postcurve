// Everything the browser keeps, in localStorage under one key. Payments and spends belong to one
// deployment; keys, identities, the meta-address and used-key lists outlive a devnet redeploy
// (a used key stays used, which is always safe). The paper seed is never stored.

import type { Address, Hex } from "viem";
import type { Identity } from "@postcurve/sdk";

export const STORE_KEY = "postcurve/v1";

export type Payment = { stealth: Address; opener: Hex; block: number; amount: string };

export type SpendRecord = {
  stealth: Address;
  to: Address;
  amount: string;
  fee: string;
  validUntil: string;
  signers: { idx: 0 | 1 | 2; leaf: number; envelope: Hex }[];
  txHash?: Hex;
  status: "signed" | "submitted" | "mined" | "failed";
  error?: string;
};

export type Stored = {
  deploymentId: string;
  browser?: { seed: Hex; used: number[] };
  identities?: { browser: Identity; device: Identity; paper: Identity };
  device?: { kind: "bridge" } | { kind: "phone"; pairId: string };
  meta?: { threshold: 2; spendKey: Hex; metaAddress: Hex; ek: Hex; dk: Hex };
  payments: Payment[];
  spends: SpendRecord[];
  seenAlerts: string[];
  /** Set by readStore only, the first time it sees another deployment; never written. */
  redeployed?: true;
};

const empty = (deploymentId: string): Stored => ({ deploymentId, payments: [], spends: [], seenAlerts: [] });

export function readStore(deploymentId: string): Stored {
  let s: Stored;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return empty(deploymentId);
    s = JSON.parse(raw) as Stored;
    if (typeof s !== "object" || s === null || !Array.isArray(s.payments)) return empty(deploymentId);
  } catch {
    return empty(deploymentId);
  }
  if (s.deploymentId === deploymentId) return s;
  const moved: Stored = { ...s, deploymentId, payments: [], spends: [] };
  writeStore(moved);
  return { ...moved, redeployed: true };
}

export function writeStore(s: Stored): void {
  const { redeployed: _, ...rest } = s;
  localStorage.setItem(STORE_KEY, JSON.stringify(rest));
}

/** "Reset demo": forget every postcurve entry in this browser. */
export function resetAll(): void {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith("postcurve/")) keys.push(k);
  }
  for (const k of keys) localStorage.removeItem(k);
}
