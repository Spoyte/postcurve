# Signature Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One hash-only signature format (WOTS one-time keys in an XMSS tree, signing an EIP-712
approval) implemented in TypeScript and verified in Solidity, with shared test vectors and a
measured gas cost.

**Architecture:** `spec/signature.md` is the normative format that every implementation follows
(TypeScript now, Solidity now, Firefly C firmware in a later plan). A TypeScript SDK in `sdk/`
generates keys, signs and verifies. `spec/vectors/` holds fixed test vectors produced by the SDK.
A Foundry project in `contracts/` holds the Solidity verifier library and tests it against those
vectors. This plan needs no chain.

**Tech Stack:** Bun 1.4.4 (`bun test`), TypeScript, `viem` (ABI encoding, EIP-712, keccak),
`@noble/hashes` (fast keccak), `@scure/bip39` (mnemonics); Foundry 1.7.1, solc 0.8.28, forge-std.

**Spec:** [docs/design.md](../design.md). Read it first.

## Global Constraints

- Hash: keccak256 only. Every hash input is a sequence of 32-byte words, laid out exactly as
  Solidity `abi.encode` lays out `uint256`/`bytes32` values (big-endian, no packing).
- WOTS: n = 32 bytes, w = 16, len1 = 64, len2 = 3, len = 67, chain positions 0..15.
- XMSS: tree height 8, 256 leaves, leaf indices 0..255.
- Domain tag (first word of every hash): SK = 1, PUBSEED = 2, CHAIN = 3, LEAF = 4, NODE = 5.
- Envelope = `abi.encode(uint256 leaf, bytes32[67] sig, bytes32[8] authPath)`, exactly 2432 bytes.
- Approver identity = `(bytes32 root, bytes32 pubSeed)`.
- Approver seed = 32 bytes = the BIP39 entropy of a 24-word English mnemonic.
- Approval digest = EIP-712 with domain `{ name: "postcurve", version: "1", chainId,
  verifyingContract: account }` and type
  `Approval(uint256 nonce,address to,uint256 value,bytes32 dataHash,uint256 maxFeeWei,uint64 validUntil)`,
  where `dataHash = keccak256(data)`.
- No lattice schemes. No mocks presented as real. No code copied from the May prototype.
- Commits: small Conventional Commits, authored as Spoyte (repo-local git config is already set),
  pushed to `origin` after each task.

## Review Focus

1. **One-time key reuse across restarts.** A caller that restarts with its saved used-leaf list
   must never get a used leaf back, and running out of leaves must fail loudly. Pinned in Task 4.
2. **Malformed envelopes from an untrusted submitter** (wrong length, leaf index ≥ 256, a valid
   leaf index swapped in) must return "invalid", never throw or revert with a panic. Pinned in
   Tasks 3 and 6.
3. **Drift between implementations** (nibble order, checksum, word layout). Pinned by the vectors
   in Task 5, which Task 6 consumes.
4. **Replay across chains or accounts.** The digest must change with chain id or account. Pinned
   in Task 4.
5. **Mistyped recovery words.** A wrong word or a 12-word phrase must be rejected, never turned
   into a different seed. Pinned in Task 4.

## File Structure

```
spec/signature.md              normative format (Task 1)
spec/vectors/wots-xmss-v1.json test vectors (Task 5)
sdk/package.json, tsconfig.json
sdk/src/params.ts              constants
sdk/src/hash.ts                word encoding and every keyed/tweaked hash
sdk/src/wots.ts                WOTS digits, keygen, sign, pk-from-sig
sdk/src/xmss.ts                tree, auth path, envelope codec, verify
sdk/src/mnemonic.ts            24-word mnemonic <-> 32-byte seed
sdk/src/approval.ts            EIP-712 approval digest
sdk/src/approver.ts            stateful signer that never reuses a leaf
sdk/src/index.ts               public exports
sdk/scripts/gen-vectors.ts     writes spec/vectors/wots-xmss-v1.json
sdk/test/*.test.ts
contracts/foundry.toml
contracts/src/WotsXmss.sol     verifier library
contracts/test/WotsXmss.t.sol  vector tests + gas measurement
```

---

### Task 1: Format spec and hash primitives

**Files:**
- Create: `spec/signature.md`, `sdk/package.json`, `sdk/tsconfig.json`, `sdk/src/params.ts`,
  `sdk/src/hash.ts`
- Test: `sdk/test/hash.test.ts`

**Interfaces:**
- Produces (`params.ts`): `N = 32`, `W = 16`, `LEN1 = 64`, `LEN2 = 3`, `LEN = 67`,
  `CHAIN_MAX = 15`, `TREE_HEIGHT = 8`, `LEAF_COUNT = 256`, `ENVELOPE_BYTES = 2432`,
  `DOMAIN = { SK: 1n, PUBSEED: 2n, CHAIN: 3n, LEAF: 4n, NODE: 5n }`.
- Produces (`hash.ts`), all returning 32-byte `Uint8Array`:
  - `u256(x: bigint | number): Uint8Array`
  - `hashWords(words: Uint8Array[]): Uint8Array`, which throws if any word isn't 32 bytes
  - `derivePubSeed(seed: Uint8Array): Uint8Array`
  - `deriveSk(seed: Uint8Array, leaf: number, chain: number): Uint8Array`
  - `chainStep(pubSeed: Uint8Array, leaf: number, chain: number, step: number, x: Uint8Array): Uint8Array`
  - `leafHash(pubSeed: Uint8Array, leaf: number, pk: Uint8Array[]): Uint8Array`
  - `nodeHash(pubSeed: Uint8Array, level: number, index: number, left: Uint8Array, right: Uint8Array): Uint8Array`

- [ ] **Step 1: Write `spec/signature.md`** with the parameters from Global Constraints, the
  envelope and identity layouts, the EIP-712 type, and this algorithm, verbatim:

```
word(x)             = 32-byte big-endian x
H(w1..wk)           = keccak256(w1 || ... || wk)                  every wi is 32 bytes

pubSeed             = H(word(2), seed)
sk[leaf][j]         = H(word(1), seed, word(leaf << 8 | j))                   j = 0..66
F(leaf, j, s, x)    = H(word(3), pubSeed, word(leaf << 16 | j << 8 | s), x)   s = 0..14
chain(x, leaf, j, start, steps): for s in start .. start+steps-1: x = F(leaf, j, s, x)

digits(d)           d = 32 bytes -> 64 nibbles, high nibble of each byte first;
                    csum = sum over the 64 nibbles of (15 - nibble)          0..960
                    append (csum >> 8) & 15, (csum >> 4) & 15, csum & 15     -> b[0..66]

pk[j]               = chain(sk[leaf][j], leaf, j, 0, 15)
sig[j]              = chain(sk[leaf][j], leaf, j, 0, b[j])
pkFromSig[j]        = chain(sig[j], leaf, j, b[j], 15 - b[j])

leafHash(leaf)      = H(word(4), pubSeed, word(leaf), pk[0], ..., pk[66])
node(lvl, i, l, r)  = H(word(5), pubSeed, word(lvl << 32 | i), l, r)        lvl = 1..8
levels[0][i]        = leafHash(i);  levels[k][i] = node(k, i, levels[k-1][2i], levels[k-1][2i+1])
root                = levels[8][0];  authPath[k] = sibling of the leaf's ancestor at level k

verify(root, pubSeed, digest, envelope):
  reject unless len(envelope) == 2432
  (leaf, sig[67], auth[8]) = abi.decode(envelope); reject unless leaf < 256
  node = leafHash computed from pkFromSig; i = leaf
  for k in 0..7: node = i even ? node(k+1, i>>1, node, auth[k]) : node(k+1, i>>1, auth[k], node); i >>= 1
  accept iff node == root
```

- [ ] **Step 2: Create `sdk/`** with `bun init`-style `package.json` (name `@postcurve/sdk`,
  `"type": "module"`, script `"test": "bun test"`), dependencies `viem`, `@noble/hashes`,
  `@scure/bip39`; strict `tsconfig.json`. Run: `cd sdk && bun install`. Expected: lockfile
  written, no errors.

- [ ] **Step 3: Write the failing tests** in `sdk/test/hash.test.ts`. Each function must equal
  `keccak256(encodeAbiParameters(...))` from viem for the same words:

```ts
test("chainStep matches abi.encode layout", () => {
  const ps = u256(7n), x = u256(9n);
  const expected = keccak256(encodeAbiParameters(
    parseAbiParameters("uint256,bytes32,uint256,bytes32"),
    [3n, toHex(ps), (5n << 16n) | (66n << 8n) | 14n, toHex(x)]));
  expect(toHex(chainStep(ps, 5, 66, 14, x))).toBe(expected);
});
// same pattern: derivePubSeed, deriveSk(seed, 255, 66), leafHash(ps, 255, 67 words),
// nodeHash(ps, 8, 0, l, r) with word (8n << 32n) | 0n
test("hashWords rejects a 31-byte word", () => {
  expect(() => hashWords([new Uint8Array(31)])).toThrow();
});
```

- [ ] **Step 4: Run** `cd sdk && bun test test/hash.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 5: Implement `params.ts` and `hash.ts`.** Use `keccak_256` from `@noble/hashes` over
  a concatenated `Uint8Array` (not viem's encoder; keygen calls this ~260k times).
- [ ] **Step 6: Run** `bun test test/hash.test.ts`. Expected: all PASS.
- [ ] **Step 7: Commit and push**

```bash
git add spec/signature.md sdk/package.json sdk/tsconfig.json sdk/bun.lock sdk/src/params.ts sdk/src/hash.ts sdk/test/hash.test.ts
git commit -m "feat(sdk): add signature format spec and hash primitives"
git push origin main
```

### Task 2: WOTS one-time signatures

**Files:**
- Create: `sdk/src/wots.ts`
- Test: `sdk/test/wots.test.ts`

**Interfaces:**
- Consumes: everything in `hash.ts` and `params.ts`.
- Produces:
  - `digits(digest: Uint8Array): number[]` returns 67 digits and throws unless the digest is 32 bytes.
  - `wotsPk(seed: Uint8Array, pubSeed: Uint8Array, leaf: number): Uint8Array[]`
  - `wotsSign(seed: Uint8Array, pubSeed: Uint8Array, leaf: number, digest: Uint8Array): Uint8Array[]`
  - `wotsPkFromSig(pubSeed: Uint8Array, leaf: number, digest: Uint8Array, sig: Uint8Array[]): Uint8Array[]`,
    which throws unless `sig.length === 67`.

- [ ] **Step 1: Write the failing tests:**

```ts
test("all-zero digest: 64 zeros then checksum 960 = [3, 12, 0]", () => {
  expect(digits(new Uint8Array(32))).toEqual([...Array(64).fill(0), 3, 12, 0]);
});
test("all-0xff digest: 64 fifteens then [0, 0, 0]", () => {
  expect(digits(new Uint8Array(32).fill(0xff))).toEqual([...Array(64).fill(15), 0, 0, 0]);
});
test("high nibble first", () => {
  const d = new Uint8Array(32); d[0] = 0x12;
  expect(digits(d).slice(0, 2)).toEqual([1, 2]);
});
test("pkFromSig(sign(d)) equals pk", () => { /* seed = u256(1n), leaf 3, random digest */ });
test("a different digest yields a different pk", () => { /* sign d1, recover with d2 */ });
test("rejects a 31-byte digest and a 66-element signature", () => { /* toThrow() */ });
```

- [ ] **Step 2: Run** `bun test test/wots.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `wots.ts`** following `spec/signature.md`.
- [ ] **Step 4: Run** `bun test test/wots.test.ts`. Expected: all PASS.
- [ ] **Step 5: Commit and push:** `feat(sdk): add WOTS one-time signatures`.

### Task 3: XMSS tree, envelope and verification

**Files:**
- Create: `sdk/src/xmss.ts`
- Test: `sdk/test/xmss.test.ts`

**Interfaces:**
- Consumes: `wots.ts`, `hash.ts`, `params.ts`.
- Produces:
  - `type Identity = { root: Hex; pubSeed: Hex }`
  - `type Tree = { pubSeed: Uint8Array; levels: Uint8Array[][] }`, where `levels[0]` has 256
    leaf hashes and `levels[8]` is `[root]`
  - `buildTree(seed: Uint8Array): Tree`
  - `identityOf(tree: Tree): Identity`
  - `authPath(tree: Tree, leaf: number): Uint8Array[]` returns 8 nodes.
  - `encodeEnvelope(leaf: number, sig: Uint8Array[], auth: Uint8Array[]): Hex`
  - `decodeEnvelope(envelope: Hex): { leaf: number; sig: Uint8Array[]; auth: Uint8Array[] } | null`
    returns `null` unless the envelope is exactly 2432 bytes and `leaf < 256`.
  - `signEnvelope(seed: Uint8Array, tree: Tree, leaf: number, digest: Hex): Hex`
  - `verifyEnvelope(id: Identity, digest: Hex, envelope: Hex): number | null` returns the leaf
    index, or `null`, and never throws on malformed input.

- [ ] **Step 1: Write the failing tests** (build one tree for seed `u256(1n)` in `beforeAll`):

```ts
test.each([0, 1, 254, 255])("leaf %i verifies and returns its index", (leaf) => {
  expect(verifyEnvelope(id, d, signEnvelope(seed, tree, leaf, d))).toBe(leaf);
});
test("wrong digest -> null", ...);            test("wrong root -> null", ...);
test("one flipped byte in sig -> null", ...); test("one flipped byte in auth path -> null", ...);
test("leaf word set to another valid index -> null", ...);
test("leaf word 256 -> null", ...);
test("2431 and 2433 bytes -> null, no throw", ...);
test("buildTree finishes in under 5 s", ...); // generous; real budget is the browser
```

- [ ] **Step 2: Run** `bun test test/xmss.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `xmss.ts`.** Use viem `encodeAbiParameters` / `decodeAbiParameters` with
  `uint256, bytes32[67], bytes32[8]` for the envelope; check length before decoding.
- [ ] **Step 4: Run** `bun test test/xmss.test.ts`. Expected: all PASS.
- [ ] **Step 5: Commit and push:** `feat(sdk): add XMSS tree, envelope codec and verification`.

### Task 4: Mnemonics, approval digest and a signer that never reuses a leaf

**Files:**
- Create: `sdk/src/mnemonic.ts`, `sdk/src/approval.ts`, `sdk/src/approver.ts`, `sdk/src/index.ts`
- Test: `sdk/test/mnemonic.test.ts`, `sdk/test/approval.test.ts`, `sdk/test/approver.test.ts`

**Interfaces:**
- Consumes: `xmss.ts`.
- Produces:
  - `newMnemonic(): string` returns 24 words.
  - `seedFromMnemonic(words: string): Uint8Array` returns 32 bytes and throws `InvalidMnemonicError`.
  - `mnemonicFromSeed(seed: Uint8Array): string`
  - `type Approval = { nonce: bigint; to: Address; value: bigint; data: Hex; maxFeeWei: bigint; validUntil: bigint }`
  - `approvalDigest(chainId: number, account: Address, a: Approval): Hex`
  - `class TreeExhaustedError extends Error`
  - `class Approver` with:
    - `static fromSeed(seed: Uint8Array, usedLeaves?: Iterable<number>): Approver`
    - `readonly identity: Identity`
    - `approve(digest: Hex): { leaf: number; envelope: Hex }`
    - `usedLeaves(): number[]`
    - `remaining(): number`
  - `index.ts` re-exports all of the above, plus `verifyEnvelope` and `Identity`.

- [ ] **Step 1: Write the failing tests:**

```ts
// mnemonic
test("seed -> words -> seed round-trips", ...);
test("a word with a bad checksum throws InvalidMnemonicError", ...);
test("a valid 12-word phrase is rejected (24 required)", ...);
// approval
test("digest equals viem hashTypedData", () => {
  expect(approvalDigest(1337, acct, a)).toBe(hashTypedData({
    domain: { name: "postcurve", version: "1", chainId: 1337, verifyingContract: acct },
    types: { Approval: [
      { name: "nonce", type: "uint256" }, { name: "to", type: "address" },
      { name: "value", type: "uint256" }, { name: "dataHash", type: "bytes32" },
      { name: "maxFeeWei", type: "uint256" }, { name: "validUntil", type: "uint64" }] },
    primaryType: "Approval",
    message: { ...a, dataHash: keccak256(a.data) } }));
});
test("changing chainId or account changes the digest", ...);
// approver
test("two approvals use two different leaves and both verify", ...);
test("restarting with used [0, 1, 5] never returns 0, 1 or 5", ...);
test("after 256 approvals, the next throws TreeExhaustedError", ...); // reuse one tree: slow test ok
```

- [ ] **Step 2: Run** `bun test`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** For `seedFromMnemonic`, use `@scure/bip39`'s `validateMnemonic` and
  `mnemonicToEntropy` with the English wordlist, and require 24 words. For the `Approver`:
  `approve` picks the lowest unused leaf and adds it to the used set **before** computing the
  signature. The caller persists `usedLeaves()`; persistence itself is out of scope here.
- [ ] **Step 4: Run** `bun test`. Expected: all PASS.
- [ ] **Step 5: Commit and push:** `feat(sdk): add mnemonics, EIP-712 approval digest and approver`.

### Task 5: Shared test vectors

**Files:**
- Create: `sdk/scripts/gen-vectors.ts`, `spec/vectors/wots-xmss-v1.json`
- Test: `sdk/test/vectors.test.ts`

**Interfaces:**
- Consumes: `index.ts`.
- Produces: the file `spec/vectors/wots-xmss-v1.json`, with this shape:

```json
{ "version": 1, "note": "TEST KEYS ONLY. Never use these seeds for funds.",
  "vectors": [ { "name": "A-leaf0", "seed": "0x…", "pubSeed": "0x…", "root": "0x…",
                 "leaf": 0, "digest": "0x…", "envelope": "0x…",
                 "approval": null } ] }
```

  It holds three vectors:
  - `A-leaf0`: seed `keccak256("postcurve test seed A")`, digest `keccak256("vector A0")`.
  - `A-leaf255`: the same seed, digest `keccak256("vector A255")`.
  - `B-leaf7-approval`: seed `keccak256("postcurve test seed B")`, leaf 7, signing the
    `approvalDigest` of `{ chainId: 1337, account: 0x00000000000000000000000000000000000000b0,
    nonce: 1, to: 0x8943545177806ED17B9F23F0a21ee5948eCaa776, value: 10^15, data: 0x,
    maxFeeWei: 10^16, validUntil: 2000000000 }`, with the approval fields stored in `approval`.

- [ ] **Step 1: Write the failing test.** Regenerating the vectors in memory must byte-equal the
  committed JSON, and every vector must pass `verifyEnvelope` with its own leaf index.
- [ ] **Step 2: Run** `bun test test/vectors.test.ts`. Expected: FAIL (file missing).
- [ ] **Step 3: Implement `gen-vectors.ts`** (exports `generateVectors()`; running it as a script
  writes the file). Run: `bun scripts/gen-vectors.ts`.
- [ ] **Step 4: Run** `bun test`. Expected: all PASS.
- [ ] **Step 5: Commit and push:** `test(spec): add shared WOTS/XMSS test vectors`.

### Task 6: Solidity verifier and measured gas

**Files:**
- Create: `contracts/foundry.toml`, `contracts/src/WotsXmss.sol`, `contracts/test/WotsXmss.t.sol`
- Modify: `docs/devnet-notes.md` (add a "Measured" section), `README.md` (status row for the signature core)

**Interfaces:**
- Consumes: `spec/vectors/wots-xmss-v1.json`.
- Produces:
  `library WotsXmss { struct Identity { bytes32 root; bytes32 pubSeed; } function verify(Identity memory id, bytes32 digest, bytes calldata envelope) internal pure returns (bool ok, uint256 leaf); }`.
  It returns `(false, 0)` on any malformed input and never reverts.

- [ ] **Step 1: Set up Foundry.** In `contracts/`, write `foundry.toml` with
  `solc_version = "0.8.28"`, `optimizer = true`, `optimizer_runs = 1000`,
  `fs_permissions = [{ access = "read", path = "../spec/vectors" }]`. Then run
  `forge install foundry-rs/forge-std` (added as a git submodule under `contracts/lib/`).
- [ ] **Step 2: Write the failing tests** in `WotsXmss.t.sol`. Use a small harness contract that
  exposes `verify` with a calldata envelope, and read vectors with `vm.readFile` and `vm.parseJson*`:
  - `test_vectorA0_verifies`: `ok == true` and `leaf == 0`.
  - `test_vectorA255_verifies`, `test_vectorB7_verifies`.
  - `test_wrongDigest_fails`, `test_wrongRoot_fails`, `test_flippedSigByte_fails`.
  - `test_leaf256_fails` (first word set to 256).
  - `test_shortEnvelope_fails` (2431 bytes), `test_longEnvelope_fails` (2433 bytes).
  - `test_gas_oneApproval` and `test_gas_twoApprovals`: measure `gasleft()` around the harness
    calls and `console.log` the totals.
- [ ] **Step 3: Run** `cd contracts && forge test`. Expected: FAIL (library missing).
- [ ] **Step 4: Implement `WotsXmss.sol`** following `spec/signature.md`. Check the envelope length
  before decoding. Plain Solidity, no assembly: this task measures, and the measured figure
  decides later whether optimizing is worth it.
- [ ] **Step 5: Run** `forge test -vv`. Expected: all PASS, with gas figures printed.
- [ ] **Step 6: Record** the two gas figures in `docs/devnet-notes.md` under "Measured", next to the
  canonical 100,000 cap. Add a first row to the README "Parts" table: Signature core, "Hash-only
  WOTS/XMSS approvals shared by browser, contract and Firefly", status "done (TS + Solidity)".
- [ ] **Step 7: Commit and push:** `feat(contracts): add WOTS/XMSS verifier with vector tests`.
