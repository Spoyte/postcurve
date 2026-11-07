// The phone approver signs the digest it computes from the request's fields, never one it was handed.
import { describe, expect, test } from "bun:test";
import type { Hex } from "viem";
import { transferApprovalDigest } from "@postcurve/sdk";
import { approveOnPhone } from "../src/lib/device";

const request = {
  chainId: 1337,
  account: "0x00000000000000000000000000000000000000b0",
  approval: { nonce: "0", token: "0x0000000000000000000000000000000000000c0c", to: "0x8943545177806ED17B9F23F0a21ee5948eCaa776", amount: "24000000", maxFee: "1000000", validUntil: "2000000000" },
  digest: `0x${"ee".repeat(32)}`,
};

describe("approveOnPhone", () => {
  test("signs the digest computed from the fields, ignoring a digest in the request", async () => {
    const signed: Hex[] = [];
    const key = { identity: { root: `0x${"11".repeat(32)}`, pubSeed: `0x${"22".repeat(32)}` } as const, approve: async (d: Hex) => (signed.push(d), { leaf: 4, envelope: "0xab" as Hex }) };
    const out = await approveOnPhone(request, key);
    const expected = transferApprovalDigest(1337, request.account as Hex, {
      nonce: 0n,
      token: request.approval.token as Hex,
      to: request.approval.to as Hex,
      amount: 24_000_000n,
      maxFee: 1_000_000n,
      validUntil: 2_000_000_000n,
    });
    expect(signed).toEqual([expected]);
    expect(out).toEqual({ leaf: 4, envelope: "0xab", identity: key.identity });
  });

  test("a malformed request is never signed", async () => {
    const signed: Hex[] = [];
    const key = { identity: { root: "0x00", pubSeed: "0x00" } as any, approve: async (d: Hex) => (signed.push(d), { leaf: 0, envelope: "0x" as Hex }) };
    let threw = false;
    try {
      await approveOnPhone({ chainId: 1337 }, key);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(signed).toEqual([]);
  });
});
