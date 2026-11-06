// The software stand-in device approver: it signs only after a typed "y", and records the used
// one-time key before printing a signature.
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyEnvelope } from "../src/xmss";
import { transferApprovalDigest } from "../src/transferApproval";

const SCRIPT = join(import.meta.dir, "../scripts/device-signer.ts");
const request = {
  chainId: 1337,
  account: "0x00000000000000000000000000000000000000b0",
  approval: {
    nonce: "0",
    token: "0x0000000000000000000000000000000000000c0c",
    to: "0x8943545177806ED17B9F23F0a21ee5948eCaa776",
    amount: "24000000",
    maxFee: "1000000",
    validUntil: "2000000000",
  },
};

function run(dir: string, args: string[], stdin = "") {
  const p = Bun.spawnSync(["bun", SCRIPT, "--dir", dir, ...args], { stdin: new TextEncoder().encode(stdin) });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe("device signer CLI", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "postcurve-device-"));
    expect(run(dir, ["init"]).code).toBe(0);
  });

  test("init writes a private seed file and an empty used-key record", () => {
    expect(statSync(join(dir, "seed.json")).mode & 0o077).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "used-leaves.json"), "utf8"))).toEqual([]);
  });

  test("answering n prints no signature and leaves the record unchanged", () => {
    const r = run(dir, ["sign", JSON.stringify(request)], "n\n");
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain("envelope");
    expect(JSON.parse(readFileSync(join(dir, "used-leaves.json"), "utf8"))).toEqual([]);
  });

  test("answering y prints a valid envelope and records its leaf", () => {
    const id = JSON.parse(run(dir, ["identity"]).out);
    const r = run(dir, ["sign", JSON.stringify(request)], "y\n");
    expect(r.code).toBe(0);
    const { leaf, envelope } = JSON.parse(r.out.trim().split("\n").at(-1)!);
    const a = request.approval;
    const digest = transferApprovalDigest(request.chainId, request.account as `0x${string}`, {
      nonce: BigInt(a.nonce),
      token: a.token as `0x${string}`,
      to: a.to as `0x${string}`,
      amount: BigInt(a.amount),
      maxFee: BigInt(a.maxFee),
      validUntil: BigInt(a.validUntil),
    });
    expect(verifyEnvelope(id, digest, envelope)).toBe(leaf);
    expect(JSON.parse(readFileSync(join(dir, "used-leaves.json"), "utf8"))).toContain(leaf);
    expect(r.err).toContain("software approver");
  });
});
