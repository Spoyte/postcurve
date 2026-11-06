import { describe, expect, test } from "bun:test";
import { encodeFunctionData, keccak256, parseAbi, toHex, type Address } from "viem";
import { getProfile } from "@forshtat/hegota-support/profiles";
import { frameMode } from "@forshtat/hegota-support/tx";
import { Approver } from "../../src/approver";
import {
  ATOMIC_BATCH,
  buildSpendFrames,
  buildSpendTx,
  identityHash,
  MAX_FEE_PER_GAS,
  SPEND_FEE,
  SPEND_MAX_FEE,
  type SpendParams,
} from "../../src/stealth/spendTx";
import { artifact } from "../../scripts/deploy-stealth";

const profile = getProfile("ethrex-eip8141-tracer");
const PAYMASTER: Address = "0x00000000000000000000000000000000000000a1";
const TOKEN: Address = "0x00000000000000000000000000000000000000b2";
const STEALTH: Address = "0x00000000000000000000000000000000000000c3";
const TO: Address = "0x00000000000000000000000000000000000000d4";
const abi = {
  paymaster: artifact("PostcurvePaymaster.sol", "PostcurvePaymaster").abi,
  account: artifact("StealthBunkerAccount.sol", "StealthBunkerAccount").abi,
  token: artifact("TestUSDC.sol", "TestUSDC").abi,
};
const expected = parseAbi([
  "function commit(bytes32[] idHashes, uint256[] leaves)",
  "function checkDeadline(uint64 validUntil)",
  "function transfer(address to, uint256 amount)",
]);

async function params(): Promise<SpendParams> {
  const seeds = [1, 2, 3].map((n) => new Uint8Array(32).fill(n));
  const [a, b, c] = seeds.map((s) => Approver.fromSeed(s));
  const digest = keccak256(toHex("fixed digest"));
  const sa = await a!.approve(digest, () => {});
  const sb = await b!.approve(digest, () => {});
  return {
    stealth: STEALTH,
    paymaster: PAYMASTER,
    token: TOKEN,
    threshold: 2n,
    ids: [a!.identity, b!.identity, c!.identity],
    opener: keccak256(toHex("opener")),
    approval: { nonce: 0n, token: TOKEN, to: TO, amount: 24_500_000n, maxFee: SPEND_MAX_FEE, validUntil: 1_800_000_000n },
    fee: SPEND_FEE,
    signers: [
      { idx: 0, leaf: sa.leaf, envelope: sa.envelope },
      { idx: 1, leaf: sb.leaf, envelope: sb.envelope },
    ],
  };
}

describe("spend transaction", () => {
  test("constants match the paymaster's terms", () => {
    expect(SPEND_FEE).toBe(500_000n);
    expect(SPEND_MAX_FEE).toBe(1_000_000n);
    expect(MAX_FEE_PER_GAS).toBe(2_000_000_000n);
    expect(ATOMIC_BATCH).toBe(0x04);
  });

  test("identityHash matches Solidity's keccak256(abi.encode(root, pubSeed))", () => {
    const id = {
      root: "0x3e736adafa549038692923528beed28fc068ed577e0b4eaa16ceb14531f82c48",
      pubSeed: "0x71fe8f7bfd21ec13c7b33d7cd2de50c0182766256f794c4c225e8217bf3bbd16",
    } as const;
    expect(identityHash(id)).toBe("0x4618373a298cc582ac94588505e22f87b2391046f39f780a0e129097566bd834");
  });

  test("six frames: modes, targets, data and the atomic batch", async () => {
    const p = await params();
    const frames = buildSpendFrames(p, abi);
    expect(frames.length).toBe(6);
    expect(frames.map((f) => f.mode)).toEqual(
      ["VERIFY", "VERIFY", "DEFAULT", "DEFAULT", "SENDER", "SENDER"].map((m) => frameMode(profile, m)),
    );
    expect(frames.map((f) => f.target)).toEqual([null, PAYMASTER, PAYMASTER, PAYMASTER, TOKEN, TOKEN]);
    expect(frames[2]!.data).toBe(
      encodeFunctionData({
        abi: expected,
        functionName: "commit",
        args: [[identityHash(p.ids[0]!), identityHash(p.ids[1]!)], [BigInt(p.signers[0]!.leaf), BigInt(p.signers[1]!.leaf)]],
      }),
    );
    expect(frames[3]!.data).toBe(encodeFunctionData({ abi: expected, functionName: "checkDeadline", args: [1_800_000_000n] }));
    expect(frames[4]!.data).toBe(encodeFunctionData({ abi: expected, functionName: "transfer", args: [TO, 24_500_000n] }));
    expect(frames[5]!.data).toBe(encodeFunctionData({ abi: expected, functionName: "transfer", args: [PAYMASTER, SPEND_FEE] }));
    const atomic = frames.map((f) => (f.flags & ATOMIC_BATCH) !== 0);
    expect(atomic).toEqual([false, false, false, true, true, false]);
    // the paymaster's floor for the commit frame
    expect(frames[2]!.limits.execution).toBeGreaterThanOrEqual(120_000n);
    expect(frames[2]!.limits.state).toBeGreaterThanOrEqual(300_000n);
    expect(frames.every((f) => f.value === 0n)).toBe(true);
  });

  test("buildSpendTx carries the nonce and the fixed max fee per gas", async () => {
    const frames = buildSpendFrames(await params(), abi);
    const tx = buildSpendTx(1337, STEALTH, 7n, frames);
    expect(tx.sender).toBe(STEALTH);
    expect(tx.frames).toEqual(frames);
    expect(tx.fees.maxFeePerGas).toBe(MAX_FEE_PER_GAS);
    expect(tx.nonceSeq).toBe(7n);
    expect(tx.chainId).toBe(1337n);
  });
});
