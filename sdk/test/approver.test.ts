import { beforeAll, describe, expect, test } from "bun:test";
import { keccak256, toHex, type Hex } from "viem";
import { Approver, TreeExhaustedError } from "../src/approver";
import { u256 } from "../src/hash";
import { verifyEnvelope } from "../src/xmss";

const seed = u256(7n);
const digest = (i: number): Hex => keccak256(toHex(`approval ${i}`));

describe("Approver", () => {
  let fresh: Approver;
  beforeAll(() => {
    fresh = Approver.fromSeed(seed);
  });

  test("two approvals use two different leaves and both verify", () => {
    const a = fresh.approve(digest(1));
    const b = fresh.approve(digest(2));
    expect(a.leaf).not.toBe(b.leaf);
    expect(verifyEnvelope(fresh.identity, digest(1), a.envelope)).toBe(a.leaf);
    expect(verifyEnvelope(fresh.identity, digest(2), b.envelope)).toBe(b.leaf);
    expect(fresh.usedLeaves()).toEqual([a.leaf, b.leaf].sort((x, y) => x - y));
  });

  test("restarting with used [0, 1, 5] never returns 0, 1 or 5", () => {
    const restarted = Approver.fromSeed(seed, [0, 1, 5]);
    const leaves = Array.from({ length: 6 }, (_, i) => restarted.approve(digest(10 + i)).leaf);
    expect(leaves).toEqual([2, 3, 4, 6, 7, 8]);
    expect(restarted.remaining()).toBe(256 - 9);
  });

  test("restarting with an out-of-range used leaf throws", () => {
    expect(() => Approver.fromSeed(seed, [300])).toThrow();
  });

  test("after 256 approvals, the next throws TreeExhaustedError", () => {
    const approver = Approver.fromSeed(seed);
    for (let i = 0; i < 256; i++) approver.approve(digest(100 + i));
    expect(approver.remaining()).toBe(0);
    expect(() => approver.approve(digest(999))).toThrow(TreeExhaustedError);
    expect(approver.usedLeaves()).toHaveLength(256);
  });

  test("identity matches across restarts from the same seed", () => {
    expect(Approver.fromSeed(seed, [3]).identity).toEqual(fresh.identity);
  });
});
