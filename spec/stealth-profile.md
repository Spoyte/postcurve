# postcurve stealth profile `postcurve-wots-xmss-quorum/v0`

A [pq-sap](https://github.com/Skanislav/pq-sap) account profile (commitment format `0x02`, pinned
at `dd18e5f`, see its `docs/TECHNICAL_SPEC.md` §2–4). Payments land in fresh EIP-8141 stealth
accounts that only a hash-only (WOTS/XMSS, [signature.md](signature.md)) quorum can spend.
Rationale: [../docs/design.md](../docs/design.md). Vectors: [vectors/stealth-v0.json](vectors/stealth-v0.json).

## Domains

UTF-8 bytes, no terminator. Changing any of them changes every destination.

| Name | Value |
|---|---|
| key | `postcurve/quorum/key/v0` |
| open | `postcurve/wots-xmss-quorum/open/v0` |
| commit | `postcurve/wots-xmss-quorum/commit/v0` |
| view key | `postcurve/view-key/v0` |

## Values

```
spend_key   = keccak256(key || abi.encode(uint256 threshold, (bytes32 root, bytes32 pubSeed)[] identities))
opener      = SHA-256(open || ss)
commitment  = keccak256(commit || spend_key || opener)
view_tag    = SHA-256(ss)[0]
meta        = 0x02 || spend_key (32 B) || ML-KEM-768 encapsulation key (1,184 B)      = 1,217 B
init_code   = StealthBunkerAccount.creationCode || abi.encode(commitment, paymaster, frameOps)
address     = keccak256(0xff || factory || 0x00…00 (salt) || keccak256(init_code))[12:32]
```

`opener`, `commitment`, `view_tag` and the address layout are pq-sap's; only the domains, the
`spend_key` definition and the deployment (factory, account code, `verifier` = the postcurve
paymaster, `frame_ctx` = the shared frame-ops helpers) belong to this profile. The identity order
in `spend_key` is significant.

## Viewing key

The ML-KEM-768 keypair is derived from the approver set's **paper recovery seed** (32 bytes), so
the paper backup restores scanning:

```
d = keccak256(view key || 0x01 || paperSeed)
z = keccak256(view key || 0x02 || paperSeed)
(ek, dk) = ML-KEM-768.KeyGen(d || z)          (FIPS 203 deterministic key generation)
```

The browser keeps `dk` for everyday scanning. `dk` cannot spend.

## Receive and scan (pq-sap §3)

```
Recipient: publish meta = 0x02 || spend_key || ek
Sender:    (ss, ct) = Encaps(ek); opener, commitment, address as above
           pay the address; announce (ERC-5564, scheme id 2): ephemeralPubKey = ct, metadata[0] = view_tag
Scanner:   ss = Decaps(ct, dk); reject a view-tag mismatch; re-derive commitment and address;
           a payment is found only when the address matches
```

A view-tag match alone proves nothing; the address comparison decides.

## Spending

A spend reveals the quorum (`threshold`, `identities`) and the `opener` for that account. That
links every stealth account the recipient spends from, and makes the account's sender visible
to the paymaster, the same trade-off as pq-sap's direct spend routes. Detection privacy rests on
ML-KEM: if it breaks, payments can be linked to the recipient, but funds stay safe because spending
needs the hash-only quorum.
