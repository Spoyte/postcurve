# canary: early warning that exposed curve keys may be breaking

Part 5 of [postcurve](../docs/design.md). A watcher over large, long-dormant addresses
whose public key is already on-chain. When one of them suddenly moves most of its
balance, the canary says so, in public, with the numbers it used.

It runs as a **Chainlink CRE workflow**: a cron trigger reads balances from an EVM chain,
compares them with the state it stored last time, and pushes an alert to an external
HTTP system. The alert format is a published JSON schema, so the ESP32 "canary light"
(a later sub-project; no hardware here) can consume it without knowing anything about
CRE.

## Why this is the thing to watch

The threat model is in [../docs/threat-model.md](../docs/threat-model.md). Justin Drake's
"bunker mode" post (7 Oct 2026) and the Devcon talk "Steal Now, Reveal Never" make the
same point from two directions: the first people able to recover private keys from public
keys will not announce it. They will be quiet and selective. Their natural first targets
are addresses that are **large**, **long dormant** (nobody is watching, nobody will
notice quickly, no risk of a race with the owner) and **already exposed** (the public key
is on-chain, so the work can be done offline, long before the theft).

That is a specific, observable signature. A sweep out of such an address is not proof of
anything, but it is the first place a break would show up, and nobody has to trust us to
check it: the watchlist, the thresholds and the evidence are all public.

## What it proves, and what it does not

**What an alert says:** this address, with this much value, whose public key has been on
the chain since this block, had sent nothing for this long, and has just moved this share
of its balance in this transaction.

**What an alert does not say:** that anyone broke a key. Owners wake up. Exchanges move
cold storage. Heirs find seed phrases. A lost-and-found wallet looks exactly like a
stolen one from the outside. Every alert carries that sentence in its `proves` field, and
the hardware canary is a prompt to go and look, not a verdict.

The signal that would matter is a **cluster**: several unrelated dormant addresses
sweeping inside the same window. The alert carries `cluster.alertsThisRun` for exactly
that reason, and severity is raised to `alarm` when more than one address alerts in the
same run.

Known limits, all of them honest:

- The canary sees **native ETH balances only**. An address swept of ERC-20s or NFTs while
  keeping its ETH will not alert.
- Dormancy is measured from the **last outgoing value** the canary or the builder could
  prove, not from the last signature. An address that has been signing permits off-chain
  looks dormant here.
- A new address enters the watchlist with **no baseline**, and the first run only records
  one. A sweep that happens before the first run is missed.
- Thresholds are blunt instruments. An attacker who moves 40% of a balance, or who waits
  out the dormancy window with a small transaction first, stays under them.
- The watchlist is built from a **sample** of blocks (see below), so it is a starter list,
  not a census of exposed dormant value.
- Watchlist entries whose dormancy could not be proven at build time cannot alert until
  the canary has watched them for a full dormancy window. On mainnet that is the normal
  case, and it is why the live demo runs on the devnet.

## How it works

```
cron (every minute on the devnet, every 10 minutes on mainnet)
  │
  ├── GET  /watchlist   ─┐  the canary service: an ordinary HTTP system that holds the
  ├── GET  /state       ─┘  watchlist, the last known state and the alert sink
  │
  ├── EVM headerByNumber  → head block and its timestamp (chain time, not wall clock)
  ├── EVM balanceAt × N   → one balance per watched address, pinned to that block
  │
  ├── evaluate()          → alerts + the next state  (workflow/detect.ts, no I/O)
  │
  ├── GET  /locate-move   → the transaction that moved the value, by block scan
  ├── POST /alerts        → the alert webhook   (first: if this fails, nothing is lost)
  └── POST /state         → the new baseline    (only after the alerts are accepted)
```

The blockchain side and the external-system side are both load-bearing, which is what the
Chainlink CRE track asks for: without the chain there is nothing to compare, and without
the service a workflow has nowhere to keep a baseline between runs or to raise an alarm.

**Ordering is deliberate.** Alerts are delivered before the state is advanced. If the
alert sink is down, the state stays where it was, so the next run sees the same drop
again and retries. The reverse order would swallow the one event the whole thing exists
to catch.

**Determinism is deliberate.** In a real DON every node runs the HTTP calls and the
results go through identical-value consensus, so the service answers GETs with
byte-identical bodies for the same state (sorted keys, no server timestamps), and POSTs
are idempotent: an alert whose `id` is already stored is dropped. `id` is
`chainId:address:baselineBlock-observedBlock`, so the same observation can never raise two
alerts.

Files:

| path | what it is |
|---|---|
| `workflow/main.ts` | CRE entry point (`Runner`) |
| `workflow/workflow.ts` | the workflow: trigger, capability calls, config schema |
| `workflow/detect.ts` | the detection logic, pure, no I/O, fully tested |
| `workflow/types.ts` | the three JSON schemas (watchlist, state, alert) |
| `workflow/config.devnet.json`, `workflow/config.mainnet.json` | per-chain config |
| `tools/canary-service.ts` | the external system: watchlist, state, alert sink, move locator |
| `watchlist/build-watchlist.ts` | builds a watchlist from chain data alone |
| `watchlist/watchlist.mainnet.json` | the starter list, 12 verified mainnet addresses (see "Where the watchlist comes from") |
| `watchlist/watchlist.devnet.json` | written by the staged demo from the devnet's own blocks |
| `demo/run-demo.sh` | the whole staged demo, end to end |
| `demo/stage-dormant.ts`, `demo/wait-dormancy.ts`, `demo/sweep.ts`, `demo/devnet.ts` | its steps |
| `workflow/detect.test.ts`, `workflow/workflow.test.ts` | the tests (`bun test workflow`) |
| `project.yaml`, `workflow/workflow.yaml` | CRE project and workflow settings |

## Setup

Needs [bun](https://bun.sh) and the [CRE CLI](https://docs.chain.link/cre). The CLI is
installed with Chainlink's own installer:

```sh
curl -fsSL https://raw.githubusercontent.com/smartcontractkit/cre-cli/main/install.sh | bash
cre version
```

Then:

```sh
cd canary
bun install
```

**No API key, secret or Chainlink service is needed for anything in this README.** Every
simulated run here compiled and executed locally against the local devnet (or a public
RPC) and the local canary service. Deploying to the CRE network would need `cre login`
and `cre account access` (deploy access was not enabled on this machine), and the track
does not require it: "It is NOT mandatory to deploy it during the hackathon, simulation
is enough!". One caveat worth stating plainly: this CLI already held credentials from an
earlier session, so a completely fresh machine may be prompted to `cre login` before
`cre workflow simulate` will run. Nothing in the workflow itself needs an account.

This was built and simulated with **CRE CLI v1.20.0** and **`@chainlink/cre-sdk`
1.23.0**. One wrinkle worth knowing about: the local devnet is chain id 1337, and the CRE
EVM capability has no chain selector for it. Chainlink's registry does list chain 1337
(as `geth-testnet`), but CRE CLI v1.20.0 refuses that name in `project.yaml`, so the
devnet RPC is registered under a selector name the CLI does accept
(`private-testnet-rhyolite`). **The RPC URL is the only thing that decides which chain is
read**, and the real chain id travels in the workflow config and in every alert, so no
reader of an alert is misled. On a newer CLI, change the name in both `project.yaml` and
`workflow/config.devnet.json` to `geth-testnet`.

## Run the simulation

Start the external system, then simulate the workflow against it. Two terminals, or
`&`:

```sh
# terminal 1: the canary service (watchlist + state + alert sink + move locator)
cd canary
bun run tools/canary-service.ts --port 8787 \
  --rpc http://127.0.0.1:18545 \
  --watchlist watchlist/watchlist.devnet.json \
  --data .state/demo

# terminal 2: one simulated run of the workflow
cd canary
cre workflow simulate ./workflow --target devnet-settings --non-interactive --trigger-index 0
```

For mainnet (read-only; still a local simulation, just pointed at a public RPC):

```sh
# port 8788, so a devnet service on 8787 can keep running beside it
bun run tools/canary-service.ts --port 8788 \
  --rpc https://ethereum.publicnode.com \
  --watchlist watchlist/watchlist.mainnet.json \
  --data .state/mainnet

cre workflow simulate ./workflow --target mainnet-settings --non-interactive --trigger-index 0
```

`--trigger-index 0` picks the cron trigger without prompting. Drop
`--non-interactive --trigger-index 0` to choose interactively.

Real output from the mainnet target, two runs a few seconds apart on 2026-11-06, reading
the 12 addresses of the shipped starter list over a public RPC:

```
2026-11-06T13:59:20Z [USER LOG] chain=ethereum mainnet (id 1) head=26355967 at=1793969951 watching=12 known=0
2026-11-06T13:59:23Z [USER LOG] baseline 0xff96ca435ab1e7a1cc47e99cad48dfa2d1831f80: baseline 93695.409169 ETH at block 26355967; dormancy clock starts now (watchlist carried no seed)
2026-11-06T13:59:23Z [USER LOG] baseline 0x6073cf6d98404319f035d368541c765c06354169: baseline 23633.194817 ETH at block 26355967; dormant since block 26336300 per watchlist seed
...
2026-11-06T13:59:23Z [USER LOG] stored state for 12 address(es), service answered 200
✓ "{\"chainId\":1,\"block\":26355967,\"observedAt\":1793969951,\"watched\":12,\"alerts\":[],\"decisions\":{\"baseline\":12},\"mode\":\"cre-cli-simulation\"}"

2026-11-06T13:59:46Z [USER LOG] quiet 0xfdc4c58523befdfebadb796c4eb825c8f7229e93: unchanged at 158.521194 ETH
2026-11-06T13:59:46Z [USER LOG] stored state for 12 address(es), service answered 200
✓ "{\"chainId\":1,\"block\":26355969,\"observedAt\":1793969975,\"watched\":12,\"alerts\":[],\"decisions\":{\"quiet\":12},\"mode\":\"cre-cli-simulation\"}"
```

The first run baselines, the second compares and finds nothing: on mainnet that is the
expected and desirable output, every ten minutes, for as long as nobody is breaking keys.

## Run the staged demo

```sh
cd canary
demo/run-demo.sh
```

It needs the devnet from [../devnet](../devnet) to be up (`./devnet.sh up`) and takes
about three minutes, most of it waiting for the dormancy window. It:

1. stages a fresh account, funds it with 500 ETH from the devnet's `dev` account, and has
   it send one transaction back. That signature is the point: the account's public key is
   now on the chain, which is exactly the exposure the canary watches for. The throwaway
   key is written to `.state/demo-account.json` (mode 600, gitignored) and never printed;
2. builds `watchlist/watchlist.devnet.json` from the devnet's own blocks;
3. starts the canary service;
4. runs the **first CRE simulation**: first sighting, so it records a baseline and stays
   quiet. This is the first-run rule, not a bug;
5. waits until the staged account has been dormant past the devnet threshold (120 s);
6. **sweeps** the account: ~499 ETH to a fresh address in one transaction, signed with the
   staged account's own key. Nothing is broken and nothing here pretends otherwise;
7. runs the **second CRE simulation**: the canary alerts, names the sweep transaction, and
   posts it to the service.

Real output from steps 4 and 7 of a run on 2026-11-06 (`cre workflow simulate`, CRE CLI
v1.20.0, SDK 1.23.0, devnet chain 1337). First the baseline run:

```
2026-11-06T13:56:09Z [SIMULATION] Running trigger trigger=cron-trigger@1.0.0
2026-11-06T13:56:09Z [USER LOG] chain=local EIP-8141 devnet (ethrex, chain id 1337) (id 1337) head=1568 at=1793969769 watching=2 known=0
2026-11-06T13:56:09Z [USER LOG] baseline 0x090bf5154c24a1ffd2e95c5abae7ff0c83f3ae18: baseline 998502.999999 ETH at block 1568; dormant since block 1565 per watchlist seed
2026-11-06T13:56:09Z [USER LOG] baseline 0xb7d7e7b6edb4969b6ee22b2338b2a1b4f3ff6295: baseline 498.999999 ETH at block 1568; dormant since block 1566 per watchlist seed
2026-11-06T13:56:09Z [USER LOG] stored state for 2 address(es), service answered 200

✓ Workflow Simulation Result:
"{\"chainId\":1337,\"block\":1568,\"observedAt\":1793969769,\"watched\":2,\"alerts\":[],\"decisions\":{\"baseline\":2},\"mode\":\"cre-cli-simulation\"}"
```

Then, after the sweep:

```
2026-11-06T13:58:28Z [SIMULATION] Running trigger trigger=cron-trigger@1.0.0
2026-11-06T13:58:28Z [USER LOG] chain=local EIP-8141 devnet (ethrex, chain id 1337) (id 1337) head=1591 at=1793969907 watching=2 known=2
2026-11-06T13:58:28Z [USER LOG] quiet 0x090bf5154c24a1ffd2e95c5abae7ff0c83f3ae18: unchanged at 998502.999999 ETH
2026-11-06T13:58:28Z [USER LOG] alert 0xb7d7e7b6edb4969b6ee22b2338b2a1b4f3ff6295: alarm: moved 498.989999 ETH (100.00% of balance) after 0.002 days dormant
2026-11-06T13:58:28Z [USER LOG] posted 1 alert(s), service answered 200
2026-11-06T13:58:28Z [USER LOG] ALERT alarm 0xb7d7e7b6edb4969b6ee22b2338b2a1b4f3ff6295 moved 498.989999 ETH of 498.999999 ETH after 0.002d dormant, tx 0x293093ed602f072fae3f7f35143171c4cb455595330236436e1044c5113f1614
2026-11-06T13:58:28Z [USER LOG] stored state for 2 address(es), service answered 200

✓ Workflow Simulation Result:
"{\"chainId\":1337,\"block\":1591,\"observedAt\":1793969907,\"watched\":2,\"alerts\":[{\"id\":\"1337:0xb7d7e7b6edb4969b6ee22b2338b2a1b4f3ff6295:1568-1591\",\"severity\":\"alarm\",\"address\":\"0xb7d7e7b6edb4969b6ee22b2338b2a1b4f3ff6295\",\"movedEth\":\"498.989999\",\"dormancyDays\":0.002,\"txHash\":\"0x293093ed602f072fae3f7f35143171c4cb455595330236436e1044c5113f1614\"}],\"decisions\":{\"quiet\":1,\"alert\":1},\"mode\":\"cre-cli-simulation\"}"
```

Two things in that output are worth pointing at during a demo: `0.002 days dormant` is
real (a devnet minutes old cannot be dormant for a year, so the devnet threshold is 120
seconds while mainnet's is two years), and the second watched address stayed `quiet`,
which is the thresholds doing their job rather than the workflow being lucky.

## The alert format

`postcurve.canary.alert/v1`. The authoritative definition is the zod schema in
[`workflow/types.ts`](workflow/types.ts); `alertSchema.parse()` is run over every alert in
the tests, so this document and the code cannot drift apart. Wei values are decimal
strings (they do not fit a double), times are unix seconds of **chain time**, and every
field is a JSON primitive so a microcontroller can read it with a small parser.

This is the real alert from the demo run above, copied out of
`.state/demo/alerts-1337.json`. Two cosmetic changes for reading: the keys are shown in
the order this section describes them (the service stores them sorted, so every CRE node
sees identical bytes) and the long `proves` sentence is cut short.

```json
{
  "schema": "postcurve.canary.alert/v1",
  "id": "1337:0xb7d7e7b6edb4969b6ee22b2338b2a1b4f3ff6295:1568-1591",
  "severity": "alarm",
  "raisedAt": 1793969907,
  "chain": {
    "id": 1337,
    "label": "local EIP-8141 devnet (ethrex, chain id 1337)",
    "creChainName": "private-testnet-rhyolite"
  },
  "address": "0xb7d7e7b6edb4969b6ee22b2338b2a1b4f3ff6295",
  "label": "staged devnet account: funded, signed once, then left alone",
  "exposure": {
    "kind": "transaction-sender",
    "evidenceTx": "0xa4cbb3e0126086b2be1b814f4cbf3c5b077cc9637821fe16ff1b587b8d0622df",
    "evidenceBlock": 1566,
    "evidenceAt": 1793969757,
    "evidenceNonce": 0,
    "source": "chain 1337 JSON-RPC: sender of a 1 ETH transaction at nonce 0, and the account nonce is still 1, so it has sent nothing since"
  },
  "dormancy": {
    "seconds": 150,
    "days": 0.002,
    "lastOutgoingBlock": 1566,
    "lastOutgoingAt": 1793969757,
    "observed": false
  },
  "movement": {
    "balanceBeforeWei": "498999999999997732000",
    "balanceAfterWei": "10000000401263200",
    "movedWei": "498989999999596468800",
    "movedEth": "498.989999",
    "movedFraction": 0.99998,
    "baselineBlock": 1568,
    "observedBlock": 1591,
    "txHash": "0x293093ed602f072fae3f7f35143171c4cb455595330236436e1044c5113f1614",
    "txHashSource": "rpc-block-scan"
  },
  "thresholds": {
    "minDormancySeconds": 120,
    "minMovedFraction": 0.5,
    "minMovedWei": "10000000000000000000",
    "minBalanceWei": "100000000000000000000"
  },
  "cluster": {
    "alertsThisRun": 1,
    "addressesChecked": 2
  },
  "run": {
    "workflow": "postcurve-canary-devnet",
    "mode": "cre-cli-simulation",
    "watchlistSource": "built from chain 1337 JSON-RPC alone: senders of transfers over 1 ETH in blocks 1564..1566 (step 1), kept if they hold over 100 ETH today and their account nonce is above 0 (so their public key is on-chain). Dormancy is proven by an unmoved nonce where the account's last transaction fell inside the sample and entries without that proof were dropped"
  },
  "claim": "A large, long-dormant address whose public key is already on-chain moved a large share of its balance.",
  "proves": "Nothing on its own. Owners wake up, custodians rebalance, and seeds get restor ..."
}
```

Field notes for whoever writes the hardware:

| field | why it matters on the device |
|---|---|
| `id` | stable and deterministic: use it to avoid blinking twice for one event |
| `severity` | `watch` or `alarm`. `alarm` means almost the whole balance moved, or more than one address alerted in the same run |
| `raisedAt` | chain time, unix seconds. Not the time the device received it |
| `address`, `label` | what to show on the display |
| `movement.movedEth` | pre-formatted decimal string, safe to print without bignum maths |
| `movement.movedFraction` | 0..1, a double, safe for a gauge |
| `dormancy.days` | a double, for "quiet for N days" |
| `movement.txHash` | may be `null`: `txHashSource` says `unavailable` when no locator was configured or none was found. Do not print "unknown transaction" as if it were suspicious |
| `run.mode` | `cre-cli-simulation` or `cre-don`. A light driven by a simulation must say so |
| `proves` | long. Scroll it or drop it on a small screen, but do not drop it from the dashboard |

How the device gets alerts: poll `GET /alerts/latest?chainId=1` for the newest one, or
`GET /alerts?chainId=1` for all of them. The service answers with the same JSON it was
given. In postcurve's larger design the same alerts also go to Arkiv, and a hosted
deployment would put an authenticated webhook (ntfy, Slack, a pager) behind `/alerts`.

The other two documents are defined in the same file: `postcurve.canary.watchlist/v1`
(what to watch and the evidence of exposure) and `postcurve.canary.state/v1` (the
baseline the canary compares against). The watchlist is kept deliberately plain JSON
because a later part of postcurve publishes it to Arkiv as entities.

## Where the watchlist comes from

`watchlist/build-watchlist.ts` builds a watchlist from **chain data only**: no indexer,
no API key, no scraped labels, nothing with a licence attached. Its source for mainnet is
Ethereum mainnet itself, read over a public JSON-RPC endpoint
(`https://ethereum.publicnode.com` by default). Chain data is facts, not a licensed
dataset, and the exact command that produced a file is recorded inside it (`builtBy`),
so anyone can reproduce it.

The method, and why it needs no archive node:

1. **Sample blocks** and note, for every transfer over `--min-tx-value-eth`, who sent it
   and (with `--candidates both`) who received it.
2. **Read latest state** for each candidate: balance and account nonce.
   - `--min-balance-eth` keeps it to addresses worth the trouble.
   - `nonce > 0` **proves the public key is on-chain**: the account has signed at least
     once, and a signature is all it takes to publish the key. `nonce == 0` is dropped,
     because that address is still hiding behind its hash.
3. **Prove dormancy by the nonce, where it can be proven.** A sampled transaction carried
   a nonce. If the account's nonce today is exactly one higher, the account has sent
   nothing since: the dormancy is *proven* from latest state alone, and the sampled
   block's timestamp is its exact start. That becomes the entry's dormancy seed.

That is the whole trick that avoids needing an archive node or an indexer: the nonce is
in latest state, and the transaction that set it was in a block we read. The cost is that
dormancy can only be proven for accounts whose **last** transaction fell inside the
sampled range, which is rare in a sparse sample of a busy chain.

So there is a second, weaker class of entry, off by default and switched on with
`--allow-unproven-dormancy`: large, provably exposed addresses whose last transaction was
not sampled. Those entries carry **no dormancy seed**, and the canary times their
dormancy from its own first sighting (the alert then says `dormancy.observed: false` and
`exposure.source` spells out what was and was not proven). `--max-current-nonce` keeps
obviously busy accounts out, and an address with code is dropped, because a contract's
nonce (or an EIP-7702-delegated account's) says nothing about who signed what. Nothing is
ever guessed: an address that fails a check is dropped, and an unproven claim is left out
of the file rather than softened.

The practical consequence for mainnet is worth stating plainly: an entry with a proven
seed can alert on its first sweep, while an entry without one cannot alert until it has
been watched for a full dormancy window. The shipped mainnet list is a seed for a watcher
that is meant to run for months, not a list that will light up today. The staged devnet
demo is where an alert is actually demonstrated end to end.

The shipped `watchlist/watchlist.mainnet.json` was built with this command, and every
entry in it was verified against mainnet state at build time (`builtBy` in the file
repeats the command):

```sh
bun run watchlist/build-watchlist.ts \
  --rpc https://ethereum.publicnode.com \
  --chain-id 1 --chain-label "ethereum mainnet" \
  --from-block 26300000 --to-block 26350000 --step 100 \
  --min-tx-value-eth 50 --candidates both \
  --allow-unproven-dormancy --max-current-nonce 200 \
  --min-balance-eth 100 --max-entries 20 --concurrency 8 \
  --out watchlist/watchlist.mainnet.json
```

That run sampled 501 blocks, found 311 candidate addresses, and kept 12: it dropped 223
for holding too little, 7 whose nonce is still 0 (their key is not exposed, so they are
not this watcher's business), 64 as too active or with dormancy it could not establish,
and 5 contracts or delegated accounts. The 12 range from about 158 ETH to about 93,695
ETH, and 2 of them have a proven dormancy seed.

Two findings from running it, worth knowing before you re-run it:

- **Public endpoints prune history.** `https://ethereum.publicnode.com` answered some
  requests for blocks before ~15,500,000 with "pruned history unavailable" and refuses
  historical *state* without a paid token. The builder retries (the endpoint is
  load-balanced, so another backend may hold the block), then skips the block and tells
  you the earliest block it was offered. Nothing silently vanishes.
- **A sparse sample of old blocks finds almost nothing.** 1001 blocks sampled across
  2016-2017 produced 1213 large senders and **zero** that still hold 100 ETH: whoever
  sent 100 ETH in 2016 usually emptied the account. The yield comes from sampling densely
  (`--step 100`) and from `--candidates both`, which is why the shipped list uses both.

Re-run it to refresh or widen the list. The devnet equivalent, which the staged demo runs
for you (senders only, because there the account's own revealing transaction is in the
sample, so dormancy is proven):

```sh
bun run watchlist/build-watchlist.ts \
  --rpc http://127.0.0.1:18545 \
  --chain-id 1337 --chain-label "local EIP-8141 devnet (ethrex, chain id 1337)" \
  --from-block 0 --step 1 --min-tx-value-eth 1 --min-balance-eth 100 \
  --labels .state/demo-labels.json \
  --out watchlist/watchlist.devnet.json
```

## Tests

```sh
cd canary
bun test workflow        # 36 tests
bunx tsc --noEmit -p workflow/tsconfig.json   # the workflow typechecks
bunx tsc --noEmit        # the service, builder and demo scripts typecheck
```

What they pin down, because these are the cases where a wrong answer is expensive:

- **Thresholds**: dormancy, share of balance moved, absolute amount moved, and minimum
  balance, each blocking an alert on its own, plus the exactly-on-the-threshold case.
- **Dormancy**: it restarts when value leaves, and it does *not* restart when value
  arrives (being paid needs no signature from the holder).
- **First run**: a baseline is recorded and nothing is raised, with and without a
  watchlist seed, and an empty stored state counts as no state.
- **RPC failure**: a failed balance read never raises an alert, never overwrites the old
  state with a zero balance, and does not stop other addresses in the same run from
  alerting. A missing observation is treated as a failed read, not as a zero balance.
- **Alert identity**: ids are deterministic for the same observation and change when the
  blocks change, so the sink can dedupe.
- **Clusters**: two addresses alerting in one run are raised to `alarm`.
- **Schema conformance**: everything the logic emits is parsed against the published
  alert and state schemas, including after a JSON round trip.
- **Configs**: the shipped devnet and mainnet configs are parsed by the real config
  schema, so a typo in a threshold fails a test instead of a demo.
- **Duplicates**: an address listed twice in a watchlist is checked once and alerts
  once.

Behaviour verified by hand against the running devnet, not by a test: with the canary
service stopped, a simulated run fails loudly
(`dial tcp 127.0.0.1:8787: connect: connection refused`) and raises nothing, which is the
right failure for a watcher.

## Configuration

`workflow/config.devnet.json` and `workflow/config.mainnet.json`, both parsed by
`configSchema` in `workflow/workflow.ts`:

| field | meaning |
|---|---|
| `schedule` | CRE cron expression, six fields (seconds first) |
| `chain.creChainName` | CRE chain-selector name; `project.yaml` maps it to an RPC URL |
| `chain.id`, `chain.label` | the real chain id and a human label, for the alert |
| `service.baseUrl` | where the canary service listens |
| `service.locateMove` | ask the service to find the moving transaction. `false` on mainnet by default: a public RPC should not be asked to scan blocks, and `txHash` then stays `null` |
| `thresholds.minDormancySeconds` | 120 on the devnet (a devnet is minutes old), 63072000 (two years) on mainnet |
| `thresholds.minMovedFraction` | share of the balance that must leave, 0..1 |
| `thresholds.minMovedWei`, `minBalanceWei` | absolute floors, in wei |
| `maxAddresses` | hard cap on balance reads per run |
| `run.mode` | `cre-cli-simulation` or `cre-don`, copied into every alert. Set by hand, never inferred |

Watching a different chain is a config change plus an `rpcs` entry in `project.yaml`.

## What is not done here

- **No hardware.** The ESP32 canary light is a separate sub-project; this part only
  publishes the format it reads.
- **No deployment to the CRE network.** Simulation only, which is what the track asks
  for. Deploying would need `cre login` and deploy access, and the workflow would then
  need the canary service on a public URL with authentication (CRE secrets), which is
  noted below as the main gap.
- **No Arkiv yet.** The watchlist and alerts are plain JSON on purpose, ready for the
  Arkiv part to publish them.
- **No authentication on the canary service.** It binds to 127.0.0.1 and takes no
  credentials. A deployed workflow would need a hosted endpoint, a token in CRE secrets,
  and the service rejecting anything unsigned.
- **No ERC-20 or NFT coverage**, and no exposure detection beyond "it sent a
  transaction". Both are listed in the design as work for the exposure scanner.
