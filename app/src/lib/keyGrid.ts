// The Keys screen's logic: which of an approver's 256 one-time keys are used, and the live replay
// that shows the alt mempool refusing a reused key.

import type { Address, Hex } from "viem";
import { rpc, toWire } from "@forshtat/hegota-support/rpc";
import { stealth, type Identity } from "@postcurve/sdk";
import type { KeyCell } from "../components/KeyGrid";
import { abs, publicClient, sidecarRpc } from "./chain";
import type { AppConfig } from "./config";
import type { Payment, SpendRecord } from "./store";

export type KeyState = KeyCell;

/** On chain wins; a key this browser used for a spend that never landed is "local" (still never reused). */
export function mergeKeyStates(onchain: boolean[], localUsed: number[]): KeyState[] {
  const local = new Set(localUsed);
  return Array.from({ length: 256 }, (_, i) => (onchain[i] ? "onchain" : local.has(i) ? "local" : "unused"));
}

const REJECTED = "94064f91"; // PostcurvePaymaster.Rejected(uint256)
const word = (n: number) => n.toString(16).padStart(64, "0");

export function explainRefusal(message: string): string {
  const m = message.toLowerCase();
  if (m.includes(REJECTED + word(4)) || m.includes(REJECTED + word(5))) return "Refused: these one-time keys were already used";
  return message;
}

/** All 256 leaves of one identity, from the paymaster's register (the source of truth). */
export async function onchainUsed(cfg: AppConfig, id: Identity): Promise<boolean[]> {
  const pub = publicClient(cfg);
  const h = stealth.identityHash(id);
  return Promise.all(
    Array.from({ length: 256 }, (_, leaf) =>
      pub.readContract({ address: cfg.deployment.paymaster, abi: cfg.abi.paymaster, functionName: "isLeafUsed", args: [h, BigInt(leaf)] }) as Promise<boolean>,
    ),
  );
}

/** Sends the exact frames of a mined spend again, at the account's next nonce. */
export async function replaySpend(
  cfg: AppConfig,
  rec: SpendRecord,
  payment: Payment,
  ids: Identity[],
): Promise<{ accepted: boolean; raw: string; explained: string }> {
  const approval = {
    nonce: 0n,
    token: cfg.deployment.token,
    to: rec.to as Address,
    amount: BigInt(rec.amount),
    maxFee: stealth.SPEND_MAX_FEE,
    validUntil: BigInt(rec.validUntil),
  };
  const frames = stealth.buildSpendFrames(
    { stealth: rec.stealth, paymaster: cfg.deployment.paymaster, token: cfg.deployment.token, threshold: 2n, ids, opener: payment.opener, approval, fee: BigInt(rec.fee), signers: rec.signers },
    cfg.abi,
  );
  const nonce = BigInt((await rpc(abs("/rpc"), "eth_getTransactionCount", [rec.stealth, "latest"])) as string);
  try {
    const hash = await sidecarRpc<Hex>("eth_sendFrameTransaction", [toWire(stealth.buildSpendTx(cfg.chainId, rec.stealth, nonce, frames))]);
    return { accepted: true, raw: `accepted: ${hash}`, explained: "The mempool accepted it: this should never happen" };
  } catch (e) {
    const raw = e instanceof Error ? e.message.split("\n")[0]! : String(e);
    return { accepted: false, raw, explained: explainRefusal(raw) };
  }
}
