// Spending a stealth payment: the operator deploys the account if needed, the browser and the device
// each approve with a one-time key, and the six-frame transaction goes to the alt mempool, where the
// paymaster pays the gas and takes its fee in tUSDC. Every step is recorded as it happens.

import type { Abi, Address, Hex } from "viem";
import { stealth, transferApprovalDigest, type Identity, type SignRequest, type TransferApproval } from "@postcurve/sdk";
import type { FrameTx } from "@forshtat/hegota-support/tx";
import type { SpendRecord } from "./store";

export function spendAmounts(balance: bigint): { amount: bigint; fee: bigint } | null {
  if (balance <= stealth.SPEND_MAX_FEE) return null;
  return { amount: balance - stealth.SPEND_FEE, fee: stealth.SPEND_FEE };
}

export type SpendReceipt = {
  status: Hex;
  blockNumber: Hex;
  gasUsed: Hex;
  effectiveGasPrice?: Hex;
  frameReceipts: { status: Hex; gasUsed: Hex }[];
};

export type SpendDeps = {
  chainId: number;
  paymaster: Address;
  token: Address;
  /** browser, device, paper: the meta-address order. */
  ids: Identity[];
  abi: { paymaster: Abi; account: Abi; token: Abi };
  headTime: () => Promise<bigint>;
  nonceOf: (account: Address) => Promise<bigint>;
  deploy: (commitment: Hex) => Promise<{ address: Address; txHash: Hex | null }>;
  browserApprove: (digest: Hex) => Promise<{ leaf: number; envelope: Hex }>;
  deviceSign: (req: SignRequest) => Promise<{ leaf: number; envelope: Hex; identity: Identity }>;
  submit: (tx: FrameTx) => Promise<Hex>;
  receipt: (hash: Hex) => Promise<SpendReceipt>;
  record: (r: SpendRecord) => void;
};

export type SpendStep = "deploy" | "browser" | "device" | "submit" | "mined";

const sameId = (a: Identity, b: Identity) => a.root.toLowerCase() === b.root.toLowerCase() && a.pubSeed.toLowerCase() === b.pubSeed.toLowerCase();

export async function runSpend(
  p: { stealth: Address; opener: Hex; spendKey: Hex; balance: bigint },
  to: Address,
  deps: SpendDeps,
  onStep: (step: SpendStep, detail: Record<string, unknown>) => void,
): Promise<{ txHash: Hex; receipt: SpendReceipt; deployTx: Hex | null; approval: TransferApproval; fee: bigint; signers: SpendRecord["signers"] }> {
  const amounts = spendAmounts(p.balance);
  if (!amounts) throw new Error("this payment doesn't cover the paymaster's fee");
  const approval: TransferApproval = {
    nonce: 0n,
    token: deps.token,
    to,
    amount: amounts.amount,
    maxFee: stealth.SPEND_MAX_FEE,
    validUntil: (await deps.headTime()) + 3600n,
  };
  const base = { stealth: p.stealth, to, amount: amounts.amount.toString(), fee: amounts.fee.toString(), validUntil: approval.validUntil.toString() };

  onStep("deploy", {});
  const deployed = await deps.deploy(stealth.commitment(p.spendKey, p.opener));
  if (deployed.address.toLowerCase() !== p.stealth.toLowerCase()) throw new Error(`the operator deployed ${deployed.address}, not this payment's account`);
  onStep("browser", { deployTx: deployed.txHash });

  const digest = transferApprovalDigest(deps.chainId, p.stealth, approval);
  const b = await deps.browserApprove(digest);
  const signers: SpendRecord["signers"] = [{ idx: 0, leaf: b.leaf, envelope: b.envelope }];
  onStep("device", { browserLeaf: b.leaf });

  let d: Awaited<ReturnType<SpendDeps["deviceSign"]>>;
  try {
    d = await deps.deviceSign({ chainId: deps.chainId, account: p.stealth, approval });
    if (!sameId(d.identity, deps.ids[1]!)) throw new Error("the device answered with another key than the one paired at setup");
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    deps.record({ ...base, signers, status: "failed", error });
    throw e instanceof Error ? e : new Error(error);
  }
  signers.push({ idx: 1, leaf: d.leaf, envelope: d.envelope });
  deps.record({ ...base, signers, status: "signed" });
  onStep("submit", { deviceLeaf: d.leaf });

  const frames = stealth.buildSpendFrames(
    { stealth: p.stealth, paymaster: deps.paymaster, token: deps.token, threshold: 2n, ids: deps.ids, opener: p.opener, approval, fee: amounts.fee, signers },
    deps.abi,
  );
  const tx = stealth.buildSpendTx(deps.chainId, p.stealth, await deps.nonceOf(p.stealth), frames);
  let txHash: Hex;
  try {
    txHash = await deps.submit(tx);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    deps.record({ ...base, signers, status: "failed", error });
    throw e instanceof Error ? e : new Error(error);
  }
  deps.record({ ...base, signers, txHash, status: "submitted" });
  onStep("mined", { txHash });

  const receipt = await deps.receipt(txHash);
  const ok = receipt.status === "0x1";
  deps.record({ ...base, signers, txHash, status: ok ? "mined" : "failed", ...(ok ? {} : { error: "the transaction failed on chain" }) });
  if (!ok) throw new Error("the transaction failed on chain");
  return { txHash, receipt, deployTx: deployed.txHash, approval, fee: amounts.fee, signers };
}
