// Replays pq-sap's commitment-format vectors (fixtures/README.md) through postcurve's generic
// derivation, with pq-sap's own domains (C13 and preimage), to show the profile follows pq-sap byte for byte.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { bytesToHex, hexToBytes, type Address, type Hex } from "viem";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import {
  decodeMetaAddress,
  deriveCommitment,
  deriveOpener,
  scanWith,
  stealthAddress,
  type Deployment,
  type Domains,
} from "../../src/stealth";

const v = JSON.parse(readFileSync(new URL("./fixtures/pq-sap-commit-vectors.json", import.meta.url), "utf8"));
const C13: Domains = { open: v.domains["sphincs-c13"].open, commit: v.domains["sphincs-c13"].commit };
const PREIMAGE: Domains = { open: v.domains.preimage.open, commit: v.domains.preimage.commit };
// Each recipient declares its profile: "preimage" recipients use pq-sap's preimage domains, the rest C13.
const domainsOf = (name: string): Domains => (v.recipients[name].scheme === "preimage" ? PREIMAGE : C13);
const dep: Deployment = {
  factory: v.deployment.factory as Address,
  accountCreationCode: v.deployment.creation_code as Hex,
  paymaster: v.deployment.verifier as Address,
  frameOps: v.deployment.frame_ctx as Address,
};

const recipientKeys = (name: string) => {
  const r = v.recipients[name];
  const seed = new Uint8Array([...hexToBytes(r.seeds.kem_d), ...hexToBytes(r.seeds.kem_z)]);
  return { r, keys: ml_kem768.keygen(seed) };
};

describe("pq-sap compatibility (C13 and preimage domains)", () => {
  test("ML-KEM keys from the recipient seeds match the published meta-address", () => {
    for (const name of Object.keys(v.recipients)) {
      const { r, keys } = recipientKeys(name);
      const meta = decodeMetaAddress(r.meta_address);
      expect(meta).not.toBeNull();
      expect(bytesToHex(meta!.ek)).toBe(bytesToHex(keys.publicKey));
      expect(meta!.spendKey).toBe(r.spend_key);
    }
  });

  const matching = v.cases.filter((c: { expect: string; name: string }) => c.expect === "match");
  test.each(matching.map((c: { name: string }) => [c.name, c]) as [string, any][])("%s: encapsulation, opener, commitment and address match", (_n: string, c: any) => {
    const { r, keys } = recipientKeys(c.recipient);
    const { cipherText, sharedSecret } = ml_kem768.encapsulate(keys.publicKey, hexToBytes(c.encaps_m));
    expect(bytesToHex(cipherText)).toBe(c.announcement.ephemeral_pub_key.toLowerCase());
    expect(bytesToHex(sharedSecret)).toBe(c.shared_secret);
    const op = deriveOpener(domainsOf(c.recipient), sharedSecret);
    expect(op).toBe(c.opener);
    const cm = deriveCommitment(domainsOf(c.recipient), r.spend_key, op);
    expect(cm).toBe(c.commitment);
    expect(stealthAddress(cm, dep).toLowerCase()).toBe(c.announcement.stealth_address.toLowerCase());
  });

  test.each(v.cases.map((c: { name: string }) => [c.name, c]) as [string, any][])("%s: scanning gives the expected verdict", (_n: string, c: any) => {
    const scanner = c.name.endsWith("seen-by-b") ? "b" : c.recipient;
    const { r, keys } = recipientKeys(scanner);
    const tag = Number(c.announcement.view_tag);
    const found = scanWith(domainsOf(scanner), keys.secretKey, r.spend_key, dep, {
      stealthAddress: c.announcement.stealth_address,
      ephemeralPubKey: c.announcement.ephemeral_pub_key,
      metadata: bytesToHex(new Uint8Array([tag])),
    });
    if (c.expect === "match") expect(found?.opener).toBe(c.opener);
    else expect(found).toBeNull();
  });
});
