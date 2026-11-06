// The EIP-712 approval every approver signs. See spec/signature.md, "What gets signed".

import { hashTypedData, keccak256, type Address, type Hex } from "viem";

export type Approval = {
  /** The bunker account's operation counter. */
  nonce: bigint;
  to: Address;
  value: bigint;
  /** Calldata the account sends to `to`; signed as keccak256(data). */
  data: Hex;
  /** Most the account will pay in gas fees for this operation. */
  maxFeeWei: bigint;
  /** Unix time after which the approval is void. */
  validUntil: bigint;
};

export const APPROVAL_TYPES = {
  Approval: [
    { name: "nonce", type: "uint256" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "dataHash", type: "bytes32" },
    { name: "maxFeeWei", type: "uint256" },
    { name: "validUntil", type: "uint64" },
  ],
} as const;

export function approvalDigest(chainId: number, account: Address, a: Approval): Hex {
  return hashTypedData({
    domain: { name: "postcurve", version: "1", chainId, verifyingContract: account },
    types: APPROVAL_TYPES,
    primaryType: "Approval",
    message: {
      nonce: a.nonce,
      to: a.to,
      value: a.value,
      dataHash: keccak256(a.data),
      maxFeeWei: a.maxFeeWei,
      validUntil: a.validUntil,
    },
  });
}
