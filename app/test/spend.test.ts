// The spend flow: amounts follow the paymaster's terms, and a device refusal sends nothing.
import { describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { stealth } from "@postcurve/sdk";
import { runSpend, spendAmounts, type SpendDeps } from "../src/lib/spend";
import type { SpendRecord } from "../src/lib/store";

describe("spendAmounts", () => {
  test("balance minus the 0.50 fee; nothing at or below the 1.00 max fee", () => {
    expect(spendAmounts(25_000_000n)).toEqual({ amount: 24_500_000n, fee: 500_000n });
    expect(spendAmounts(1_000_001n)).toEqual({ amount: 500_001n, fee: 500_000n });
    expect(spendAmounts(1_000_000n)).toBeNull();
    expect(spendAmounts(0n)).toBeNull();
  });
});

const ID = (n: number) => ({ root: `0x${n.toString(16).padStart(64, "0")}`, pubSeed: `0x${(n + 9).toString(16).padStart(64, "0")}` }) as const;
const IDS = [ID(1), ID(2), ID(3)];
const SPEND_KEY = stealth.spendKey(2, IDS);
const OPENER: Hex = `0x${"0a".repeat(32)}`;
const D: stealth.Deployment = {
  factory: "0x00000000000000000000000000000000000000f1",
  accountCreationCode: "0x6080",
  paymaster: "0x00000000000000000000000000000000000000a1",
  frameOps: "0x00000000000000000000000000000000000000a2",
};
const STEALTH = stealth.stealthAddress(stealth.commitment(SPEND_KEY, OPENER), D);

function fakeDeps(device: SpendDeps["deviceSign"]) {
  const records: SpendRecord[] = [];
  const submitted: unknown[] = [];
  const deps: SpendDeps = {
    chainId: 1337,
    paymaster: D.paymaster,
    token: "0x00000000000000000000000000000000000000b2",
    ids: IDS,
    abi: { paymaster: [], account: [], token: [] },
    headTime: async () => 1_800_000_000n,
    nonceOf: async () => 1n,
    deploy: async () => ({ address: STEALTH, txHash: null }),
    browserApprove: async () => ({ leaf: 3, envelope: "0xbeef" }),
    deviceSign: device,
    submit: async (tx) => {
      submitted.push(tx);
      return "0x01";
    },
    receipt: async () => ({ status: "0x1", blockNumber: "0x10", gasUsed: "0x1", frameReceipts: [] }),
    record: (r) => records.push(r),
  };
  return { deps, records, submitted };
}

describe("runSpend", () => {
  test("device refusal sends nothing", async () => {
    const { deps, records, submitted } = fakeDeps(async () => {
      throw new Error("refused on the device");
    });
    let message = "";
    try {
      await runSpend({ stealth: STEALTH, opener: OPENER, spendKey: SPEND_KEY, balance: 25_000_000n }, "0x00000000000000000000000000000000000000d4" as Address, deps, () => {});
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("refused on the device");
    expect(submitted).toEqual([]);
    const last = records.at(-1)!;
    expect(last.status).toBe("failed");
    expect(last.signers).toEqual([{ idx: 0, leaf: 3, envelope: "0xbeef" }]);
  });

  test("a device answering with another key is not used", async () => {
    const { deps, submitted } = fakeDeps(async () => ({ leaf: 0, envelope: "0x01", identity: ID(99) }));
    let message = "";
    try {
      await runSpend({ stealth: STEALTH, opener: OPENER, spendKey: SPEND_KEY, balance: 25_000_000n }, "0x00000000000000000000000000000000000000d4" as Address, deps, () => {});
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("another key");
    expect(submitted).toEqual([]);
  });

  test("an account the operator deploys at another address is not spent", async () => {
    const { deps, submitted } = fakeDeps(async () => ({ leaf: 0, envelope: "0x01", identity: ID(2) }));
    deps.deploy = async () => ({ address: "0x00000000000000000000000000000000000000ff", txHash: null });
    let message = "";
    try {
      await runSpend({ stealth: STEALTH, opener: OPENER, spendKey: SPEND_KEY, balance: 25_000_000n }, "0x00000000000000000000000000000000000000d4" as Address, deps, () => {});
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("deployed");
    expect(submitted).toEqual([]);
  });
});
