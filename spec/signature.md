# postcurve signature format, v1

The single hash-only signature format used by every postcurve approver: the browser
(TypeScript, `sdk/`), the bunker account (Solidity, `contracts/`) and the Firefly approver
device (C firmware). All three must produce and accept exactly the same bytes. Test vectors:
[vectors/wots-xmss-v1.json](vectors/wots-xmss-v1.json).

Design rationale: [../docs/design.md](../docs/design.md).

## Parameters

| Name | Value | Meaning |
|---|---|---|
| Hash | keccak256 | the only primitive; no elliptic curves, no lattices |
| n | 32 bytes | hash output and word size |
| w | 16 | Winternitz parameter (4 bits per digit) |
| len1 | 64 | message digits (32-byte digest = 64 nibbles) |
| len2 | 3 | checksum digits |
| len | 67 | WOTS chains per one-time key |
| chain positions | 0..15 | 15 hash steps from secret to public end |
| tree height | 8 | XMSS tree of one-time keys |
| leaves | 256 | one-time keys per approver, indices 0..255 |

Domain tags (the first word of every hash): SK = 1, PUBSEED = 2, CHAIN = 3, LEAF = 4, NODE = 5.

## Encoding rule

Every hash input is a sequence of 32-byte words, laid out exactly as Solidity `abi.encode`
lays out `uint256` and `bytes32` values: big-endian, each value padded to 32 bytes, no packing.

## Algorithm

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

## Layouts

**Seed.** 32 bytes: the BIP39 entropy of a 24-word English mnemonic. That mnemonic is the
approver's backup.

**Identity.** What the bunker account stores per approver: `(bytes32 root, bytes32 pubSeed)`.

**Envelope.** One approver's signature on one digest, exactly 2432 bytes:

```
abi.encode(uint256 leaf, bytes32[67] sig, bytes32[8] authPath)
```

Anything of a different length, or with `leaf >= 256`, is invalid.

## What gets signed

Approvers sign an EIP-712 digest, never a bare hash handed to them.

- Domain: `{ name: "postcurve", version: "1", chainId, verifyingContract: <bunker account> }`
- Type:
  `Approval(uint256 nonce,address to,uint256 value,bytes32 dataHash,uint256 maxFeeWei,uint64 validUntil)`
- `dataHash = keccak256(data)`, where `data` is the calldata the account will send to `to`.

`nonce` is the account's operation counter, so the same approval can't be replayed.
`maxFeeWei` caps the gas fee the account will pay for the transaction. `validUntil` is a Unix
time after which the approval is void.

## Rules for signers

- **Never sign two different digests with the same leaf.** Record a leaf as used *before*
  releasing its signature, and persist that record, so a crash or retry can't reuse it.
- Re-sending an already-signed envelope for the same digest is safe. Signing a new digest
  always takes a new leaf.
- After 256 leaves, the approver needs a new tree (a new identity registered with the
  account).
