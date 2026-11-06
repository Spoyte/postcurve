// The request an approver is asked to sign: a transfer approval for one stealth account. Approvers
// (the device stand-in, the phone page, later the Firefly) show these fields and compute the digest
// themselves; they never sign a digest they were handed.

import { formatUnits, isAddress, type Address } from "viem";
import type { TransferApproval } from "./transferApproval";

export type SignRequest = { chainId: number; account: Address; approval: TransferApproval };

const UINT = /^(0|[1-9][0-9]*)$/;
const MAX_UINT64 = 2n ** 64n - 1n;
const MAX_UINT256 = 2n ** 256n - 1n;

function uint(v: unknown, name: string, max = MAX_UINT256): bigint {
  if (typeof v !== "string" || !UINT.test(v)) throw new Error(`${name} must be a decimal string`);
  const n = BigInt(v);
  if (n > max) throw new Error(`${name} is out of range`);
  return n;
}

function address(v: unknown, name: string): Address {
  if (typeof v !== "string" || !isAddress(v, { strict: false })) throw new Error(`${name} must be an address`);
  return v as Address;
}

/** Parses the JSON request (bigint fields as decimal strings). Throws on any missing or malformed field. */
export function parseSignRequest(body: unknown): SignRequest {
  if (typeof body !== "object" || body === null) throw new Error("request must be an object");
  const b = body as Record<string, unknown>;
  if (typeof b.chainId !== "number" || !Number.isSafeInteger(b.chainId) || b.chainId <= 0) {
    throw new Error("chainId must be a positive integer");
  }
  if (typeof b.approval !== "object" || b.approval === null) throw new Error("approval must be an object");
  const a = b.approval as Record<string, unknown>;
  return {
    chainId: b.chainId,
    account: address(b.account, "account"),
    approval: {
      nonce: uint(a.nonce, "approval.nonce"),
      token: address(a.token, "approval.token"),
      to: address(a.to, "approval.to"),
      amount: uint(a.amount, "approval.amount"),
      maxFee: uint(a.maxFee, "approval.maxFee"),
      validUntil: uint(a.validUntil, "approval.validUntil", MAX_UINT64),
    },
  };
}

/** The request as JSON, the inverse of parseSignRequest. */
export function signRequestJson(r: SignRequest) {
  const a = r.approval;
  return {
    chainId: r.chainId,
    account: r.account,
    approval: {
      nonce: a.nonce.toString(),
      token: a.token,
      to: a.to,
      amount: a.amount.toString(),
      maxFee: a.maxFee.toString(),
      validUntil: a.validUntil.toString(),
    },
  };
}

/** What an approver shows before asking for a decision (6 decimals: tUSDC). */
export function describeSignRequest(r: SignRequest): [label: string, value: string][] {
  const a = r.approval;
  return [
    ["chain", String(r.chainId)],
    ["from", `${r.account} (stealth account)`],
    ["token", a.token],
    ["pay", `${formatUnits(a.amount, 6)} to ${a.to}`],
    ["fee at most", formatUnits(a.maxFee, 6)],
    ["valid until", new Date(Number(a.validUntil) * 1000).toISOString()],
  ];
}
