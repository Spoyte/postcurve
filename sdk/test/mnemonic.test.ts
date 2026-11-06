import { describe, expect, test } from "bun:test";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { u256 } from "../src/hash";
import {
  InvalidMnemonicError,
  mnemonicFromSeed,
  newMnemonic,
  seedFromMnemonic,
} from "../src/mnemonic";

describe("mnemonic <-> seed", () => {
  test("seed -> words -> seed round-trips", () => {
    const seed = u256(0xabcdefn);
    const words = mnemonicFromSeed(seed);
    expect(words.split(" ")).toHaveLength(24);
    expect(Buffer.from(seedFromMnemonic(words)).equals(Buffer.from(seed))).toBe(true);
  });

  test("newMnemonic gives 24 valid words", () => {
    const words = newMnemonic();
    expect(words.split(" ")).toHaveLength(24);
    expect(seedFromMnemonic(words)).toHaveLength(32);
  });

  test("a word with a bad checksum throws InvalidMnemonicError", () => {
    const words = mnemonicFromSeed(u256(1n)).split(" ");
    const last = words[23]!;
    words[23] = wordlist.find((w) => w !== last)!; // first different word: breaks the checksum
    expect(() => seedFromMnemonic(words.join(" "))).toThrow(InvalidMnemonicError);
  });

  test("an unknown word throws InvalidMnemonicError", () => {
    const words = mnemonicFromSeed(u256(1n)).split(" ");
    words[3] = "notaword";
    expect(() => seedFromMnemonic(words.join(" "))).toThrow(InvalidMnemonicError);
  });

  test("a valid 12-word phrase is rejected (24 required)", () => {
    expect(() => seedFromMnemonic(generateMnemonic(wordlist, 128))).toThrow(InvalidMnemonicError);
  });

  test("tolerates extra spaces and capitals", () => {
    const seed = u256(42n);
    const typed = `  ${mnemonicFromSeed(seed).toUpperCase().split(" ").join("   ")}  `;
    expect(Buffer.from(seedFromMnemonic(typed)).equals(Buffer.from(seed))).toBe(true);
  });
});
