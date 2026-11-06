import { describe, expect, test } from "bun:test";
import { encodeAbiParameters, keccak256, parseAbiParameters, toHex } from "viem";
import {
  chainStep,
  derivePubSeed,
  deriveSk,
  hashWords,
  leafHash,
  nodeHash,
  u256,
} from "../src/hash";

// Reference: the same words hashed through viem's abi.encode, which is what Solidity does.
const ref = (types: string, values: readonly unknown[]) =>
  keccak256(encodeAbiParameters(parseAbiParameters(types), values as never));

describe("hash primitives match the abi.encode layout", () => {
  const seed = u256(0x5eedn);
  const ps = u256(7n);

  test("u256 is 32-byte big-endian", () => {
    expect(toHex(u256(1n))).toBe(`0x${"00".repeat(31)}01`);
    expect(toHex(u256(0x1234))).toBe(`0x${"00".repeat(30)}1234`);
  });

  test("derivePubSeed", () => {
    expect(toHex(derivePubSeed(seed))).toBe(ref("uint256,bytes32", [2n, toHex(seed)]));
  });

  test("deriveSk(seed, 255, 66)", () => {
    expect(toHex(deriveSk(seed, 255, 66))).toBe(
      ref("uint256,bytes32,uint256", [1n, toHex(seed), (255n << 8n) | 66n]),
    );
  });

  test("chainStep matches abi.encode layout", () => {
    const x = u256(9n);
    const expected = ref("uint256,bytes32,uint256,bytes32", [
      3n,
      toHex(ps),
      (5n << 16n) | (66n << 8n) | 14n,
      toHex(x),
    ]);
    expect(toHex(chainStep(ps, 5, 66, 14, x))).toBe(expected);
  });

  test("leafHash(ps, 255, 67 words)", () => {
    const pk = Array.from({ length: 67 }, (_, i) => u256(BigInt(i) + 100n));
    const expected = ref("uint256,bytes32,uint256,bytes32[67]", [
      4n,
      toHex(ps),
      255n,
      pk.map((w) => toHex(w)),
    ]);
    expect(toHex(leafHash(ps, 255, pk))).toBe(expected);
  });

  test("nodeHash(ps, 8, 0, l, r)", () => {
    const l = u256(11n);
    const r = u256(12n);
    const expected = ref("uint256,bytes32,uint256,bytes32,bytes32", [
      5n,
      toHex(ps),
      (8n << 32n) | 0n,
      toHex(l),
      toHex(r),
    ]);
    expect(toHex(nodeHash(ps, 8, 0, l, r))).toBe(expected);
  });

  test("nodeHash puts the level above the index", () => {
    const l = u256(11n);
    const r = u256(12n);
    const expected = ref("uint256,bytes32,uint256,bytes32,bytes32", [
      5n,
      toHex(ps),
      (3n << 32n) | 5n,
      toHex(l),
      toHex(r),
    ]);
    expect(toHex(nodeHash(ps, 3, 5, l, r))).toBe(expected);
  });

  test("hashWords rejects a 31-byte word", () => {
    expect(() => hashWords([new Uint8Array(31)])).toThrow();
  });

  test("leafHash rejects a public key that isn't 67 words", () => {
    expect(() => leafHash(ps, 0, [u256(1n)])).toThrow();
  });
});
