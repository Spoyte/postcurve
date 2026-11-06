// TEST ONLY. Signs a digest with one of the fixed test approvers, at an explicit leaf, for Foundry
// tests (vm.ffi). It does not track used leaves, so it must never hold a real seed.
//
//   bun scripts/ffi-sign-fixture.ts <approver 1..3> <leaf 0..255> <digest 0x…32 bytes>
//
// Prints only the envelope hex, which forge decodes as bytes.

import { hexToBytes, keccak256, toHex, type Hex } from "viem";
import { buildTree, signEnvelope } from "../src/xmss";

const [who, leaf, digest] = process.argv.slice(2);
const index = Number(who);
if (![1, 2, 3].includes(index) || !leaf || !digest) {
  console.error("usage: ffi-sign-fixture.ts <approver 1..3> <leaf> <digest>");
  process.exit(1);
}
// Same seeds as spec/vectors/stealth-v0.json ("postcurve stealth test approver i").
const seed = hexToBytes(keccak256(toHex(`postcurve stealth test approver ${index}`)));
process.stdout.write(signEnvelope(seed, buildTree(seed), Number(leaf), digest as Hex));
