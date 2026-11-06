// The frame transaction that spends a stealth bunker account through the postcurve paymaster, shared
// by the e2e script and the browser app so both build exactly the same transaction.
//
//   [only_verify (account)] [pay (paymaster: quorum check)] [commit (records the keys)]
//   [checkDeadline (atomic)] [transfer (atomic)] [fee]
//
// See docs/design.md ("How a spend works") and contracts/src/stealth/PostcurvePaymaster.sol.

import { encodeAbiParameters, encodeFunctionData, keccak256, type Abi, type Address, type Hex } from "viem";
import { getProfile } from "@forshtat/hegota-support/profiles";
import * as ftx from "@forshtat/hegota-support/tx";
import type { TransferApproval } from "../transferApproval";
import type { Identity } from "../xmss";

/** The paymaster's fee per spend (0.50 tUSDC) and the most an approval lets it take (1.00 tUSDC). */
export const SPEND_FEE = 500_000n;
export const SPEND_MAX_FEE = 1_000_000n;
/** 2 gwei, as the devnet smoke test uses; well under the paymaster's MAX_COST cap. */
export const MAX_FEE_PER_GAS = 2_000_000_000n;
export const ATOMIC_BATCH = 0x04;

const profile = getProfile("ethrex-eip8141-tracer");

export type SpendParams = {
  stealth: Address;
  paymaster: Address;
  token: Address;
  threshold: bigint;
  /** All identities of the quorum, in meta-address order. */
  ids: Identity[];
  opener: Hex;
  approval: TransferApproval;
  fee: bigint;
  /** The approvers that signed, by index into `ids`, in increasing order. */
  signers: { idx: number; leaf: number; envelope: Hex }[];
};

export function identityHash(id: Identity): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [id.root, id.pubSeed]));
}

export function buildSpendFrames(p: SpendParams, abi: { paymaster: Abi; account: Abi; token: Abi }): ftx.Frame[] {
  const auth = {
    threshold: p.threshold,
    ids: p.ids,
    opener: p.opener,
    approval: p.approval,
    signerIdx: p.signers.map((s) => BigInt(s.idx)),
    envelopes: p.signers.map((s) => s.envelope),
    fee: p.fee,
  };
  const idHashes = p.signers.map((s) => identityHash(p.ids[s.idx]!));
  const leaves = p.signers.map((s) => BigInt(s.leaf));
  const transfer = (to: Address, amount: bigint) =>
    encodeFunctionData({ abi: abi.token, functionName: "transfer", args: [to, amount] });
  return [
    ftx.frame(profile, "VERIFY", { target: null, scope: "EXECUTION", execution: 90_000n, data: encodeFunctionData({ abi: abi.account, functionName: "verifyExecution" }) }),
    ftx.frame(profile, "VERIFY", { target: p.paymaster, scope: "PAYMENT", execution: 990_000n, data: encodeFunctionData({ abi: abi.paymaster, functionName: "approvePayment", args: [auth] }) }),
    ftx.frame(profile, "DEFAULT", { target: p.paymaster, execution: 120_000n, state: 300_000n, data: encodeFunctionData({ abi: abi.paymaster, functionName: "commit", args: [idHashes, leaves] }) }),
    ftx.frame(profile, "DEFAULT", { target: p.paymaster, flags: ATOMIC_BATCH, execution: 60_000n, data: encodeFunctionData({ abi: abi.paymaster, functionName: "checkDeadline", args: [p.approval.validUntil] }) }),
    ftx.frame(profile, "SENDER", { target: p.token, flags: ATOMIC_BATCH, execution: 80_000n, state: 200_000n, data: transfer(p.approval.to, p.approval.amount) }),
    ftx.frame(profile, "SENDER", { target: p.token, execution: 80_000n, state: 200_000n, data: transfer(p.paymaster, p.fee) }),
  ];
}

export function buildSpendTx(chainId: number, stealth: Address, nonce: bigint, frames: ftx.Frame[]): ftx.FrameTx {
  return ftx.newTx({ chainId, sender: stealth, nonceSeq: nonce, frames, signatures: [], fees: { maxFeePerGas: MAX_FEE_PER_GAS } });
}
