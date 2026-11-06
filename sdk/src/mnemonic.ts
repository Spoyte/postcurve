// 24-word English BIP39 mnemonic <-> 32-byte approver seed (the mnemonic's entropy).

import {
  entropyToMnemonic,
  generateMnemonic,
  mnemonicToEntropy,
  validateMnemonic,
} from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

export class InvalidMnemonicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMnemonicError";
  }
}

export function newMnemonic(): string {
  return generateMnemonic(wordlist, 256);
}

export function mnemonicFromSeed(seed: Uint8Array): string {
  if (seed.length !== 32) throw new RangeError(`seed is ${seed.length} bytes, expected 32`);
  return entropyToMnemonic(seed, wordlist);
}

/** Accepts extra whitespace and capitals; rejects anything that isn't 24 valid words. */
export function seedFromMnemonic(words: string): Uint8Array {
  const normalized = words.trim().toLowerCase().split(/\s+/).join(" ");
  const count = normalized === "" ? 0 : normalized.split(" ").length;
  if (count !== 24) throw new InvalidMnemonicError(`expected 24 words, got ${count}`);
  if (!validateMnemonic(normalized, wordlist)) {
    throw new InvalidMnemonicError("unknown word or bad checksum: check each word against your backup");
  }
  return mnemonicToEntropy(normalized, wordlist);
}
