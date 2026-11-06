# postcurve

Security for Ethereum funds after elliptic curves fall.

AI-accelerated math and quantum computers may break ECDSA sooner than expected. postcurve
checks which of your addresses have exposed their public key, lets you receive privately into
fresh accounts that only hash-based keys can spend (gas paid in USDC by a paymaster), and watches
for the first signs that someone is breaking exposed keys.

Built at ETHGlobal Mumbai 2026.

## Status

The signature core works in TypeScript and Solidity; everything else is in progress. Read
[docs/design.md](docs/design.md) for what we're building and why,
[docs/threat-model.md](docs/threat-model.md) for the sources behind it, and
[docs/plans/](docs/plans/) for the build plans.

## Running the tests

Needs [Bun](https://bun.sh) 1.4+ and [Foundry](https://getfoundry.sh) 1.7+.

```sh
git clone --recurse-submodules <repo>
cd sdk && bun install && bun test          # TypeScript signer, 56 tests
cd ../contracts && forge test -vv          # Solidity verifier + gas figures
cd ../sdk && bun scripts/gen-vectors.ts    # regenerate spec/vectors (tests check it's unchanged)
```

## Parts

| Part | What it does | Status |
|---|---|---|
| Signature core | Hash-only WOTS/XMSS approvals shared by browser, contract and Firefly ([spec](spec/signature.md)) | done (TS + Solidity) |
| Check | Shows which addresses revealed their public key and the value behind them, with private reads via Anon-RPC | planned |
| Stealth bunker account | A fresh EIP-8141 account per payment (pq-sap stealth address) that only a hash-only quorum can spend | planned |
| Paymaster | Pays a stealth account's gas in exchange for test USDC and carries the quorum check | planned |
| Send and scan | pq-sap meta-address, sending to a stealth address, scanning announcements | planned |
| Approvers | Browser and paper approvers; Firefly approver firmware as a separate sub-project | planned |
| Canary | Chainlink CRE workflow watching dormant exposed addresses; ESP32 light as a separate sub-project | in progress |
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
