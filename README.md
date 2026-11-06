# postcurve

Security for Ethereum funds after elliptic curves fall.

AI-accelerated math and quantum computers may break ECDSA sooner than expected. postcurve
checks which of your addresses have exposed their public key, lets you receive privately into
fresh accounts that only hash-based keys can spend (gas paid in USDC by a paymaster), and watches
for the first signs that someone is breaking exposed keys.

Built at ETHGlobal Mumbai 2026.

## Status

The core flow works end to end on the local devnet: a pq-sap stealth payment in test USDC, found
by scanning, spent with a 2-of-3 hash-only approval, gas paid in test USDC by the postcurve
paymaster, admitted by the alt mempool sidecar. The canary runs as a Chainlink CRE simulation. Read
[docs/design.md](docs/design.md) for what we're building and why,
[docs/threat-model.md](docs/threat-model.md) for the sources behind it, and
[docs/plans/](docs/plans/) for the build plans.

## Running the tests

Needs [Bun](https://bun.sh) 1.4+ and [Foundry](https://getfoundry.sh) 1.7+.

```sh
git clone --recurse-submodules <repo>
cd sdk && bun install && bun test          # TypeScript SDK, 84 tests
cd ../contracts && bun install && forge test -vv   # Solidity contracts (68 tests) + gas figures
cd ../sdk && bun scripts/gen-vectors.ts    # regenerate spec/vectors (tests check it's unchanged)
```

## Running the end-to-end stealth spend

Needs the local devnet ([devnet/README.md](devnet/README.md)) running the patched sidecar image.

```sh
cd contracts && bun install && forge build
cd ../sdk && bun scripts/deploy-stealth.ts   # frame ops, staked paymaster + factory, test USDC, announcer
bun scripts/e2e-stealth.ts                   # 11 checks, exits non-zero on the first failure
```

Sample output (2026-11-06):

```
PASS 1. TS stealth address = factory.addressOf
PASS 2. Alice publishes a 2-of-3 meta-address: 1217 bytes
PASS 3. Bob paid 25 tUSDC to a fresh stealth address
PASS 4. Alice's scan finds exactly her payment
PASS 5. sponsor deployed the stealth account at the derived address
PASS 6. the alt mempool sidecar admits the frame tx
PASS 7. the frame tx is mined and every frame succeeded: block 116, gasUsed 1207750, frames [0x1,0x1,0x1,0x1,0x1,0x1]
PASS 8. destination received the transfer and the stealth account is empty: 24.5 tUSDC
PASS 9. paymaster received its fee in tUSDC: 0.5
PASS 10. paymaster paid the gas in ETH: 0.0024155 ETH
PASS 11. replaying the same approvals is rejected: keys already used
```

## Parts

| Part | What it does | Status |
|---|---|---|
| Signature core | Hash-only WOTS/XMSS approvals shared by browser, contract and Firefly ([spec](spec/signature.md)) | done (TS + Solidity) |
| Check | Shows which addresses revealed their public key and the value behind them, with private reads via Anon-RPC | planned |
| Stealth bunker account | A fresh EIP-8141 account per payment (pq-sap stealth address) that only a hash-only quorum can spend | done (local devnet) |
| Paymaster | Pays a stealth account's gas in exchange for test USDC and carries the quorum check | done (local devnet) |
| Send and scan | pq-sap meta-address, sending to a stealth address, scanning announcements ([profile](spec/stealth-profile.md)) | done (SDK; UI planned) |
| Approvers | Browser and paper approvers, a software device signer ([sdk/scripts/device-signer.ts](sdk/scripts/device-signer.ts)); Firefly firmware as a separate sub-project | SDK done; UI planned |
| Canary | Chainlink CRE workflow watching dormant exposed addresses ([canary/](canary/README.md)); ESP32 light as a separate sub-project | done (CRE CLI simulation, devnet demo) |
| Exposure dataset | Canary watchlist and exposure records as queryable Arkiv entities | later |
| Move | Careful migration from an exposed address into a bunker | later |
| Local devnet | ethrex + Lighthouse + alt mempool sidecar on 127.0.0.1 ([devnet/](devnet/README.md)) | running |

## Joining the project

- Start with [docs/design.md](docs/design.md). Its "Calls made during design" and "Left to the
  builder" sections show what is settled and what is open.
- Each part gets its own folder with a README explaining how to run it, added as the part lands.
- Commit small and often, with Conventional Commit messages (`feat:`, `fix:`, `docs:`, ...).
  Judges review the history.
- Never commit keys, seeds or RPC credentials; `.env` files are ignored.

## License

MIT, see [LICENSE](LICENSE).
