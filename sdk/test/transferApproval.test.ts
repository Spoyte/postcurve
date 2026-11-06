import { describe, expect, test } from "bun:test";
import { hashTypedData, type Address } from "viem";
import { transferApprovalDigest, type TransferApproval } from "../src/transferApproval";

const account: Address = "0x00000000000000000000000000000000000000b0";
const a: TransferApproval = {
  nonce: 0n,
  token: "0x0000000000000000000000000000000000000c0c",
  to: "0x8943545177806ED17B9F23F0a21ee5948eCaa776",
  amount: 24_000_000n,
  maxFee: 1_000_000n,
  validUntil: 2_000_000_000n,
};

describe("transferApprovalDigest (v2)", () => {
  test("equals viem hashTypedData for the v2 type and domain", () => {
    expect(transferApprovalDigest(1337, account, a)).toBe(
      hashTypedData({
        domain: { name: "postcurve", version: "2", chainId: 1337, verifyingContract: account },
        types: {
          TransferApproval: [
            { name: "nonce", type: "uint256" },
            { name: "token", type: "address" },
            { name: "to", type: "address" },
            { name: "amount", type: "uint256" },
            { name: "maxFee", type: "uint256" },
            { name: "validUntil", type: "uint64" },
          ],
        },
        primaryType: "TransferApproval",
        message: a,
      }),
    );
  });

  test("every field and the domain change the digest", () => {
    const base = transferApprovalDigest(1337, account, a);
    const other: Address = "0x00000000000000000000000000000000000000b1";
    expect(transferApprovalDigest(1, account, a)).not.toBe(base);
    expect(transferApprovalDigest(1337, other, a)).not.toBe(base);
    for (const change of [
      { nonce: 1n },
      { token: other },
      { to: other },
      { amount: a.amount + 1n },
      { maxFee: a.maxFee + 1n },
      { validUntil: a.validUntil + 1n },
    ]) {
      expect(transferApprovalDigest(1337, account, { ...a, ...change })).not.toBe(base);
    }
  });
});
