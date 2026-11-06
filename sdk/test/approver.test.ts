import { beforeAll, describe, expect, test } from "bun:test";
import { keccak256, toHex, type Hex } from "viem";
import { Approver, TreeExhaustedError } from "../src/approver";
import { u256 } from "../src/hash";
import { verifyEnvelope } from "../src/xmss";

const seed = u256(7n);
const digest = (i: number): Hex => keccak256(toHex(`approval ${i}`));
const noSave = () => {};

describe("Approver", () => {
  let fresh: Approver;
  beforeAll(() => {
    fresh = Approver.fromSeed(seed);
  });

  test("two approvals use two different leaves and both verify", async () => {
    const a = await fresh.approve(digest(1), noSave);
    const b = await fresh.approve(digest(2), noSave);
    expect(a.leaf).not.toBe(b.leaf);
    expect(verifyEnvelope(fresh.identity, digest(1), a.envelope)).toBe(a.leaf);
    expect(verifyEnvelope(fresh.identity, digest(2), b.envelope)).toBe(b.leaf);
    expect(fresh.usedLeaves()).toEqual([a.leaf, b.leaf].sort((x, y) => x - y));
  });

  test("restarting with used [0, 1, 5] never returns 0, 1 or 5", async () => {
    const restarted = Approver.fromSeed(seed, [0, 1, 5]);
    const leaves: number[] = [];
    for (let i = 0; i < 6; i++) leaves.push((await restarted.approve(digest(10 + i), noSave)).leaf);
    expect(leaves).toEqual([2, 3, 4, 6, 7, 8]);
    expect(restarted.remaining()).toBe(256 - 9);
  });

  test("restarting with an out-of-range used leaf throws", () => {
    expect(() => Approver.fromSeed(seed, [300])).toThrow();
  });

  test("after 256 approvals, the next throws TreeExhaustedError", async () => {
    const approver = Approver.fromSeed(seed);
    for (let i = 0; i < 256; i++) await approver.approve(digest(100 + i), noSave);
    expect(approver.remaining()).toBe(0);
    expect(approver.approve(digest(999), noSave)).rejects.toThrow(TreeExhaustedError);
    expect(approver.usedLeaves()).toHaveLength(256);
  });

  test("identity matches across restarts from the same seed", () => {
    expect(Approver.fromSeed(seed, [3]).identity).toEqual(fresh.identity);
  });

  test("the used-leaf record is saved, including the new leaf, before the signature exists", async () => {
    const approver = Approver.fromSeed(seed, [0]);
    const saved: number[][] = [];
    const { leaf } = await approver.approve(digest(500), (used) => {
      saved.push(used);
    });
    expect(leaf).toBe(1);
    expect(saved).toEqual([[0, 1]]);
  });

  test("an async save is awaited before signing", async () => {
    const approver = Approver.fromSeed(seed);
    let saveFinished = false;
    const result = await approver.approve(digest(501), async () => {
      await new Promise((r) => setTimeout(r, 20));
      saveFinished = true;
    });
    expect(saveFinished).toBe(true);
    expect(verifyEnvelope(approver.identity, digest(501), result.envelope)).toBe(result.leaf);
  });

  test("if the save fails, no signature is returned and the leaf is never handed out again", async () => {
    const approver = Approver.fromSeed(seed);
    expect(
      approver.approve(digest(502), () => {
        throw new Error("disk full");
      }),
    ).rejects.toThrow("disk full");
    const next = await approver.approve(digest(503), noSave);
    expect(next.leaf).toBe(1);
  });
});
