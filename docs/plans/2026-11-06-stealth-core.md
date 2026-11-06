# Stealth Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Receive test USDC at a pq-sap stealth address and spend it from a fresh EIP-8141
stealth bunker account with a 2-of-3 hash-only approval, gas paid in test USDC by a staked
postcurve paymaster, admitted by the patched alt mempool sidecar on the local devnet.

**Architecture:** TypeScript (`sdk/src/stealth/`) implements the pq-sap commitment-format
derivation under a new account profile, the ML-KEM viewing key, sending and scanning, and the
v2 `TransferApproval`. Solidity (`contracts/src/stealth/`) has a minimal stealth account (its
`only_verify` frame only checks the frame shape and approves execution), a factory using pq-sap's
CREATE2 binding, a staked paymaster that verifies the quorum in `pre_verify` and approves payment
in `pay`, plus test USDC and an ERC-5564 announcer. An integration script drives the whole flow
against the local devnet.

**Tech Stack:** Bun 1.4.4, TypeScript, viem, `@noble/post-quantum` (ML-KEM-768), `@noble/hashes`;
Foundry 1.7.1, solc 0.8.28, `@forshtat/hegota-support` 0.0.1 (MIT, opcode helpers), OpenZeppelin
contracts (ERC-20); the pq-sap frame-tx codec (MIT, vendored with credit).

**Spec:** [docs/design.md](../design.md) ("How a spend works", "Calls made during design"),
[spec/signature.md](../../spec/signature.md), and pq-sap `docs/TECHNICAL_SPEC.md` §2–4 at `dd18e5f`.

## Global Constraints

- Local devnet only: chain 1337, ethrex `http://127.0.0.1:18545`, sidecar `http://127.0.0.1:14337/rpc`
  running image `postcurve/sidecar:budget010` (ERC-8421 BUDGET-010: staked entity ≤ 1,000,000,
  unstaked ≤ 100,000 validation gas). Funded keys: `devnet/data/keys/accounts.json` (never printed).
- Hash-only spending: WOTS/XMSS from `spec/signature.md` only; no ECDSA or lattice signature anywhere in a spend.
- Profile name `postcurve-wots-xmss-quorum/v0`. Domains (UTF-8 bytes, no terminator):
  key `postcurve/quorum/key/v0`, open `postcurve/wots-xmss-quorum/open/v0`,
  commit `postcurve/wots-xmss-quorum/commit/v0`, view key `postcurve/view-key/v0`.
- `spend_key = keccak256(KEY_DOMAIN || abi.encode(uint256 threshold, (bytes32 root, bytes32 pubSeed)[] identities))`.
- `opener = SHA-256(OPEN_DOMAIN || ss)`; `commitment = keccak256(COMMIT_DOMAIN || spend_key || opener)`;
  `view_tag = SHA-256(ss)[0]` (pq-sap §3).
- Meta-address = `0x02 || spend_key (32) || ML-KEM-768 encapsulation key (1184)` = 1,217 bytes.
- Stealth address = `CREATE2(factory, salt 0, keccak256(StealthBunkerAccount.creationCode || abi.encode(commitment, paymaster, frameOps)))`.
- ERC-5564 scheme id 2 (pq-sap's target); announcement `ephemeralPubKey` = ML-KEM ciphertext (1,088 bytes), `metadata[0]` = view tag.
- `TransferApproval(uint256 nonce,address token,address to,uint256 amount,uint256 maxFee,uint64 validUntil)`,
  EIP-712 domain `{ name: "postcurve", version: "2", chainId, verifyingContract: <stealth account> }`.
- Test token: name "Test USDC (postcurve local)", symbol "tUSDC", 6 decimals. Never called USDC in UI or docs without "test".
- Contracts are immutable: no owner, admin, upgrade or pause (except tUSDC's minter, which is test-only).
- Commits: small Conventional Commits as Spoyte, pushed after each task. Nothing mentions the user's employer; no AI attribution.

## Review Focus

1. **A different paymaster or frame layout sneaks past the account.** An attacker builds a tx
   whose payer is their own contract, or adds extra SENDER frames; the account must refuse to
   approve. Pinned in Task 4.
2. **One-time key reuse through the paymaster.** The same (identity, leaf) presented twice, in
   one tx or across txs, must be rejected. Pinned in Task 5.
3. **Fee drain.** A submitter raises the fee frame above `maxFee`, or adds a third transfer; the
   paymaster must refuse. Pinned in Task 5.
4. **Wrong commitment opening.** A valid quorum for a different stealth account (another opener
   or identity set) must not unlock this account. Pinned in Task 5.
5. **TS/Solidity drift in the profile.** spend_key, commitment, address and approval digest must
   match byte for byte across languages. Pinned by vectors in Tasks 1–3.

## File Structure

```
spec/stealth-profile.md                        normative profile (Task 1)
spec/vectors/stealth-v0.json                   cross-language vectors (Task 3)
sdk/src/stealth/profile.ts                     domains, spendKey, opener, commitment, address, viewTag
sdk/src/stealth/viewKey.ts                     ML-KEM-768 keypair from the paper seed
sdk/src/stealth/metaAddress.ts                 0x02 meta-address codec
sdk/src/stealth/send.ts, scan.ts               sender derivation / recipient scanning
sdk/src/transferApproval.ts                    EIP-712 v2 digest
sdk/src/vendor/pq-sap/                         vendored frame-tx codec (MIT, credited)
sdk/scripts/device-signer.ts                   software stand-in device approver (CLI)
sdk/scripts/e2e-stealth.ts                     devnet integration (Task 7)
contracts/src/stealth/FrameOps.sol             shared opcode helpers (deployed once)
contracts/src/stealth/StealthProfile.sol       spendKey/commitment library
contracts/src/stealth/TransferApproval.sol     EIP-712 v2 digest library
contracts/src/stealth/StealthBunkerAccount.sol only_verify + emergency path
contracts/src/stealth/StealthBunkerFactory.sol CREATE2 deploy/addressOf
contracts/src/stealth/PostcurvePaymaster.sol   pre_verify quorum check + pay
contracts/src/stealth/TestUSDC.sol, ERC5564Announcer.sol
contracts/test/stealth/*.t.sol
```

---

### Task 1: Stealth profile in TypeScript

**Files:** Create `spec/stealth-profile.md`, `sdk/src/stealth/profile.ts`, `sdk/src/stealth/viewKey.ts`,
`sdk/src/stealth/metaAddress.ts`, `sdk/src/stealth/send.ts`, `sdk/src/stealth/scan.ts`; Test `sdk/test/stealth/*.test.ts`.

**Interfaces:**
- Produces:
  - `PROFILE = { name, keyDomain, openDomain, commitDomain, viewKeyDomain }` (Global Constraints values)
  - `spendKey(threshold: number, ids: Identity[]): Hex`
  - `opener(ss: Uint8Array): Hex`; `commitment(spendKey: Hex, opener: Hex): Hex`; `viewTag(ss: Uint8Array): number`
  - `stealthAddress(commitment: Hex, d: Deployment): Address` where
    `Deployment = { factory: Address; accountCreationCode: Hex; paymaster: Address; frameOps: Address }`
  - `viewKeyFromSeed(paperSeed: Uint8Array): { ek: Uint8Array; dk: Uint8Array }`. The keypair is
    deterministic: `d = keccak256(VIEW_KEY_DOMAIN || 0x01 || seed)`, `z = keccak256(VIEW_KEY_DOMAIN || 0x02 || seed)`,
    then `ml_kem768.keygen(d || z)`.
  - `encodeMetaAddress(spendKey: Hex, ek: Uint8Array): Hex`; `decodeMetaAddress(m: Hex): { spendKey; ek } | null`
  - `send(meta: Hex, d: Deployment): { address: Address; ephemeralPubKey: Hex; viewTag: number; opener: Hex }`
  - `scan(dk: Uint8Array, spendKey: Hex, d: Deployment, ann: { stealthAddress: Address; ephemeralPubKey: Hex; metadata: Hex }): { opener: Hex } | null`
- Consumes: `Identity` from `sdk/src/xmss.ts`.

- [ ] **Step 1: Write `spec/stealth-profile.md`** with every Global Constraints value above, the
  receive/scan flow from pq-sap §3, what a spend reveals, and the paper-seed derivation of the viewing key.
- [ ] **Step 2: Write the failing tests:**
  - `pq-sap compatibility`: with pq-sap's C13 domains (`pq-stealth/sphincs-c13/open/v0` and
    `pq-stealth/sphincs-c13/commit/v0`), the generic `opener` and `commitment` reproduce
    `python/vectors/v0/commit_vectors.json` from pq-sap `dd18e5f`. Copy that file to
    `sdk/test/stealth/fixtures/pq-sap-commit-vectors.json` with an attribution note.
  - `viewKeyFromSeed` is deterministic for a fixed seed, and differs for another seed.
  - `send` → `scan` round-trips: the address matches, and the opener equals the sender's.
  - `scan` returns null for: a wrong `dk`, a flipped ciphertext byte, a wrong view tag, and a
    tampered stealth address.
  - `decodeMetaAddress` rejects a length ≠ 1,217 and a version byte ≠ `0x02`.
  - `spendKey` changes when the threshold, any root, or the order of identities changes.
- [ ] **Step 3: Run** `cd sdk && bun test test/stealth`. Expected: FAIL (modules missing).
- [ ] **Step 4: Implement.** `bun add @noble/post-quantum`. SHA-256 and keccak come from
  `@noble/hashes`. For `stealthAddress`, use viem's `getContractAddress({ opcode: "CREATE2" })`.
- [ ] **Step 5: Run** `bun test`. Expected: all PASS, including the earlier 56.
- [ ] **Step 6: Commit and push:** `feat(sdk): add the postcurve pq-sap stealth profile`.

### Task 2: TransferApproval v2 and the device signer

**Files:** Create `sdk/src/transferApproval.ts`, `sdk/scripts/device-signer.ts`; Modify `sdk/src/index.ts`;
Test `sdk/test/transferApproval.test.ts`, `sdk/test/deviceSigner.test.ts`.

**Interfaces:**
- Produces:
  - `type TransferApproval = { nonce: bigint; token: Address; to: Address; amount: bigint; maxFee: bigint; validUntil: bigint }`
  - `transferApprovalDigest(chainId: number, account: Address, a: TransferApproval): Hex`
  - device signer CLI: `bun scripts/device-signer.ts --dir <dataDir> init|identity|sign <approvalJson>`
    - `init` writes `seed.json` (mode 600) and an empty `used-leaves.json`.
    - `identity` prints the `Identity`.
    - `sign` prints the approval fields, waits for a typed `y`, saves the used leaf through
      `Approver.approve`'s save hook, then prints the envelope. Any other answer prints nothing.
- Consumes: `Approver` (with save hook) from Task 4 of the signature core.

- [ ] **Step 1: Write the failing tests:**
  - The digest equals viem `hashTypedData` for the v2 type and domain.
  - Changing chainId, account, token, to, amount, maxFee or validUntil changes the digest.
  - The device signer, given a piped answer `n`, exits non-zero without printing an envelope and
    leaves `used-leaves.json` unchanged.
  - Given `y`, it prints an envelope that `verifyEnvelope` accepts, and `used-leaves.json` contains its leaf.
- [ ] **Step 2: Run** `bun test test/transferApproval.test.ts test/deviceSigner.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The device signer reads stdin itself; it has no `--yes` flag, so there
  is no automatic approval path. Its data dir defaults to `sdk/.device-signer/`; add that to `.gitignore`.
- [ ] **Step 4: Run** `bun test`. Expected: all PASS.
- [ ] **Step 5: Commit and push:** `feat(sdk): add TransferApproval v2 and a software device signer`.

### Task 3: Solidity profile and approval libraries, with shared vectors

**Files:** Create `contracts/src/stealth/StealthProfile.sol`, `contracts/src/stealth/TransferApproval.sol`,
`sdk/scripts/gen-stealth-vectors.ts`, `spec/vectors/stealth-v0.json`; Test `contracts/test/stealth/Profile.t.sol`,
`sdk/test/stealth/vectors.test.ts`.

**Interfaces:**
- Produces:
  - `library StealthProfile { struct Identity { bytes32 root; bytes32 pubSeed; } function spendKey(uint256 threshold, Identity[] memory ids) internal pure returns (bytes32); function commitment(bytes32 spendKey, bytes32 opener) internal pure returns (bytes32); }`
  - `library TransferApproval { struct Data { uint256 nonce; address token; address to; uint256 amount; uint256 maxFee; uint64 validUntil; } function digest(Data memory a, uint256 chainId, address account) internal pure returns (bytes32); }`
  - The vectors file `spec/vectors/stealth-v0.json` holds: 3 identities (from fixed TEST seeds),
    threshold 2, spendKey, a fixed `ss`, the opener, the commitment, and one approval with its digest.

- [ ] **Step 1: Write the failing tests.** Solidity reads the vectors JSON, and `spendKey`,
  `commitment` and `digest` equal the vector values. The TS test checks that regenerating the
  vectors byte-equals the committed file.
- [ ] **Step 2: Run** `cd contracts && forge test --match-path test/stealth/Profile.t.sol`. Expected: FAIL.
- [ ] **Step 3: Implement** both libraries and the generator. Add `../spec/vectors` to
  `fs_permissions` (already readable).
- [ ] **Step 4: Run** `forge test && cd ../sdk && bun test`. Expected: all PASS.
- [ ] **Step 5: Commit and push:** `feat(contracts): add stealth profile and TransferApproval libraries`.

### Task 4: Frame ops, stealth account and factory

**Files:** Create `contracts/src/stealth/FrameOps.sol`, `contracts/src/stealth/StealthBunkerAccount.sol`,
`contracts/src/stealth/StealthBunkerFactory.sol`; Test `contracts/test/stealth/Account.t.sol` (+ mocks in
`contracts/test/stealth/FrameMocks.sol`).

**Interfaces:**
- Produces:
  - `FrameOps`: deployed once. It creates the hegota-support helpers for `Devnet.ERC8421_WORKSHOP`
    from `HelperCode`, and exposes `approveHelper()`, `txParamHelper()` and `frameParamHelper()` as immutables.
  - `StealthBunkerAccount(bytes32 commitment, address paymaster, address frameOps)` with:
    - `COMMITMENT`, `PAYMASTER` and `FRAME_OPS` as immutables;
    - `function verifyExecution() external`: the `only_verify` target. It requires
      `msg.sender == 0xaa`, and the next frame being DEFAULT mode, targeting `PAYMASTER`. The frame
      after that must be VERIFY mode, targeting `PAYMASTER`. The frames after that must be exactly
      two SENDER frames targeting the same token. If all that holds, it APPROVEs EXECUTION via a
      delegatecall to `approveHelper`; otherwise it reverts.
    - `struct EmergencyAuth { uint256 threshold; StealthProfile.Identity[] ids; bytes32 opener; TransferApproval.Data approval; uint256[] signerIdx; bytes[] envelopes; }`
    - `function emergencyExecute(EmergencyAuth calldata auth) external`: a DEFAULT frame from
      `0xaa`. The account verifies the quorum itself against `COMMITMENT` and the
      `TransferApproval`, which must have `maxFee = 0`. It rejects leaves used here or reported by
      `IPostcurvePaymaster(PAYMASTER).isLeafUsed`, records them in its own storage, and transfers
      `approval.amount` of `approval.token` to `approval.to`. Gas is paid by whoever sponsors the
      transaction.
  - `interface IPostcurvePaymaster { function isLeafUsed(bytes32 identityHash, uint256 leaf) external view returns (bool); }`,
    defined here. Task 5 implements it; tests here mock it.
  - `StealthBunkerFactory(address paymaster, address frameOps)` with:
    - `addressOf(bytes32 commitment) view returns (address)`;
    - `deploy(bytes32 commitment) returns (address)`, which is idempotent.
- Consumes: Task 3 libraries; `WotsXmss`.

- [ ] **Step 1: Write the failing tests.** Mock the helpers, as the workshop's `HegotaMocks` does:
  - `factory.addressOf(c)` equals the TS `stealthAddress` for the vectors' deployment, and `deploy`
    lands at that address.
  - `verifyExecution` approves for the exact shape `[only_verify, pre_verify(PM), pay(PM), sender(token), sender(token)]`.
  - It reverts for each of these:
    - a payer other than `PAYMASTER`;
    - a missing `pre_verify`;
    - a third SENDER frame;
    - SENDER frames targeting two different tokens;
    - a caller that isn't `0xaa`.
  - `emergencyExecute` with a valid 2-of-3 transfers. A reused leaf, a wrong opener, or a
    1-of-3 reverts.
- [ ] **Step 2: Run** `forge test --match-path test/stealth/Account.t.sol`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add `@forshtat/hegota-support` (bun, in `contracts/`) and
  `openzeppelin-contracts` (forge install) with remappings.
- [ ] **Step 4: Run** `forge test`. Expected: all PASS.
- [ ] **Step 5: Commit and push:** `feat(contracts): add stealth bunker account, factory and frame ops`.

### Task 5: Postcurve paymaster

**Files:** Create `contracts/src/stealth/PostcurvePaymaster.sol`; Test `contracts/test/stealth/Paymaster.t.sol`.

**Interfaces:**
- Produces: `PostcurvePaymaster(address factory, address registry)`, inheriting
  `HegotaSupport(Devnet.ERC8421_WORKSHOP)`, with:
  - `struct SpendAuth { uint256 threshold; StealthProfile.Identity[] ids; bytes32 opener; TransferApproval.Data approval; uint256[] signerIdx; bytes[] envelopes; uint256 fee; }`
  - `function preVerify(SpendAuth calldata auth) external`, the `pre_verify` target. It:
    - requires `msg.sender == 0xaa`, and `sender = txparam(SENDER)` equal to `factory.addressOf(sender.COMMITMENT())`;
    - checks that `StealthProfile.commitment(spendKey(threshold, ids), opener) == sender.COMMITMENT()`;
    - checks at least `threshold` distinct `signerIdx`, each with `WotsXmss.verify` ok over
      `TransferApproval.digest(approval, chainid, sender)` and its leaf unused;
    - checks that frames +2 and +3 are SENDER frames calling `approval.token` with exactly
      `transfer(approval.to, approval.amount)` and `transfer(address(this), auth.fee)`, where
      `auth.fee <= approval.maxFee`;
    - checks `block.timestamp <= approval.validUntil`;
    - marks the leaves used and records `pending[sender] = txparam(SIG_HASH)`.
  - `fallback()` for the `pay` frame: requires the immediately preceding frame to be this
    contract's `pre_verify` with status success (`FRAMEPARAM` status), and
    `pending[sender] == txparam(SIG_HASH)`. It then deletes `pending[sender]` and
    `approve(Scope.PAYMENT)`.
  - `function isLeafUsed(bytes32 identityHash, uint256 leaf) external view returns (bool)`
    (implements Task 4's `IPostcurvePaymaster`), where `identityHash = keccak256(abi.encode(root, pubSeed))`.
  - It does not check the account's token balance during validation. If the fee transfer fails,
    the paymaster loses that tx's gas. Only a holder of a valid quorum can cause this, so it's
    an accepted, documented risk.
  - `receive()` for ETH deposits, and `stake()` calling `registry.addStake{value}(86400)`.
- Consumes: Tasks 3–4.

- [ ] **Step 1: Write the failing tests** (with mocks):
  - A valid 2-of-3 passes `preVerify`, and `pay` approves.
  - Each of these is rejected:
    - fewer than `threshold` valid approvals;
    - the same signer counted twice;
    - a leaf used in an earlier tx;
    - the same leaf twice in one auth;
    - a wrong opener;
    - identities for a different account;
    - fee > maxFee;
    - a different recipient or amount in frame +2;
    - an expired `validUntil`;
    - `pay` without a preceding successful `pre_verify`;
    - `pay` with a stale `pending`.
- [ ] **Step 2: Run** `forge test --match-path test/stealth/Paymaster.t.sol`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `forge test -vv`. Expected: all PASS. Log the gas of a 2-of-3 `preVerify`.
- [ ] **Step 5: Commit and push:** `feat(contracts): add the postcurve paymaster`.

### Task 6: Test token, announcer and devnet deploy script

**Files:** Create `contracts/src/stealth/TestUSDC.sol`, `contracts/src/stealth/ERC5564Announcer.sol`
(vendored from pq-sap, MIT, credited), `sdk/scripts/deploy-stealth.ts`; Test `contracts/test/stealth/Token.t.sol`.

**Interfaces:**
- Produces:
  - `TestUSDC`: an ERC-20 with the Global Constraints name, symbol and 6 decimals.
    `mint(address,uint256)` is restricted to the deployer (test-only).
  - `ERC5564Announcer.announce(uint256 schemeId, address stealthAddress, bytes ephemeralPubKey, bytes metadata)`
    emits the standard `Announcement`.
  - `deploy-stealth.ts` writes `devnet/data/stealth-deployment.json` (gitignored), containing
    `{ chainId, frameOps, factory, paymaster, token, announcer, registry }`. It deploys everything
    with the `deployer` key, funds the paymaster with 1 ETH, and stakes it.
- [ ] **Step 1: Write the failing test.** The token reports decimals 6 and the name contains
  "Test"; a non-deployer can't mint; `announce` emits the event with the given fields.
- [ ] **Step 2: Run** `forge test --match-path test/stealth/Token.t.sol`. Expected: FAIL.
- [ ] **Step 3: Implement** the contracts and the deploy script, using viem against
  `http://127.0.0.1:18545` and the legacy-tx pricing from `devnet/README.md`.
- [ ] **Step 4: Run** `forge test`, then `bun scripts/deploy-stealth.ts`. Expected: every
  address has code, and the registry reports the paymaster as staked.
- [ ] **Step 5: Commit and push:** `feat: add test USDC, the announcer and the devnet deploy script`.

### Task 7: End-to-end stealth spend on the local devnet

**Files:** Create `sdk/scripts/e2e-stealth.ts`, `sdk/src/vendor/pq-sap/` (frame-tx codec, MIT, with
README credit); Modify `README.md`, `docs/devnet-notes.md`.

**Interfaces:**
- Consumes: everything above, and `devnet/data/stealth-deployment.json`.

- [ ] **Step 1: Write the integration test as the script's assertions.** These run against the
  live devnet; the script exits non-zero on the first failed check:
  1. Alice sets up three approvers: two in-process SDK approvers labelled "software (test)" and
     a paper seed. Her viewing key comes from the paper seed. She publishes a meta-address.
  2. Bob mints 100 tUSDC to himself, `send`s to Alice's meta-address, transfers 25 tUSDC to the
     stealth address, and announces with scheme id 2.
  3. Alice reads the `Announcement` logs and `scan` finds exactly one payment, with the opener.
  4. Alice builds a `TransferApproval` (25 − fee to her destination, `maxFee` 1 tUSDC), and two
     approvers sign it. She builds the frame tx `[deploy, only_verify, pre_verify, pay, sender, sender]`
     with the paymaster as payer. Submitting it with `eth_sendFrameTransaction` to the sidecar is
     **admitted**.
  5. The tx is mined. The destination holds 25 − fee tUSDC, the paymaster holds the fee, and the
     stealth account holds 0. The paymaster's ETH went down by the gas used.
  6. Resubmitting the same approvals in a new tx is rejected (leaf reuse).
- [ ] **Step 2: Run** `bun scripts/e2e-stealth.ts`. Expected: FAIL at check 1 (script incomplete).
- [ ] **Step 3: Implement** the script, reusing pq-sap's frame-tx codec for encoding and the
  sidecar's `eth_sendFrameTransaction`. Print the admitted tx hash.
- [ ] **Step 4: Run** `bun scripts/e2e-stealth.ts`. Expected: all six checks pass, and the tx hash is printed.
- [ ] **Step 5: Document** the run command and a sample output in `README.md` and `docs/devnet-notes.md`.
- [ ] **Step 6: Commit and push:** `feat: end-to-end stealth spend through the paymaster on the local devnet`.
