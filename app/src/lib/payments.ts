// Finding Alice's payments: every ERC-5564 announcement is tried with her ML-KEM scanning key in
// this browser; the scanning key never leaves it.

import { useEffect, useRef, useState } from "react";
import { hexToBytes, parseAbiItem, type Address, type Hex } from "viem";
import { stealth } from "@postcurve/sdk";
import { useApp } from "./appState";
import { publicClient, tokenBalance } from "./chain";
import { sdkDeployment } from "./config";
import type { Payment } from "./store";

export type Ann = stealth.Announcement & { block: number };

export const ANNOUNCEMENT = parseAbiItem(
  "event Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)",
);

export function findMine(anns: Ann[], dk: Uint8Array, spendKey: Hex, d: stealth.Deployment): { stealth: Address; opener: Hex; block: number }[] {
  return [...anns]
    .sort((a, b) => a.block - b.block)
    .flatMap((a) => {
      const hit = stealth.scan(dk, spendKey, d, a);
      return hit ? [{ stealth: a.stealthAddress, opener: hit.opener, block: a.block }] : [];
    });
}

/** Adds `fresh` to `existing`, one record per stealth address (the first one seen wins). */
export function mergePayments(existing: Payment[], fresh: Payment[]): Payment[] {
  const seen = new Set<string>();
  return [...existing, ...fresh].filter((p) => {
    const k = p.stealth.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export type ScanState = { scanned: number; head: number; balances: Record<string, bigint>; error?: string };

/** Scans new announcements every 4 s, records new payments and keeps their balances fresh. */
export function usePaymentScan(): ScanState {
  const { cfg, store, update, current } = useApp();
  const [state, setState] = useState<ScanState>({ scanned: 0, head: 0, balances: {} });
  const next = useRef(0n);
  const scanned = useRef(0);
  const busy = useRef(false);
  const meta = store.meta;

  useEffect(() => {
    if (!meta) return;
    let live = true;
    const dk = hexToBytes(meta.dk);
    const d = sdkDeployment(cfg);
    const tick = async () => {
      if (busy.current) return; // one scan at a time, so nothing is counted or recorded twice
      busy.current = true;
      try {
        const pub = publicClient(cfg);
        const head = await pub.getBlockNumber();
        if (head >= next.current) {
          const logs = await pub.getLogs({ address: cfg.deployment.announcer, event: ANNOUNCEMENT, fromBlock: next.current, toBlock: head });
          next.current = head + 1n;
          scanned.current += logs.length;
          const anns: Ann[] = logs.map((l) => ({
            stealthAddress: l.args.stealthAddress!,
            ephemeralPubKey: l.args.ephemeralPubKey!,
            metadata: l.args.metadata!,
            block: Number(l.blockNumber),
          }));
          const found = findMine(anns, dk, meta.spendKey, d);
          const known = new Set(current().payments.map((p) => p.stealth.toLowerCase()));
          const fresh = found.filter((f) => !known.has(f.stealth.toLowerCase()));
          if (fresh.length) {
            const amounts = await Promise.all(fresh.map((f) => tokenBalance(cfg, f.stealth)));
            update((s) => ({ ...s, payments: mergePayments(s.payments, fresh.map((f, i) => ({ ...f, amount: amounts[i]!.toString() }))) }));
          }
        }
        const pays = current().payments;
        const bal = await Promise.all(pays.map((p) => tokenBalance(cfg, p.stealth)));
        if (live) {
          setState({ scanned: scanned.current, head: Number(head), balances: Object.fromEntries(pays.map((p, i) => [p.stealth.toLowerCase(), bal[i]!])) });
        }
      } catch (e) {
        if (live) setState((s) => ({ ...s, error: e instanceof Error ? e.message.split("\n")[0] : String(e) }));
      } finally {
        busy.current = false;
      }
    };
    tick();
    const t = setInterval(tick, 4000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [cfg, meta?.dk, meta?.spendKey]);

  return state;
}
