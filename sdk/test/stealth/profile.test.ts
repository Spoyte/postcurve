import { describe, expect, test } from "bun:test";
import { bytesToHex, hexToBytes, keccak256, toHex, type Address, type Hex } from "viem";
import { u256 } from "../../src/hash";
import type { Identity } from "../../src/xmss";
import {
  decodeMetaAddress,
  encodeMetaAddress,
  PROFILE,
  scan,
  send,
  spendKey,
  viewKeyFromSeed,
  type Deployment,
} from "../../src/stealth";

const id = (i: number): Identity => ({ root: keccak256(toHex(`root ${i}`)), pubSeed: keccak256(toHex(`seed ${i}`)) });
const ids = [id(1), id(2), id(3)];
const dep: Deployment = {
  factory: "0x00000000000000000000000000000000000000f1",
  accountCreationCode: "0x60806040526001600055",
  paymaster: "0x00000000000000000000000000000000000000a1",
  frameOps: "0x00000000000000000000000000000000000000c1",
};
const paper = u256(0x9a9e7n);

function setup() {
  const { ek, dk } = viewKeyFromSeed(paper);
  const sk = spendKey(2, ids);
  return { ek, dk, sk, meta: encodeMetaAddress(sk, ek) };
}

function flip(h: Hex, byteIndex: number): Hex {
  const b = hexToBytes(h);
  b[byteIndex]! ^= 0x01;
  return bytesToHex(b);
}

describe("postcurve stealth profile", () => {
  test("profile constants", () => {
    expect(PROFILE.name).toBe("postcurve-wots-xmss-quorum/v0");
    expect(PROFILE.domains.open).toBe("postcurve/wots-xmss-quorum/open/v0");
    expect(PROFILE.domains.commit).toBe("postcurve/wots-xmss-quorum/commit/v0");
    expect(PROFILE.keyDomain).toBe("postcurve/quorum/key/v0");
    expect(PROFILE.viewKeyDomain).toBe("postcurve/view-key/v0");
  });

  test("viewKeyFromSeed is deterministic and seed-dependent", () => {
    const a = viewKeyFromSeed(paper);
    const b = viewKeyFromSeed(paper);
    expect(bytesToHex(a.ek)).toBe(bytesToHex(b.ek));
    expect(a.ek).toHaveLength(1184);
    expect(bytesToHex(viewKeyFromSeed(u256(1n)).ek)).not.toBe(bytesToHex(a.ek));
  });

  test("meta-address is 1,217 bytes and round-trips", () => {
    const { meta, sk, ek } = setup();
    expect(hexToBytes(meta)).toHaveLength(1217);
    const back = decodeMetaAddress(meta)!;
    expect(back.spendKey).toBe(sk);
    expect(bytesToHex(back.ek)).toBe(bytesToHex(ek));
  });

  test("decodeMetaAddress rejects a wrong length or version byte", () => {
    const { meta } = setup();
    expect(decodeMetaAddress(bytesToHex(hexToBytes(meta).slice(0, 1216)))).toBeNull();
    const v1 = hexToBytes(meta);
    v1[0] = 0x01;
    expect(decodeMetaAddress(bytesToHex(v1))).toBeNull();
  });

  test("send -> scan round-trips: address matches and opener equals the sender's", () => {
    const { meta, dk, sk } = setup();
    const s = send(meta, dep);
    const found = scan(dk, sk, dep, {
      stealthAddress: s.address,
      ephemeralPubKey: s.ephemeralPubKey,
      metadata: bytesToHex(new Uint8Array([s.viewTag])),
    });
    expect(found?.opener).toBe(s.opener);
  });

  test("scan returns null for a wrong dk, a flipped ciphertext, a wrong tag or a tampered address", () => {
    const { meta, dk, sk } = setup();
    const s = send(meta, dep);
    const ann = { stealthAddress: s.address, ephemeralPubKey: s.ephemeralPubKey, metadata: bytesToHex(new Uint8Array([s.viewTag])) };
    expect(scan(viewKeyFromSeed(u256(2n)).dk, sk, dep, ann)).toBeNull();
    expect(scan(dk, sk, dep, { ...ann, ephemeralPubKey: flip(ann.ephemeralPubKey, 10) })).toBeNull();
    expect(scan(dk, sk, dep, { ...ann, metadata: bytesToHex(new Uint8Array([(s.viewTag + 1) % 256])) })).toBeNull();
    expect(scan(dk, sk, dep, { ...ann, stealthAddress: flip(ann.stealthAddress, 19) as Address })).toBeNull();
  });

  test("two sends to the same meta-address give different addresses", () => {
    const { meta } = setup();
    expect(send(meta, dep).address).not.toBe(send(meta, dep).address);
  });

  test("spendKey changes with the threshold, a root, or the identity order", () => {
    const base = spendKey(2, ids);
    expect(spendKey(3, ids)).not.toBe(base);
    expect(spendKey(2, [{ ...ids[0]!, root: keccak256("0x01") }, ids[1]!, ids[2]!])).not.toBe(base);
    expect(spendKey(2, [ids[1]!, ids[0]!, ids[2]!])).not.toBe(base);
  });
});
