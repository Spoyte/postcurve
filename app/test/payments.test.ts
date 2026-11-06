// Scanning: only announcements that pay this recipient are found, in block order.
import { describe, expect, test } from "bun:test";
import { toHex, type Hex } from "viem";
import { stealth } from "@postcurve/sdk";
import { findMine, mergePayments, type Ann } from "../src/lib/payments";

const D: stealth.Deployment = {
  factory: "0x00000000000000000000000000000000000000f1",
  accountCreationCode: "0x6080604052",
  paymaster: "0x00000000000000000000000000000000000000a1",
  frameOps: "0x00000000000000000000000000000000000000a2",
};
const id = (n: number) => ({ root: toHex(n, { size: 32 }), pubSeed: toHex(n + 100, { size: 32 }) });

function recipient(seedByte: number) {
  const { ek, dk } = stealth.viewKeyFromSeed(new Uint8Array(32).fill(seedByte));
  const spendKey = stealth.spendKey(2, [id(seedByte), id(seedByte + 1), id(seedByte + 2)]);
  return { dk, spendKey, meta: stealth.encodeMetaAddress(spendKey, ek) };
}

function announce(meta: Hex, block: number): Ann {
  const s = stealth.send(meta, D);
  return { stealthAddress: s.address, ephemeralPubKey: s.ephemeralPubKey, metadata: toHex(new Uint8Array([s.viewTag])), block };
}

describe("findMine", () => {
  test("finds exactly the recipient's payments, in block order", () => {
    const alice = recipient(1);
    const carol = recipient(50);
    const a1 = announce(alice.meta, 30);
    const a2 = announce(alice.meta, 12);
    const c1 = announce(carol.meta, 20);
    const junk: Ann = { stealthAddress: "0x00000000000000000000000000000000000000ee", ephemeralPubKey: "0x00112233445566778899", metadata: "0x01", block: 5 };
    const found = findMine([a1, c1, junk, a2], alice.dk, alice.spendKey, D);
    expect(found.map((f) => f.stealth)).toEqual([a2.stealthAddress, a1.stealthAddress]);
    expect(found.map((f) => f.block)).toEqual([12, 30]);
    expect(found[0]!.opener).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("nothing to find", () => {
    const alice = recipient(1);
    expect(findMine([], alice.dk, alice.spendKey, D)).toEqual([]);
  });
});

describe("mergePayments", () => {
  test("never stores the same stealth address twice, whatever the case, and keeps the first record", () => {
    const a = { stealth: "0x868f00dE60d46a163314fE4F4197B79341f7EA98", opener: `0x${"01".repeat(32)}`, block: 7, amount: "25000000" } as const;
    const b = { ...a, stealth: a.stealth.toLowerCase() as `0x${string}`, amount: "1" } as const;
    const c = { ...a, stealth: "0x00000000000000000000000000000000000000c3", block: 9 } as const;
    expect(mergePayments([a], [b, c])).toEqual([a, c]);
    expect(mergePayments([a, b], [])).toEqual([a]);
  });
});
