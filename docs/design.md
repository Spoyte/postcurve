# postcurve: design

Status: draft for review, 2026-11-05 (first day of ETHGlobal Mumbai).

## Intent

Elliptic-curve signatures (secp256k1 ECDSA, P-256) may break sooner than expected. Quantum
computers are one route; AI-accelerated mathematics is a newer and possibly faster one. On
7 Oct 2026 Justin Drake called for "bunker mode": keep funds behind addresses that have never
signed, rotate keys after every signature, and move to hash-based cryptography. Vitalik agreed
and went further: lattices (ML-DSA, Falcon) may fall to AI math too, so prefer hash-only.
Devcon 8 (3–6 Nov, Mumbai) opened with Justin's post-quantum keynote. Sources and quotes are in
[threat-model.md](threat-model.md).

postcurve takes a holder from "am I exposed?" to "my funds sit behind hash-only keys". It also
gives everyone early warning if someone starts breaking exposed keys.

**Audience.** Individual holders first. Custodians second: the same tools, given a list of
vault addresses, produce a value-at-risk report, and the bunker's quorum mirrors the
maker-checker approval model custodians already use. This institutional angle is a
nice-to-have for the pitch; drop anything in it that adds real complexity.

## What it does

1. **Check.** The user enters addresses. postcurve shows which have revealed their public key,
   and how much value sits behind each. All chain reads go through Anon-RPC, so the RPC
   provider can't link the addresses to each other or to the user. Revealing happens on any
   signature, not only on sending a transaction: a nonce of 0 is not proof of safety. Permits,
   EIP-7702 authorizations and contract-checked signatures also reveal the key. The UI must say
   when it can't rule exposure out.
2. **Move.** A careful migration from an exposed address into a bunker account. First send a
   small test amount. Then make the user prove they can recover the bunker's keys from their
   seed (recomputed public root matches the account). Only then move the rest. Anything the tool
   can't move safely (approvals, LP positions, NFTs) is listed as a warning, not moved
   automatically.
3. **Bunker.** A native EIP-8141 (frame transaction) account whose only signatures are
   hash-based. No elliptic-curve key can move its funds. The account is controlled by a quorum
   of approvers (N-of-M). Each approval uses a fresh one-time key, so a key is never reused.
   Transactions go through the ERC-8421 alternative mempool, because hash-based quorum
   verification exceeds the public mempool's 100k validation-gas cap.
4. **Approver device.** A Firefly Pixie (ESP32-C3, screen, 4 buttons, USB-C) holds one
   approver's one-time keys. It shows what is being approved and signs only after a physical
   button press. It records each used one-time key before releasing a signature, so a crash
   can't cause reuse.
5. **Canary.** A watcher over large, long-dormant addresses with exposed keys. A sudden sweep
   from one of them is an early sign that someone can break ECDSA. It runs as a Chainlink CRE
   workflow that raises an alert, and an ESP32 from the starter kit turns the alert into a light
   and buzzer: a literal canary.
6. **Exposure dataset.** Exposure results (address, exposed or not, how, when, value
   snapshot) are published as Arkiv entities, so anyone can query them without asking us.

## Goals

- A working end-to-end demo of all six parts on the 8141 devnet, with the check also working on
  mainnet.
- At least one transaction admitted through the alt mempool from the bunker, with a 2-of-3
  hash-based quorum where one approver is the Firefly.
- Docs good enough that a new teammate can run every part from the README alone.
- Qualify for the three chosen partners (below).

## Non-goals

- **MPC.** Threshold ECDSA still produces one elliptic-curve public key; refreshing shares
  doesn't change it, so MPC gives no protection against a broken curve. In a post-quantum
  world the quorum moves out of MPC and into the account. Mention this in the pitch; at most,
  build an MPC leg of a hybrid as a stretch goal (Dfns's open-source `cggmp21`).
- **Lattice schemes** (ML-DSA, Falcon). Excluded on purpose, following the hash-only argument.
- **Compliance gating** (screening attestations before execution).
- **Real mainnet funds in the bunker.** 8141 is not on mainnet yet (selected for Hegóta).
- **Safe-based ECDSA rotation.** Already built: Nick Dodson's Bunker Wallet
  (SilentCicero/bunker-wallet) and wedgie-pq. postcurve's difference is native 8141, hash-only,
  quorum and hardware approvers.
- Automatically moving approvals, LP positions or NFTs.

## Anti-goals (failure even if it "works")

- A migration path that can lose funds, even in the demo. Vitalik: "I personally have lost
  more money in botched migrations than I have lost in all hacks combined."
- Fake signers, auto-approval paths, mocked verification, or any UI that claims hardware or
  post-quantum security while falling back to something weaker. Every approver shown is real;
  a software approver is labelled as one.
- Claiming "quantum-safe" anywhere ECDSA is still in the path. Use precise wording.
- Reusing a one-time key, under any failure (crash, stuck transaction, retry).
- Leaking the user's addresses to the RPC during the check.

## Constraints

- **Hackathon rules.** Written from scratch at ETHGlobal Mumbai (hacking opened 2026-11-05).
  The author's May 2026 `firefly-quantum` prototype is reference notes only; no code is copied.
  Judges check git history: commit small and often.
- **Team.** Solo for now. Keep docs current so others can join at any point.
- **Repo.** `github.com/Spoyte/postcurve`, private until submission, then public. All GitHub
  activity uses the Spoyte account. MIT license.
- **EIP-8141 exists only on the alt mempool devnets** (keyed nonces and recent roots live, with
  a faucet). The alt mempool team (Pierre, Alex Forshtat) is on site. Start from
  https://github.com/forshtat/mempool-workshop and https://docs.altmempool.wtf/.
- **Measured cost.** In the May prototype, one WOTS/XMSS approval (w=16, keccak256, tree height
  4, 2,221-byte envelope) cost 318,417 gas in an ERC-4337 transaction on Sepolia. A 2-of-3
  quorum roughly doubles verification. Check the devnet's verification budget early.
- **Firefly hardware.** Buttons: OK GPIO8, Cancel GPIO10, Up GPIO3, Down GPIO2. Never configure
  GPIO18/19 (USB D-/D+); doing so killed USB on an earlier device. Firmware is C on ESP-IDF;
  the host talks to it over USB serial at 115200 (Chrome WebSerial works).

## Partners and what each requires

Three partner picks; a pick covers all that partner's prizes.

- **Ethereum Foundation.** Eligible for all three tracks, but placed in at most one.
  - *Alt mempool ($5k):* a link to an admitted transaction on the devnet explorer, or code that
    submits one; be able to explain design, code and trade-offs.
  - *Anon-RPC ($5k):* the app routes its RPC reads through Anon-RPC by default.
  - *CROPS ($3.5k):* FOSS license; README section titled CROPS with one or two lines per letter
    (C: what we control that users depend on; O: license and build-from-repo; P: what each third
    party learns; S: key protection and trust assumptions); a demo video of at most 3 minutes
    showing the lead property; no trackers; keys stay on the user's device.
- **Arkiv** ("Build on Arkiv (from scratch)", $4k; one Arkiv track per team, +$500 Swarm bonus):
  write to Arkiv's current testnet with `@arkiv-network/sdk` or JSON-RPC, and a feature users see
  must read from Arkiv. README lists the wallet address(es) that wrote entities and one query to
  run. Files: `/arkiv/schema.md`, `/arkiv/friction.md`, `/arkiv/reach.md`,
  `/arkiv/why-arkiv.md`, `/arkiv/how-you-use-arkiv.md`. Say how AI was used. The Swarm bonus
  (e.g. hosting the frontend on Swarm) needs `/arkiv/swarm.md`.
- **Chainlink** ("Best workflow with CRE", $1.5k): a CRE workflow that connects a blockchain to an
  external API or system, shown via CRE CLI simulation or deployment, and meaningfully used.
- **ETHGlobal submission:** public repo, demo video, and a statement of how AI was used.

## Demo story (target: 3 minutes)

1. Paste a few addresses: exposure and value at risk, with reads going through Anon-RPC.
2. The canary: stage a sweep from a dormant exposed devnet address; the CRE workflow fires; the
   ESP32 canary lights up.
3. Move: test transfer, recovery check, full migration into a bunker.
4. Spend from the bunker: 2-of-3 approval, one of them on the Firefly's screen and button; the
   transaction is admitted through the alt mempool; open it in the devnet explorer.
5. One slide for custodians: vault-list report, and "MPC doesn't survive a broken curve; the
   quorum moves into the account".

## Decisions made by the author

- Combine the exposure radar and the hash-only 8141 bunker into one suite named postcurve.
- Rewrite from scratch, reusing ideas from the May prototype.
- MPC stays out of the core.
- Hardware available: Firefly Pixie and an ESP32 starter kit.

## Calls made during design (review these)

- **Partners: EF, Arkiv, Chainlink.** Proposed during planning; not explicitly confirmed.
- **One-time keys as leaves of a Merkle tree (XMSS-style), not a chain of next-key
  commitments.** With a chain, a signed approval that gets stuck forces the approver to reuse the
  same one-time key to sign a replacement, which breaks WOTS security. With a tree, any unused
  leaf can sign, and the account records used leaves. When a tree runs low, the approver rotates
  to a new root with an approval from the old one.
- **Approvers sign a bunker-specific approval struct, never a bare digest.** The struct holds
  chain id, account, leaf index, recipient, value, calldata hash and a valid-until time. The
  Firefly rebuilds the hash from the fields it shows on screen, so a compromised host can't show
  one thing and get another signed. The account verifies each approval over the same struct
  hash, and checks that the transaction's execution matches the struct. Demo scope is ETH and
  ERC-20 transfers. Any other call is shown as "contract call" with its calldata hash and a
  warning.
- **Arkiv holds only postcurve's own scan, never users' checks.** That means the canary
  watchlist (large, dormant, exposed addresses) and the exposure records for those addresses,
  written by a project wallet from a script, with an expiry so stale records disappear. Users
  see Arkiv data in the canary dashboard (watchlist, status, last movement). The personal check
  never queries Arkiv by the user's address. If it uses the dataset at all, it downloads the
  whole set and filters locally.
- **WOTS with w=16 over keccak256** (cheapest hash in the EVM; proven on the Firefly in May).
- **Quorum 2-of-3 for the demo:** the Firefly plus two software approvers in the browser. The
  contract supports any N-of-M.
- **Networks:** check runs on mainnet through Anon-RPC; everything else (migration, bunker,
  canary staging) on the 8141 devnet.
- **Stack:** Solidity with Foundry; a TypeScript web app; ESP-IDF C firmware.
- **Order of work:** de-risk first, by getting any frame transaction admitted on the devnet in
  the first hours. Then the check (always demoable). Then the bunker with software approvers,
  then the Firefly, then canary/CRE/ESP32, then Arkiv.
- **Cut order if time runs out:** ESP32 light, then the custodian mode, then Arkiv, then CRE.
  The check, migration and bunker with at least one real approver are never cut.

## Risks and fallbacks

- **8141 devnet tooling is new.** If admission can't be made to work, run the same validation
  logic in an ERC-4337 account on Sepolia. That loses the alt mempool track but keeps Anon-RPC
  and CROPS.
- **Gas.** If 2-of-3 doesn't fit the devnet's verification budget, demo 1-of-1 on the Firefly
  and show 2-of-3 in tests.
- **Anon-RPC** may not cover the devnet or may be slow. It is required for mainnet reads; devnet
  reads may go direct, and the README says so.
- **Firefly failure.** Keep software approvers working so the bunker never depends on one
  device.

## Left to the builder

- Frame transaction construction and submission tooling.
- XMSS tree height, signature envelope format, root rotation details.
- Exposure detection beyond the nonce check, and how far to go.
- Where the canary's watchlist comes from, and its thresholds.
- Arkiv entity schema and expiry period.
- CRE workflow shape and the alert path to the ESP32.
- Serial protocol between host and Firefly.
- Web framework and UI.
- Repo layout.
