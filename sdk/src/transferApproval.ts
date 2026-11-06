// The v2 approval approvers sign for a stealth bunker spend: one token transfer plus a capped fee.
// See docs/design.md ("Approvers sign a transfer approval") and spec/stealth-profile.md.

import { hashTypedData, type Address, type Hex } from "viem";

export type TransferApproval = {
  /** Operation counter, so the same approval can't be replayed. */
  nonce: bigint;
  /** The token being spent (test USDC on the local devnet). */
  token: Address;
  /** Who receives `amount`. */
  to: Address;
  amount: bigint;
  /** Most the paymaster may take as its fee, in the same token. */
  maxFee: bigint;
  /** Unix time after which the approval is void. */
  validUntil: bigint;
};

export const TRANSFER_APPROVAL_TYPES = {
  TransferApproval: [
    { name: "nonce", type: "uint256" },
    { name: "token", type: "address" },
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "maxFee", type: "uint256" },
    { name: "validUntil", type: "uint64" },
  ],
} as const;

export function transferApprovalDigest(chainId: number, account: Address, a: TransferApproval): Hex {
  return hashTypedData({
    domain: { name: "postcurve", version: "2", chainId, verifyingContract: account },
    types: TRANSFER_APPROVAL_TYPES,
    primaryType: "TransferApproval",
    message: a,
  });
}
