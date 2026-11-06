import { describe, expect, test } from "bun:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { derivePubSeed, u256 } from "../src/hash";
import { digits, wotsPk, wotsPkFromSig, wotsSign } from "../src/wots";

const eq = (a: Uint8Array[], b: Uint8Array[]) =>
  a.length === b.length && a.every((w, i) => Buffer.from(w).equals(Buffer.from(b[i]!)));

describe("digits", () => {
  test("all-zero digest: 64 zeros then checksum 960 = [3, 12, 0]", () => {
    expect(digits(new Uint8Array(32))).toEqual([...Array(64).fill(0), 3, 12, 0]);
  });

  test("all-0xff digest: 64 fifteens then [0, 0, 0]", () => {
    expect(digits(new Uint8Array(32).fill(0xff))).toEqual([...Array(64).fill(15), 0, 0, 0]);
  });

  test("high nibble first", () => {
    const d = new Uint8Array(32);
    d[0] = 0x12;
    expect(digits(d).slice(0, 2)).toEqual([1, 2]);
  });

  test("rejects a 31-byte digest", () => {
    expect(() => digits(new Uint8Array(31))).toThrow();
  });
});

describe("WOTS sign / recover", () => {
  const seed = u256(1n);
  const pubSeed = derivePubSeed(seed);
  const leaf = 3;
  const d1 = keccak_256(new TextEncoder().encode("digest one"));
  const d2 = keccak_256(new TextEncoder().encode("digest two"));

  test("pkFromSig(sign(d)) equals pk", () => {
    const sig = wotsSign(seed, pubSeed, leaf, d1);
    expect(sig).toHaveLength(67);
    expect(eq(wotsPkFromSig(pubSeed, leaf, d1, sig), wotsPk(seed, pubSeed, leaf))).toBe(true);
  });

  test("a different digest yields a different pk", () => {
    const sig = wotsSign(seed, pubSeed, leaf, d1);
    expect(eq(wotsPkFromSig(pubSeed, leaf, d2, sig), wotsPk(seed, pubSeed, leaf))).toBe(false);
  });

  test("the same signature checked at another leaf yields a different pk", () => {
    const sig = wotsSign(seed, pubSeed, leaf, d1);
    expect(eq(wotsPkFromSig(pubSeed, leaf + 1, d1, sig), wotsPk(seed, pubSeed, leaf))).toBe(false);
  });

  test("rejects a 31-byte digest and a 66-element signature", () => {
    expect(() => wotsSign(seed, pubSeed, leaf, new Uint8Array(31))).toThrow();
    const sig = wotsSign(seed, pubSeed, leaf, d1);
    expect(() => wotsPkFromSig(pubSeed, leaf, d1, sig.slice(0, 66))).toThrow();
  });
});
