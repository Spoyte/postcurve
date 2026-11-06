# postcurve: design

Status: v2, 2026-11-06. Replaces v1 (same day) after feedback from the EF alt mempool team.
Building one step at a time; the final goal is every part below.

## Intent

Elliptic-curve signatures (secp256k1 ECDSA, P-256) may break sooner than expected. Quantum
computers are one route; AI-accelerated mathematics is a newer and possibly faster one. On
7 Oct 2026 Justin Drake called for "bunker mode": keep funds behind addresses that have never
signed, rotate keys after every signature, and move to hash-based cryptography. Vitalik agreed
and went further: lattices (ML-DSA, Falcon) may fall to AI math too, so prefer hash-only.
Devcon 8 opened with Justin's post-quantum keynote. Sources: [threat-model.md](threat-model.md).

postcurve takes a holder from "am I exposed?" to "my funds sit behind hash-only keys", lets them
**receive privately into fresh accounts that only hash-based keys can spend**, and warns
everyone if someone starts breaking exposed keys.

**Why this shape.** The bunker idea (exposure check, hash-only quorum, key-break canary) is rare
and is our differentiator. The EF alt mempool team asked for something concrete on top: pq-sap
stealth payments (an EF fellowship project, cohort 7) received in USDC and spent through a
paymaster, so the recipient never needs ETH from an address linked to them. pq-sap explicitly
leaves spending "delegated to the account model", with no post-quantum-sound spender yet;
postcurve is that spender. The paymaster is also what qualifies for the alt mempool prize, but
many teams may build paymasters, so the pitch leads with the bunker.

**Audience.** Individual holders first. Custodians second: the check takes a list of vault
addresses and produces a value-at-risk report, and the quorum mirrors the maker-checker approval
model custodians already use. A nice-to-have for the pitch; drop it if it costs real time.

## Parts

1. **Signature core** (done). One hash-only format: WOTS (w=16) one-time keys as leaves of an
   XMSS tree (height 8, 256 leaves) over keccak256, in TypeScript (`sdk/`) and Solidity
   (`contracts/src/WotsXmss.sol`), with shared vectors. Spec: [spec/signature.md](../spec/signature.md).
   Measured: 282,460 gas for one approval, 529,165 for two.
2. **Check (exposure).** The user enters addresses (or, for custodians, a list). postcurve
   shows which have revealed their public key and the value behind each, reading mainnet
   through Anon-RPC so the provider can't link them. A nonce of 0 is not proof of safety:
   permits, EIP-7702 authorizations and contract-checked signatures also reveal keys. The UI
   says when it can't rule exposure out. It also flags an ENS name whose published stealth
   meta-address uses an elliptic-curve scheme (ERC-5564 scheme 1 / ENSIP-30): if that math
   falls, every payment received through it can be stolen.
3. **Stealth bunker account.** A fresh EIP-8141 account per payment, at an address the sender
   computes with pq-sap and that only the recipient can detect. It is deployed on first spend.
   No elliptic-curve key can move its funds; spending needs the recipient's hash-only quorum.
4. **postcurve paymaster.** A staked paymaster that pays the gas for a stealth account's spend
   and takes its fee in the token being spent (test USDC). It carries the heavy signature check
   (see "How a spend works").
5. **Send and scan.** The recipient publishes a pq-sap meta-address. A sender derives a fresh
   stealth address, sends test USDC to it, and posts an ERC-5564 announcement. The recipient
   scans announcements with their ML-KEM viewing key and finds their payments.
6. **Approvers.** Three approver keys in three places: the Firefly, which generates its own key
   on the device and shows the backup words on its screen; the browser, which holds the
   everyday key; and a paper recovery seed, used only if one of the other two is lost. Any two
   can approve; the browser alone never can. **Paper is for recovery only**: it never signs in
   the everyday flow, so the demo's two everyday approvers are the browser and a device approver.
   Until the Firefly firmware exists, the device approver is a **software stand-in**: a separate
   "device signer" process (a CLI in its own terminal, with its own seed and its own used-key
   file), labelled as software everywhere. The quorum is part of the meta-address, so when the
   Firefly is ready we generate a fresh meta-address with it in the quorum. The **Firefly
   approver firmware is a separate sub-project**, built after the core.
7. **Canary.** A Chainlink CRE workflow watching large, long-dormant, exposed addresses for
   sudden sweeps: an early sign someone can break ECDSA. Being built in parallel. The **ESP32
   alert light is a separate sub-project**; the canary publishes a documented JSON alert for it.
8. **Exposure dataset** (later). postcurve's own scan, i.e. the canary watchlist and exposure
   records for those addresses, published as Arkiv entities by a project wallet. Users' checks
   are never published, and the check never queries Arkiv by a user's address.
9. **Move** (later). A careful migration from an exposed address into a bunker: test transfer
   first, a recovery check (a quorum can be rebuilt from backups), then the rest. Anything it
   can't move safely (approvals, LP positions, NFTs) is listed, not moved.
10. **Local devnet and sidecar** (in place). A local EIP-8141 devnet in `devnet/` (ethrex,
    Lighthouse, the alt mempool sidecar). The sidecar is patched to implement ERC-8421's
    per-entity validation budget (BUDGET-010), and the patch goes upstream as a pull request
    from a fork.

## How a spend works

A spend from a stealth bunker account is one frame transaction (EIP-8141) on the local devnet:

```
[deploy]          first spend only: the factory deploys the stealth account at its address
[only_verify]     stealth account: cheap check, approves execution            (unstaked, < 100k)
[pre_verify]      paymaster: verifies the quorum, records used one-time keys  (staked, ≤ 1M)
[pay]             paymaster: checks pre_verify succeeded and the fee is covered, approves payment
[sender]          token.transfer(destination, amount)
[sender]          token.transfer(paymaster, fee)
```

A fresh stealth account holds only tokens, so it can't stake and stays under the 100,000-gas
unstaked budget. The staked paymaster's budget (up to 1,000,000 under ERC-8421) carries the
~530k quorum check: ERC-8421 counts a `pre_verify` frame toward the entity of the approving
frame it precedes, and lets it write storage. If the paymaster doesn't approve payment, the
whole transaction is invalid and nothing executes.

## Goals

- A working end-to-end demo on the local devnet: receive test USDC at a pq-sap stealth address,
  detect it by scanning, and spend it with a 2-of-3 hash-only approval, gas paid by the postcurve
  paymaster, admitted by the (patched) alt mempool sidecar.
- The check working on mainnet through Anon-RPC.
- The canary simulated with the CRE CLI.
- Docs good enough that a new teammate can run every part from the README alone.
- Qualify for the chosen partners (below). Keep the option to deploy on the public devnet later.

## Non-goals

- **MPC.** Threshold ECDSA still has one elliptic-curve public key, and refreshing shares
  doesn't change it, so MPC gives no protection against a broken curve. In a post-quantum world
  the quorum moves into the account. Mention this in the pitch; at most a stretch goal.
- **Lattice signatures** (ML-DSA, Falcon) for spending. Excluded on purpose, following the
  hash-only argument. (pq-sap's detection uses ML-KEM, a lattice KEM: breaking it would cost
  privacy, never funds.)
- **Compliance gating** (screening attestations before execution).
- **Real mainnet funds in a bunker.** EIP-8141 is not on mainnet yet (selected for Hegóta).
- **Safe-based ECDSA rotation.** Already built: Nick Dodson's Bunker Wallet
  (SilentCicero/bunker-wallet) and wedgie-pq.
- **Stake parameters.** Stake is a network concern; locally it doesn't matter.

## Anti-goals (failure even if it "works")

- A spend or migration path that can lose funds, even in the demo. Vitalik: "I personally have
  lost more money in botched migrations than I have lost in all hacks combined."
- Fake signers, auto-approval paths, mocked verification, or any UI that claims hardware or
  post-quantum security while falling back to something weaker. Every approver shown is real; a
  software approver is labelled as one. A test token is labelled as one.
- Claiming "quantum-safe" anywhere ECDSA is still in the path; claiming "private" for anything
  that links the recipient. Use precise wording, including what a spend reveals (below).
- Reusing a one-time key, under any failure (crash, stuck transaction, retry).
- A recipient needing ETH from an address linked to them in order to spend.
- Leaking the user's addresses to the RPC during the check.

## Constraints

- **Hackathon rules.** Written from scratch at ETHGlobal Mumbai (hacking opened 2026-11-05). The
  author's May 2026 `firefly-quantum` prototype is reference notes only; no code is copied.
  Open-source libraries are fine (credit them). Judges check git history: commit small and often.
- **Deadline: Saturday 7 Nov 2026, morning IST.** About 15 hours from Friday 17:40 IST, including
  the night. The author's aim is still every part; the order of work and cut order below decide
  what is safe to promise.
- **Team.** Solo for now. Keep docs current so others can join at any point.
- **Repo.** `github.com/Spoyte/postcurve`, private until submission, then public. All GitHub
  activity uses the Spoyte account. MIT license.
- **Local first.** The alt mempool team agreed the local devnet is enough for now, assuming no
  100k limit, with the sidecar patched to follow the spec. Keep the option to deploy on the public
  devnet later. Devnet notes: [devnet-notes.md](devnet-notes.md).
- **pq-sap** (Skanislav/pq-sap, MIT, pinned at `dd18e5f`, 2026-10-31) is a draft. postcurve
  follows its commitment format `0x02` and CREATE2 deployment binding (its `TECHNICAL_SPEC.md` §2–4)
  as a new account profile, and reuses its code where it fits.
- **Firefly hardware.** Buttons: OK GPIO8, Cancel GPIO10, Up GPIO3, Down GPIO2. Never configure
  GPIO18/19 (USB D-/D+). Firmware is C on ESP-IDF; serial at 115200.

## Partners and what each requires

Three partner picks; a pick covers all that partner's prizes.

- **Ethereum Foundation.** Eligible for all three tracks, placed in at most one. The primary
  target is the alt mempool track.
  - *Alt mempool ($5k):* the prize asks for frame transactions with a verification budget above
    100k (e.g. PQ smart wallets), or more flexible state access in a paymaster (e.g. ERC-20
    paymasters). The spend flow does both. It needs a link to an admitted transaction on the
    devnet explorer, or code that submits one; be able to explain the design, code and
    trade-offs. Local admission is enough for now (alt mempool team, 2026-11-06).
  - *Anon-RPC ($5k):* the app routes its RPC reads through Anon-RPC by default.
  - *CROPS ($3.5k):* FOSS license; README section titled CROPS (C/O/P/S lines); demo video of at
    most 3 minutes showing the lead property; no trackers; keys stay on the user's device.
- **Chainlink** ("Best workflow with CRE", $1.5k): a CRE workflow connecting a blockchain to an
  external API or system, shown via CRE CLI simulation or deployment, meaningfully used.
- **Arkiv** ("Build on Arkiv (from scratch)", $4k; +$500 Swarm bonus): part 8. Write to Arkiv's
  current testnet with `@arkiv-network/sdk` or JSON-RPC; a feature users see (the canary
  dashboard) reads from Arkiv. The README lists the writer wallet and one query. Needs
  `/arkiv/schema.md`, `friction.md`, `reach.md`, `why-arkiv.md` and `how-you-use-arkiv.md`.
- **ENS, later** ("Best Use of ENSv2", $7k): publish the meta-address through ENSIP-30 on
  Sepolia so "pay alice.eth privately" works. Only once everything else is good; it would replace
  Arkiv or Chainlink as a partner pick. Until then the meta-address is shared off-chain (link or QR).
- **ETHGlobal submission:** public repo, demo video, and a statement of how AI was used.

## Demo story (target: 3 minutes)

1. The check: paste a few addresses; see exposure and value at risk, reads via Anon-RPC.
2. Bob pays Alice in test USDC to a fresh stealth address. Nothing onchain links it to Alice.
3. Alice scans and finds the payment, then spends it: 2-of-3 hash-only approval, gas paid in
   test USDC by the paymaster, admitted by the alt mempool. Alice never touched ETH.
4. The canary: stage a sweep from a dormant exposed address; the CRE workflow fires.
5. One slide: what each piece of crypto protects (hash-only = funds; ML-KEM = privacy only), and
   for custodians, "MPC doesn't survive a broken curve; the quorum moves into the account".

## Decisions made by the author

- Combine the exposure radar and the hash-only 8141 bunker into one suite named postcurve.
- Rewrite from scratch, reusing ideas from the May prototype. MPC stays out of the core.
- Partners EF and Chainlink (confirmed 2026-11-06); third partner decided at submission.
- Approver keys live in three places (Firefly, browser, paper); any two approve; after setup no
  single device holds two of the three keys (confirmed 2026-11-06).
- Build against the local devnet first; patch the sidecar per ERC-8421 and upstream the patch
  through a fork and pull request; stake parameters don't matter locally (2026-11-06).
- Add pq-sap stealth receiving of test USDC, spent through a paymaster, while keeping the bunker
  idea as the lead (2026-11-06).
- Canary built in parallel by a side agent; Firefly firmware and the ESP32 light are separate
  sub-projects; the final goal is every part (2026-11-06).

## Calls made during design (review these)

- **One-time keys as leaves of a Merkle tree (XMSS-style), WOTS w=16 over keccak256** (built).
- **The stealth account profile** is a new pq-sap account profile, `postcurve-wots-xmss-quorum/v0`:
  - `spend_key = keccak256("postcurve/quorum/key/v0" || abi.encode(threshold, identities))`,
    where each identity is an approver's `(root, pubSeed)`;
  - the opener and commitment follow pq-sap §3 with domains `postcurve/wots-xmss-quorum/open/v0`
    and `postcurve/wots-xmss-quorum/commit/v0`;
  - the address is pq-sap's CREATE2 binding, where `verifier` is the postcurve paymaster.
- **The paymaster carries the quorum check, not the account.** In `pre_verify`, the paymaster:
  - checks the sender is a postcurve stealth account;
  - checks that the revealed quorum config and opener open the account's commitment;
  - verifies at least `threshold` approvals;
  - checks that the execution frames match the approval;
  - records the used one-time keys in a register keyed by approver identity, shared by all of
    that recipient's stealth accounts.

  The account's `only_verify` only checks, with `FRAMEPARAM`, that the following frames are the
  `pre_verify` and `pay` of the paymaster bound in its deployment.
- **Approvers sign a transfer approval**: EIP-712
  `TransferApproval(uint256 nonce,address token,address to,uint256 amount,uint256 maxFee,uint64 validUntil)`,
  with domain `{ name: "postcurve", version: "2", chainId, verifyingContract: stealth account }`.
  The paymaster accepts exactly two execution frames: `token.transfer(to, amount)` and
  `token.transfer(paymaster, fee)` with `fee ≤ maxFee`. This scope is narrow on purpose: it is
  safe, and the Firefly can show every field. (The generic v1 `Approval` stays in the SDK.)
- **The viewing key is backed up by the paper seed.** Losing the ML-KEM viewing key would lose
  funds, not just privacy: without it you can't find payments or recompute the opener. So the
  ML-KEM-768 keypair is derived deterministically, with domain separation, from the paper recovery
  seed, and the paper backup restores scanning as well as one approver. The browser keeps a copy
  for everyday scanning; the viewing key can't spend. The browser derives it during setup, which
  is the documented setup exception to "no device holds two keys" (stated in the README).
- **Paper recovery signing** (built with Move) reads the paymaster's used-key register first and
  signs only with leaves above the highest one recorded. It re-sends the same signed approval
  until it is included or expires, and never signs a new digest with a leaf it has already
  released in that session. The README states the remaining edge case: a signed but never-included
  approval from a past session isn't in the register.
- **No single point of custody.** Every stealth account also accepts an emergency self-paid spend:
  it verifies the quorum itself and pays gas from its own ETH. That needs a staked account or a
  private builder for the over-100k check. It is used only if the paymaster is unavailable, and
  costs privacy, never funds. The paymaster and account contracts are immutable: no admin, no
  upgrade, no pause.
- **Sidecar patch ownership:** a side agent prepares it on the Spoyte fork; the main session
  reviews it; the pull request opens only after the author's OK.
- **What a spend reveals:** the quorum config, which links every stealth account that recipient
  has spent from (the same trade-off as pq-sap's direct spend routes). Detection privacy rests
  on ML-KEM. Both go in the README's CROPS "P" line.
- **Test assets:** a local ERC-20 labelled as test USDC, and an ERC-5564 announcer deployed on
  the local devnet.
- **Partners:** EF primary, Chainlink for the canary, Arkiv for the dataset (confirmed
  2026-11-06); ENS later.
- **Order of work:**
  1. Sidecar patch (in progress).
  2. Paymaster and stealth account contracts with Foundry tests.
  3. End-to-end spend on the local devnet.
  4. Send and scan.
  5. Browser UI.
  6. The check.
  7. Canary (in parallel).
  8. Firefly and ESP32 sub-projects.
  9. Arkiv and Move.
- **Cut order if time runs out:** Move, then Arkiv, then the ESP32 light, then the Firefly. The
  stealth receive and the hash-only spend through the paymaster are never cut.

## Risks and fallbacks

- **Alt mempool storage rules.** A staked paymaster reading the account's token balance and
  writing its key register in `pre_verify` must be allowed by the sidecar's ERC-8421 storage
  rules. Check this first. Fallback: move the balance check to the execution frames, and accept
  the paymaster's risk on a bounded fee.
- **pq-sap is a draft** and may change; we pin a commit and state the profile version.
- **Gas.** If the paymaster's budget is tight, demo 1-of-1 and show 2-of-3 in tests.
- **The public devnet** runs today's sidecar (100k for everyone). Local is enough until help arrives.
- **Anon-RPC** may be slow or not cover a network; it is required for mainnet reads.

## Left to the builder

- Frame transaction construction and submission tooling; nonce handling (keyed nonces) without replay.
- Whether to reuse pq-sap's `Stealth8141ZkAccount`/factory or write a matching account.
- XMSS root rotation when a tree runs low.
- Exposure detection beyond the nonce check, and how far to go.
- Canary watchlist source and thresholds; Arkiv entity schema and expiry.
- Web framework and UI; repo layout.
