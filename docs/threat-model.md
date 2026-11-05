# Threat model: the sources behind the idea

Fetched 2026-11-05. All quotes are from the posts below.

## Justin Drake, "bunker mode" (7 Oct 2026)

https://x.com/drakefjustin/status/2107837081313505768

- "it is now reasonable to brace for the possibility that ECDSA breaks before qday, in the worst
  case in months not years. By 'break' I mean fast private key recovery (e.g. in one week) on
  available hardware (e.g. a large GPU cluster)." Trigger: an OpenAI release of 722 math results.
- Recommends a calm, controlled migration to fresh addresses (pubkey still hidden behind a hash).
  "when they do sign one, they should also move remaining funds to a new address (possibly
  generated from the same seed phrase)."
- "Load-bearing signers like oracles and L2 security councils should consider rotating ECDSA
  pubkeys with every signed message and/or multi-signing with a hash-based schemes like SPHINCS."
- Exiting bunker mode needs "post-AI cryptography": all-in on hash-based, no curves, lattices or
  isogenies.
- Points to Project Eleven's "risq list" of exposed BTC pubkeys as a tracker.

## Vitalik Buterin (7 Oct 2026)

https://x.com/VitalikButerin/status/2107976296320106851

- AI-accelerated math threatens ECDSA (more reason for "fresh address") and also lattices
  (ML-DSA, Falcon, FHE). Rule of thumb for anything lattice-based: be much more paranoid on
  parameter sizes.
- Lean Ethereum has gone hash-only: "Signatures in lean ethereum are all hash-based, either WOTS
  or SPHINCS-."
- Hash-based > lattice-based wherever hash-based is possible.
- Keep funds in never-used addresses if easy, "But be careful about migrations; I personally have
  lost more money in botched migrations than I have lost in all hacks combined".
- Multisigs: gather confirmations offchain so signer signatures are never public. If ECDSA falls,
  the multisig degrades to a 1-of-1 (the signature gatherer) instead of "anyone can take the money".

## Vitalik, correction (8 Oct 2026)

https://x.com/VitalikButerin/status/2108046549020557482

- "for multisigs the ideal 'safe' rule is that you want each signer to change their key after
  each operation."
- Assumes ECDSA weakens but not instantly, so in-mempool frontrunning is not the concern.
- Still gather sigs offchain "to minimize the number of hours between 'sig revealed' and 'key no
  longer active'". Don't rush upgrades.

## Vitalik at Devcon 8, Mumbai (video posted 3 Nov 2026)

https://x.com/CryptoTimes_io/status/2117522292859379898

General d/acc talk: AI changes security assumptions, defensive and decentralized tech, open
source and verifiability, ZK privacy, secure OS and hardware, local AI, "treat data as toxic
waste". Same values as the EF CROPS mandate; no specific wallet design.

## What this means for a design

- Under this threat model (key break takes days), rotating keys each transaction is effective;
  the seconds a tx sits in the mempool don't matter.
- Justin's version moves funds to a new address every transaction, which costs gas and breaks
  approvals, ENS, NFTs and positions. Rotating keys behind a fixed account address avoids that.
- EIP-7702 is not enough: the delegating EOA's original key keeps full control, so a broken key
  still drains the account. Needs a contract account with no permanent ECDSA owner.
- The long-term target is hash-only signatures (WOTS / SPHINCS-), matching lean Ethereum.
- Migration safety is a first-class requirement, not an afterthought.
