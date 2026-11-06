// The browser key lives in a Web Worker; the used-key record is written on the main thread before
// the worker produces a signature, and a failed write means no signature.
import { describe, expect, test } from "bun:test";
import { keccak256, toHex, type Hex } from "viem";
import { Approver } from "@postcurve/sdk";
import { BrowserKey, identityFromSeed } from "../src/lib/keys";

const SEED: Hex = `0x${"07".repeat(32)}`;
const digest = (s: string) => keccak256(toHex(s));

describe("BrowserKey", () => {
  test("approve persists before signing", async () => {
    const calls: number[][] = [];
    const key = await BrowserKey.open(SEED, [], (used) => calls.push(used));
    try {
      const a = await key.approve(digest("one"));
      expect(calls).toEqual([[0]]);
      expect(a.leaf).toBe(0);
      const b = await key.approve(digest("two"));
      expect(b.leaf).toBe(1);
      expect(calls).toEqual([[0], [0, 1]]);
      expect(key.identity).toEqual(Approver.fromSeed(new Uint8Array(32).fill(7)).identity);
    } finally {
      key.close();
    }
  }, 30_000);

  test("failed save produces no signature, and that key is never handed out again", async () => {
    let fail = true;
    const calls: number[][] = [];
    const key = await BrowserKey.open(SEED, [], (used) => {
      calls.push(used);
      if (fail) throw new Error("storage is full");
    });
    try {
      let refused = "";
      try {
        await key.approve(digest("one"));
      } catch (e) {
        refused = (e as Error).message;
      }
      expect(refused).toContain("storage is full");
      fail = false;
      const b = await key.approve(digest("two"));
      expect(b.leaf).toBe(1);
      expect(calls).toEqual([[0], [0, 1]]);
    } finally {
      key.close();
    }
  }, 30_000);

  test("opening with a used list continues after it", async () => {
    const key = await BrowserKey.open(SEED, [0, 1, 2], () => {});
    try {
      expect((await key.approve(digest("x"))).leaf).toBe(3);
    } finally {
      key.close();
    }
  }, 30_000);

  test("identityFromSeed equals the SDK's identity", async () => {
    expect(await identityFromSeed(SEED)).toEqual(Approver.fromSeed(new Uint8Array(32).fill(7)).identity);
  }, 30_000);
});
