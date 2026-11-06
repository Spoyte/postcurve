// Browser storage: keys survive a devnet redeploy, payments don't.
import { beforeEach, describe, expect, test } from "bun:test";
import { readStore, resetAll, STORE_KEY, writeStore, type Stored } from "../src/lib/store";

class MemoryStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

const ID = { root: `0x${"11".repeat(32)}`, pubSeed: `0x${"22".repeat(32)}` } as const;

function full(deploymentId: string): Stored {
  return {
    deploymentId,
    browser: { seed: `0x${"33".repeat(32)}`, used: [0, 1] },
    identities: { browser: ID, device: ID, paper: ID },
    device: { kind: "bridge" },
    meta: { threshold: 2, spendKey: `0x${"44".repeat(32)}`, metaAddress: "0x02", ek: "0x01", dk: "0x02" },
    payments: [{ stealth: "0x00000000000000000000000000000000000000c3", opener: `0x${"55".repeat(32)}`, block: 7, amount: "25000000" }],
    spends: [{ stealth: "0x00000000000000000000000000000000000000c3", to: "0x00000000000000000000000000000000000000d4", amount: "24500000", fee: "500000", validUntil: "1", signers: [], status: "mined" }],
    seenAlerts: ["a1"],
  };
}

beforeEach(() => {
  (globalThis as any).localStorage = new MemoryStorage();
});

describe("store", () => {
  test("a fresh browser gets an empty store for this deployment", () => {
    const s = readStore("1337:0xaaa");
    expect(s.deploymentId).toBe("1337:0xaaa");
    expect(s.payments).toEqual([]);
    expect(s.spends).toEqual([]);
    expect(s.browser).toBeUndefined();
    expect(s.redeployed).toBeUndefined();
  });

  test("round trip", () => {
    writeStore(full("1337:0xaaa"));
    expect(readStore("1337:0xaaa")).toEqual(full("1337:0xaaa"));
  });

  test("an unparsable entry reads as empty", () => {
    localStorage.setItem(STORE_KEY, "{not json");
    expect(readStore("1337:0xaaa").payments).toEqual([]);
  });

  test("redeploy keeps used keys", () => {
    writeStore(full("1337:0xaaa"));
    const s = readStore("1337:0xbbb");
    const before = full("1337:0xaaa");
    expect(s.browser!.used).toEqual([0, 1]);
    expect(s.identities).toEqual(before.identities);
    expect(s.meta).toEqual(before.meta);
    expect(s.seenAlerts).toEqual(["a1"]);
    expect(s.payments).toEqual([]);
    expect(s.spends).toEqual([]);
    expect(s.redeployed).toBe(true);
    // the banner shows once: the next read is a normal read
    expect(readStore("1337:0xbbb").redeployed).toBeUndefined();
  });

  test("writeStore never persists the one-shot redeployed flag", () => {
    writeStore({ ...full("1337:0xaaa"), redeployed: true });
    expect(JSON.parse(localStorage.getItem(STORE_KEY)!).redeployed).toBeUndefined();
  });

  test("resetAll clears every postcurve entry and nothing else", () => {
    writeStore(full("1337:0xaaa"));
    localStorage.setItem("postcurve/bob", "x");
    localStorage.setItem("other-app", "keep");
    resetAll();
    expect(localStorage.getItem(STORE_KEY)).toBeNull();
    expect(localStorage.getItem("postcurve/bob")).toBeNull();
    expect(localStorage.getItem("other-app")).toBe("keep");
  });
});
