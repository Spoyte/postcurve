// The ML-KEM-768 viewing key, derived from the paper recovery seed so the paper backup restores
// scanning too. See spec/stealth-profile.md, "Viewing key".

import { keccak_256 } from "@noble/hashes/sha3.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { PROFILE } from "./profile";

export function viewKeyFromSeed(paperSeed: Uint8Array): { ek: Uint8Array; dk: Uint8Array } {
  if (paperSeed.length !== 32) throw new RangeError(`paper seed is ${paperSeed.length} bytes, expected 32`);
  const domain = new TextEncoder().encode(PROFILE.viewKeyDomain);
  const part = (tag: number) => keccak_256(new Uint8Array([...domain, tag, ...paperSeed]));
  const { publicKey, secretKey } = ml_kem768.keygen(new Uint8Array([...part(0x01), ...part(0x02)]));
  return { ek: publicKey, dk: secretKey };
}
