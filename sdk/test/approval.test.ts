import { describe, expect, test } from "bun:test";
import { hashTypedData, keccak256, type Address } from "viem";
import { approvalDigest, type Approval } from "../src/approval";

const acct: Address = "0x00000000000000000000000000000000000000b0";
const a: Approval = {
  nonce: 1n,
  to: "0x8943545177806ED17B9F23F0a21ee5948eCaa776",
  value: 10n ** 15n,
  data: "0xa9059cbb",
  maxFeeWei: 10n ** 16n,
  validUntil: 2_000_000_000n,
};

describe("approvalDigest", () => {
  test("digest equals viem hashTypedData", () => {
    expect(approvalDigest(1337, acct, a)).toBe(
      hashTypedData({
        domain: { name: "postcurve", version: "1", chainId: 1337, verifyingContract: acct },
        types: {
          Approval: [
            { name: "nonce", type: "uint256" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "dataHash", type: "bytes32" },
            { name: "maxFeeWei", type: "uint256" },
            { name: "validUntil", type: "uint64" },
          ],
        },
        primaryType: "Approval",
        message: { ...a, dataHash: keccak256(a.data) },
      }),
    );
  });

  test("changing chainId or account changes the digest", () => {
    const base = approvalDigest(1337, acct, a);
    expect(approvalDigest(1, acct, a)).not.toBe(base);
    expect(approvalDigest(1337, "0x00000000000000000000000000000000000000b1", a)).not.toBe(base);
  });

  test("changing the calldata or the fee cap changes the digest", () => {
    const base = approvalDigest(1337, acct, a);
    expect(approvalDigest(1337, acct, { ...a, data: "0xa9059cbc" })).not.toBe(base);
    expect(approvalDigest(1337, acct, { ...a, maxFeeWei: a.maxFeeWei + 1n })).not.toBe(base);
  });
});
