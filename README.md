# postcurve

Security for Ethereum funds after elliptic curves fall.

AI-accelerated math and quantum computers may break ECDSA sooner than expected. postcurve
checks which of your addresses have exposed their public key, moves funds carefully into a
bunker account protected only by hash-based signatures, and watches for the first signs that
someone is breaking exposed keys.

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
cd sdk && bun install && bun test          # TypeScript signer, 53 tests
cd ../contracts && forge test -vv          # Solidity verifier + gas figures
cd ../sdk && bun scripts/gen-vectors.ts    # regenerate spec/vectors (tests check it's unchanged)
```

## Parts

| Part | What it does | Status |
|---|---|---|
| Signature core | Hash-only WOTS/XMSS approvals shared by browser, contract and Firefly ([spec](spec/signature.md)) | done (TS + Solidity) |
| Check | Shows which addresses revealed their public key and the value behind them, with private reads via Anon-RPC | planned |
| Move | Careful migration: test transfer, recovery check, then the rest | planned |
| Bunker | EIP-8141 account with a hash-based (WOTS/XMSS) quorum, sent through the alt mempool | planned |
| Approver device | Firefly Pixie firmware that holds one approver's one-time keys | planned |
| Canary | Chainlink CRE workflow watching dormant exposed addresses, plus an ESP32 alert light | planned |
| Exposure dataset | Exposure results published as queryable Arkiv entities | planned |

## Joining the project

- Start with [docs/design.md](docs/design.md). Its "Calls made during design" and "Left to the
  builder" sections show what is settled and what is open.
- Each part gets its own folder with a README explaining how to run it, added as the part lands.
- Commit small and often, with Conventional Commit messages (`feat:`, `fix:`, `docs:`, ...).
  Judges review the history.
- Never commit keys, seeds or RPC credentials; `.env` files are ignored.

## License

MIT, see [LICENSE](LICENSE).
