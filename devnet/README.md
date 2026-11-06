# Local EIP-8141 devnet

A single-machine Hegota devnet for testing frame transactions without the public devnet:
ethrex (execution) + Lighthouse (consensus, two beacon nodes and a validator client) + the
alt-mempool sidecar, all in Docker. Adapted from
[forshtat/mempool-workshop-sidecar](https://github.com/forshtat/mempool-workshop-sidecar)
`deploy/devnet` (MIT). The fork schedule, genesis workarounds and images are the upstream ones;
the laptop changes are listed at the top of `docker-compose.yml`.

## Prerequisites

- Linux with Docker and Compose v2.24 or later (tested: Docker 29.8, Compose 5.5).
- Foundry's `cast`, plus `jq`, `curl`, `openssl` and `ss` (iproute2).
- `bun`, only for `./devnet.sh smoke`.
- About 2.2 GB of images. The first `up` pulls them, one at a time and with retries.
- No root needed. Nothing listens beyond `127.0.0.1`.

## Commands

All from this directory.

| Command | What it does |
|---|---|
| `./devnet.sh up` | First run: generates keys and genesis in `data/`. Then starts everything, deploys the staking registry, waits until Hegota is active, and prints `status`. `--no-wait` returns right after starting the containers. |
| `./devnet.sh down` | Stops and removes the containers. The chain stays in `data/`, and `up` resumes it. |
| `./devnet.sh reset` | Runs `down`, deletes `data/` through a container (some files are root-owned, so no `sudo` is needed), then runs `up`. You get new keys, a new genesis and new addresses. `--no-up` only wipes. |
| `./devnet.sh status` | Shows containers, head block and age, active fork, beacon sync and peers, sidecar, and the registry. |
| `./devnet.sh wait-hegota` | Blocks until frame transactions are valid. |
| `./devnet.sh predeploy` | Deploys `NaiveStakingRegistry`. Idempotent, and `up` already runs it. |
| `./devnet.sh accounts` | Lists funded account names, addresses and balances. Never prints keys. |
| `./devnet.sh key NAME` | Prints one private key to stdout, for `$(...)`. |
| `./devnet.sh smoke [canonical\|sidecar\|heavy]` | Frame-tx smoke tests (`tools/smoke.ts`). |
| `./devnet.sh logs [SERVICE]` | Follows container logs. |
| `./devnet.sh compose ARGS` | Runs `docker compose` with this project's file and `data/compose.env`. |

## Endpoints

| | |
|---|---|
| Chain id | `1337` (`0x539`), the same as the public devnet |
| ethrex JSON-RPC (canonical mempool, `eth_*`, `ethrex_*`, `debug_*`) | `http://127.0.0.1:18545` |
| Sidecar JSON-RPC and WebSocket (`eth_sendFrameTransaction`, `skandha_*`) | `http://127.0.0.1:14337/rpc` |
| Beacon API (lighthouse-beacon) | `http://127.0.0.1:15052` |
| Entry-point sentinel | `0x00000000000000000000000000000000000000aa` |
| Staking registry | `stakingRegistry` in `data/devnet.json` (it changes on every reset) |
| Docker subnet | `172.31.81.0/24` (ethrex `.10`, beacons `.11` and `.12`, validator `.13`, sidecar `.20`) |

`up` refuses to start if one of these host ports is taken, or if the subnet is already in use.
To pick others, set them before the first `up`, for example
`DEVNET_RPC_PORT=28545 DEVNET_SIDECAR_PORT=24337 DEVNET_BEACON_PORT=25052 DEVNET_SUBNET_PREFIX=172.31.99 ./devnet.sh up`.
They are then fixed in `data/compose.env`: edit that file, or `reset`, to change them.

The sidecar also proxies the standard reads and `eth_sendRawTransaction` to ethrex
(`--redirectRpc`). So `http://127.0.0.1:14337/rpc` works as a "gateway" URL, the way the
workshop uses one.

## How long until Hegota

On a fresh `data/`, genesis (slot 0) comes 60 s after setup. Slots are 6 s, and an epoch is
192 s. Amsterdam activates at epoch 1 and Hegota at epoch 2, so frame transactions are valid
about 7.5 minutes after `up` or `reset`. Blocks start 60 s after setup. Ordinary transactions
work from then on. `status` and `wait-hegota` show the countdown. The exact times are in
`data/devnet.json` (`hegotaTime`), taken from `bogotaTime` in `genesis.json` (ethrex's name
for Hegota). A resumed chain (`down`, then `up`) is already past Hegota.

## Funded keys

Each `up` on an empty `data/` generates fresh keys and stores them only in
`data/keys/accounts.json` (mode 600, gitignored). That file is a JSON list of
`{name, balanceEth, address, privateKey}`. Funded at genesis:

| name | ETH | used for |
|---|---|---|
| `dev` | 1,000,000 | your main account; also the validators' fee recipient |
| `user1`, `user2`, `user3` | 1,000 each | tests (`smoke` uses them) |
| `deployer` | 100 | deploys the staking registry; its first CREATE (nonce 0) fixes the address |
| `faucet` | 10,000 | the sidecar's faucet (`skandha_explorer_faucet`, 1 ETH per address per hour) |
| `relayer` | 100 | the sidecar's relayer key |

```sh
./devnet.sh accounts
cast send --private-key "$(./devnet.sh key user1)" --rpc-url http://127.0.0.1:18545 ...
# or from the sidecar faucet, for any address:
curl -s http://127.0.0.1:14337/rpc -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"skandha_explorer_faucet","params":["0xYourAddress"]}'
```

Other generated secrets, also only under `data/`:

- `data/keys/validator.mnemonic`: the validators' mnemonic.
- `data/keys/sidecar-admin.key`: the admin key for the sidecar's `debug_bundler_*` methods.
- `data/sidecar/config.json` and `data/sidecar/sidecar.env`: the relayer, faucet and admin keys.

These keys guard nothing. Still, never reuse them anywhere else, and don't paste them.

## Sending frame transactions

`tools/smoke.ts` is working reference code. It uses `@forshtat/hegota-support` (profile
`ethrex-eip8141-tracer`), the same library the workshop uses.

- **Canonical mempool:** send the RLP form (`0x06 || rlp`, `encodeTx`) with
  `eth_sendRawTransaction` to ethrex. ethrex applies EIP-8141's own rules, including
  `MAX_VERIFY_GAS = 100,000` for the validation prefix.
- **Standard alt mempool (sidecar):** send the JSON form (`toWire`) with
  `eth_sendFrameTransaction` to the sidecar. Follow it with `skandha_frameTransactionStatus`
  (`New` → `Submitted` → `OnChain`, about 10 s), or with ethrex's `eth_getTransactionReceipt`.
- **No mempool at all:** `ethrex_submitPrivilegedFrameTransaction` (raw form, on 18545) forces
  the tx into the next block, with no admission checks. It is one-shot: if the next block misses
  it, it is dropped. This is what the sidecar uses to relay.
- Dry runs: `ethrex_simulateFrameTransaction` (raw form; `{"trace": true}` adds the ERC-7562
  trace) and `eth_estimateFrameTransactionGas` (sidecar).

Sidecar debug methods (`debug_bundler_dumpMempool`, `setReputation`, `clearState`, ...) need
the admin key, because requests reach the container from the Docker gateway rather than
localhost:

```sh
curl -s http://127.0.0.1:14337/rpc -H 'content-type: application/json' \
  -H "authorization: $(cat data/keys/sidecar-admin.key)" \
  --data '{"jsonrpc":"2.0","id":1,"method":"debug_bundler_dumpMempool","params":[]}'
```

The full RPC reference and the frame-tx cheat sheet are upstream, in
`deploy/devnet/devnet-readme.md`.

### Staking

`NaiveStakingRegistry` (ERC-8421 `IStakingRegistry`, source in `contracts/`) is the only
predeploy, and the sidecar is configured with its address. Stake with `addStake(86400)` and
`msg.value` strictly above `minStake` (0.01 ETH). The registry keys everything off
`msg.sender`, so a contract wallet must stake itself: give it a `SENDER` frame that calls
`addStake`, as `smoke heavy` and the workshop's step 7 do. `unlockStake()` drops the staked
carve-outs right away.

## Verified (2026-11-06)

Two full runs from an empty `data/`. Both first runs (`up`, then `reset`) went from setup to
Hegota in about 7.5 minutes. `down` and `up` resumed the same chain with the beacon pair
re-peered.

- Blocks every 6 s through the Amsterdam and Hegota boundaries.
- `smoke canonical`: a self-relay frame tx (`VERIFY` + `SENDER`, the workshop's step 2 shape),
  sent raw to ethrex, mined. Both frames succeeded, gasUsed 26,102. On the second run it was
  sent in the first Hegota block and silently dropped. Resent later, it mined (see Gotchas).
- `smoke sidecar`: the same shape through `eth_sendFrameTransaction`, mined, and the sidecar
  reported `OnChain`.
- `smoke heavy`: a wallet whose `VERIFY` frame burns about 600k gas. While unstaked, both
  mempools reject it, which is correct. The wallet then staked 0.02 ETH through its own
  `SENDER` frame; that tx was mined and the registry shows the stake. Sent straight to
  `ethrex_submitPrivilegedFrameTransaction`, the heavy tx was mined with both frames
  succeeding (gasUsed 622,407). So block execution accepts a heavy `VERIFY` frame.
- The sidecar faucet sent 1 ETH. `debug_bundler_*` worked with the admin key and was refused
  without it.

Versions: ethrex `v23.0.0-eip8141-tracer-9aa3645`, Lighthouse `v8.1.3-52e5197`
(`ethpandaops/lighthouse:focil`), the sidecar image built 2026-10-25 (upstream master
`2e22ff0`), and `ethereum-genesis-generator:6.1.6`. The ethrex and sidecar tags follow
branches; check `web3_clientVersion` if behaviour changes after a pull.

## What is not working yet

1. **The sidecar does not admit a staked sender's heavy-validation frame tx.** It applies
   `MAX_VERIFY_GAS = 100,000` to the summed `limits.execution` of every validation prefix,
   staked or not. The error is "validation prefix execution gas sum ... exceeds
   MAX_VERIFY_GAS 100000". `MAX_VERIFY_GAS_STAKED_ENTITY` (ERC-8421 `BUDGET-010`) is not
   implemented: the sidecar's own design doc lists it as a non-goal
   (`docs/superpowers/specs/2026-09-28-prevalidate-frame-design.md`). This was checked in the
   published image and in upstream master `2e22ff0`. So the staked-budget question in
   `docs/devnet-notes.md` is answered: on today's sidecar, there is no larger budget at all.
   `smoke heavy` reports this as `KNOWN-GAP` and prints `PASS` if it ever changes.
   Workaround for local testing: submit with `ethrex_submitPrivilegedFrameTransaction`. That
   mines it, but it tests no mempool rule at all.
2. Only the staking registry is predeployed. Upstream's token and DeFi replays (LINK, USDT,
   Uniswap v4 and others, `deploy/predeploy`) are not. Their `fund` step uses upstream's
   genesis key, which this chain does not fund. Running `bun run predeploy run --all` with
   `PREDEPLOY_RPC_URL` and a `PREDEPLOY_DEPLOYER_KEY` funded from `dev` might work. Not tried.
3. One sidecar node (the miner role), with no gateway and no p2p gossip pair. Reputation
   accounting is that one node's.
4. The workshop client (`forshtat/mempool-workshop`) has not been run against this devnet. In
   principle you point `gatewayUrl` at `http://127.0.0.1:14337/rpc` and `stakingRegistry` at
   the address in `data/devnet.json`, but that is untested.
5. There is no block explorer.

## Gotchas

- **A young chain's base fee is high.** It starts near 1 gwei and decays slowly toward
  upstream's 7 wei. A legacy tx priced at the workshop's 0.002 gwei sits pending for minutes.
  Price at about 2× `eth_gasPrice`, as the scripts do. Frame txs at 2 gwei `maxFeePerGas`
  are fine.
- Frame transactions are invalid before Hegota. Ethrex rejects them, and the sidecar fails
  on them.
- **Wait a couple of blocks past the fork.** Once, a raw frame tx sent to ethrex in the very
  first Hegota block was accepted (it returned a hash) and then silently dropped: it never
  appeared in `txpool_status` and was never mined. The identical tx mined normally when resent
  a few minutes later. `wait-hegota` and `smoke` now wait two slots past activation. If a raw
  frame tx neither mines nor shows in `txpool_status`, resend it.
- Give contract creation about 6M gas (state gas). A transfer to a brand-new account needs
  about 204,600 gas, or `limits.state > 0` in a `SENDER` frame.
- Fund a contract wallet or paymaster through its `CREATE` value. A later plain transfer runs
  its `APPROVE` code outside a frame and reverts.
- A freshly created contract starts at nonce 1. A `HegotaSupport` wallet starts at 8.
- The sidecar holds one tx per sender in flight. Send the next one after the previous lands.
- The genesis log `data/logs/genesis.log` contains the validator mnemonic: the generator runs
  with `set -x`. The scripts never print it. Don't share that file.
- There are two beacon nodes on purpose. A lone Lighthouse with zero peers never leaves
  `SyncState::Stalled`, so it never builds a block. `status` should show `peers 1`. The pair
  dials each other by fixed IP, so there is no ENR step.
- No restart policy, except the sidecar's `on-failure` (it exits if ethrex is not up yet).
  After a reboot, run `./devnet.sh up`. The chain resumes and skips the missed slots.
- Image pulls from Docker Hub and GHCR timed out here when run in parallel. `up` pulls one
  image at a time and retries.
- Container logs are capped (20 MB × 3 per service), so they cannot fill the disk.
