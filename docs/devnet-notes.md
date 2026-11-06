# EIP-8141 alt mempool devnet: working notes

A local copy of this devnet (ethrex + Lighthouse + sidecar, chain 1337 on 127.0.0.1) runs
from [`devnet/`](../devnet/README.md): `./devnet.sh up`.

Gathered 2026-11-06 from the workshop repos. The devnet can be reset at any time; re-check
before relying on an address.

- Workshop (start here): https://github.com/forshtat/mempool-workshop
- Mempool node ("sidecar") and full RPC reference (`deploy/devnet/devnet-readme.md`):
  https://github.com/forshtat/mempool-workshop-sidecar
- Docs: https://docs.altmempool.wtf/ · Explorer (has a Faucet button): https://explorer.altmempool.wtf/

## Network

| Item | Value |
|---|---|
| Chain id | `1337` |
| Gateway RPC (everything goes here) | `https://altmempoolgateway.forshtat.com/rpc` |
| Staking registry (`NaiveStakingRegistry`) | `0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f` |
| Entry-point sentinel | `0x00000000000000000000000000000000000000aa` |
| Keyed nonces (EIP-8250) `NONCE_MANAGER` | `0x…8250` |
| Recent roots (EIP-8272) | `0x…8272` |
| Execution client | ethrex, branch `eip8141-tracer` |

The gateway validates frame transactions against the standard alt-mempool rules, gossips them
to the miner, and forwards `eth_*` reads and `eth_sendRawTransaction` to ethrex.

## Rules that matter for postcurve

- **Canonical mempool:** `MAX_VERIFY_GAS` is 100,000 for the validation prefix. Hash-based
  quorum verification won't fit (one WOTS/XMSS approval cost ~318k gas in the May prototype).
- **Standard alt mempool: no bigger staked budget exists today.** The sidecar caps the
  validation prefix at `MAX_VERIFY_GAS = 100,000` for every sender, staked or not
  (`packages/executor/src/services/UserOpValidation/utils/validationPrefix.ts`, upstream
  `2e22ff0`, 2026-10-25; confirmed on the local devnet, where a staked wallet's ~600k-gas
  VERIFY frame was rejected). The cap applies to the *declared* `limits.execution` of the
  prefix frames plus signature cost. `MAX_VERIFY_GAS_STAKED_ENTITY` appears only in design docs.
  Staking still relaxes the storage-access rules. **Ask the alt mempool team whether a hackathon
  devnet runs a raised budget**: the EF prize text names >100k verification (PQ wallets) as the
  target use case.
- **Privileged path:** `ethrex_submitPrivilegedFrameTransaction` mines frame txs without any
  mempool rules. It's useful locally, but it isn't alt mempool admission and doesn't count for
  the prize.
- **Staking:** call `addStake(86400)` on the registry, sending more than `minStake` (0.01 ETH on
  the devnet; strictly greater is needed for the `BALANCE`/`SELFBALANCE` carve-out). Calling
  `unlockStake()` drops the staked carve-outs immediately.
- **Reputation:** entities are `OK` / `THROTTLED` / `BANNED` based on seen versus included txs.

## Measured

Plain-Solidity `WotsXmss.verify` (`contracts/src/WotsXmss.sol`), solc 0.8.28, optimizer 1000
runs, execution gas of the verifier call only (`forge test -vv`, 2026-11-06):

| Case | Gas | vs canonical `MAX_VERIFY_GAS` (100,000) |
|---|---|---|
| One approval | 282,460 | 2.8× |
| Two approvals (a 2-of-3 quorum) | 529,165 | 5.3× |

Calldata is extra: each envelope is 2,432 bytes. These figures are the unoptimized baseline;
the allocation-heavy `abi.encode` in the hash loops is the obvious first target if the staked
budget turns out tighter.

## Gotchas (from the sidecar's devnet readme)

- A `SENDER` frame that sends value to an address with no account needs `limits.state > 0`;
  otherwise the frame halts and burns its whole execution limit.
- More nonce keys cost more validation gas (7 keys needed ~80k).
- Fund a paymaster through the `value` of its `CREATE`, never with a later transfer.
- A freshly created contract account starts at nonce 1. A wallet built on `HegotaSupport`
  deploys 7 helper contracts, so it starts at nonce 8.
- Contract creation costs state gas on this devnet: ~6M gas limit works where 900k reverted.
- Legacy transactions: base fee is 7 wei; the workshop uses a 0.002 gwei gas price.

## Writing contracts

The workshop's contracts use vanilla `solc` plus the `@forshtat/hegota-support` base contract,
which deploys one small Yul helper per new opcode (`APPROVE`, `TXPARAM`, `SIGPARAM`, ...). A
community `solc` fork (`chiranjeev13/solidity`, `v0.8.38-eip8141.0`) exposes them as Yul
builtins, but it is marked very experimental and has never been run on the devnet.

## Still to verify (the devnet test)

1. A first frame tx and a wallet-validated tx go through (workshop steps 1–5).
2. The staked verification budget is big enough for a 2-of-3 WOTS/XMSS quorum (~530k gas
   measured, see above).
3. A wallet whose `VERIFY` frame burns roughly 600k gas is admitted when staked and rejected when
   unstaked.
