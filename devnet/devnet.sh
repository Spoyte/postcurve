#!/usr/bin/env bash
#
# Local EIP-8141 devnet: ethrex + Lighthouse + the alt-mempool sidecar.
# Adapted from forshtat/mempool-workshop-sidecar deploy/devnet (MIT). See README.md.
#
#   ./devnet.sh up [--no-wait]   generate data/ if missing, start everything, deploy the
#                                staking registry, wait for Hegota (about 7.5 min after a reset)
#   ./devnet.sh down             stop and remove the containers, keep the chain in data/
#   ./devnet.sh reset [--no-up]  down, delete data/ (new keys, new genesis), then up
#   ./devnet.sh status           containers, head block, forks, peers, sidecar, registry
#   ./devnet.sh wait-hegota      block until frame transactions are valid
#   ./devnet.sh predeploy        deploy NaiveStakingRegistry (idempotent; `up` runs it)
#   ./devnet.sh accounts         funded account names, addresses and balances (no keys)
#   ./devnet.sh key NAME         print one account's private key to stdout, for $(...)
#   ./devnet.sh smoke            frame-tx smoke tests (tools/smoke.ts, needs bun)
#   ./devnet.sh logs [SERVICE]   follow container logs
#   ./devnet.sh compose ARGS...  docker compose with this project's files and env

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="$DIR/data"
COMPOSE_ENV="$DATA/compose.env"
META="$DATA/devnet.json"
ACCOUNTS="$DATA/keys/accounts.json"

# Ports and subnet are fixed at the first `up` (written to data/compose.env, which compose
# reads too); later environment overrides would only desync the script from the containers.
if [ -f "$COMPOSE_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$COMPOSE_ENV"
  set +a
fi
RPC_PORT="${DEVNET_RPC_PORT:-18545}"
BEACON_PORT="${DEVNET_BEACON_PORT:-15052}"
SIDECAR_PORT="${DEVNET_SIDECAR_PORT:-14337}"
SUBNET_PREFIX="${DEVNET_SUBNET_PREFIX:-172.31.81}"
RPC="http://127.0.0.1:$RPC_PORT"
BEACON="http://127.0.0.1:$BEACON_PORT"
SIDECAR="http://127.0.0.1:$SIDECAR_PORT/rpc"

CHAIN_ID=1337
MIN_GAS_PRICE=2000000          # 0.002 gwei floor for legacy txs
LONG_RUNNING=(ethrex lighthouse-beacon lighthouse-beacon-2 lighthouse-validator sidecar)
IMAGES=(
  ethpandaops/ethereum-genesis-generator:6.1.6
  protolambda/eth2-val-tools:latest
  ghcr.io/forshtat/ethrex:eip8141-tracer-latest
  ethpandaops/lighthouse:focil
  ghcr.io/forshtat/mempool-workshop-sidecar:latest
)
# name:balance. All keys are generated fresh by `init`; none is ever committed.
ACCOUNT_SPEC=(dev:1000000 deployer:100 faucet:10000 relayer:100 user1:1000 user2:1000 user3:1000)

log() { printf '[devnet] %s\n' "$*" >&2; }
die() { printf '[devnet] error: %s\n' "$*" >&2; exit 1; }

# Container logs from the one-shot setup containers may contain the validator mnemonic.
redact() { sed -E 's/([a-z]+ ){11,}[a-z]+/<redacted-mnemonic>/g; s/0x[0-9a-fA-F]{64}/<redacted-32-bytes>/g'; }

compose() {
  local args=(--project-directory "$DIR" -f "$DIR/docker-compose.yml")
  [ -f "$COMPOSE_ENV" ] && args+=(--env-file "$COMPOSE_ENV")
  docker compose "${args[@]}" "$@"
}

rpc() { # rpc URL METHOD [PARAMS_JSON]
  curl -s --max-time 5 -X POST "$1" -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":${3:-[]}}"
}
rpc_result() { rpc "$@" | jq -r '.result // empty' 2>/dev/null || true; }

meta() { jq -r "$1" "$META"; }
account_address() { jq -r --arg n "$1" '.[] | select(.name == $n) | .address' "$ACCOUNTS"; }
account_key() { jq -r --arg n "$1" '.[] | select(.name == $n) | .privateKey' "$ACCOUNTS"; }

need() {
  local missing=()
  for c in docker cast jq curl openssl ss; do command -v "$c" >/dev/null || missing+=("$c"); done
  [ ${#missing[@]} -eq 0 ] || die "missing tools: ${missing[*]}"
  docker compose version >/dev/null 2>&1 || die "docker compose v2 is required"
}

initialized() { [ -f "$META" ] && [ -f "$DATA/genesis/metadata/genesis.ssz" ] && [ -d "$DATA/validator-keys/keystores/keys" ]; }

ours_running() { [ -n "$(compose ps -q 2>/dev/null)" ]; }

check_ports() {
  ours_running && return 0
  local p busy=()
  for p in "$RPC_PORT" "$BEACON_PORT" "$SIDECAR_PORT"; do
    [ -n "$(ss -ltnH "sport = :$p" 2>/dev/null)" ] && busy+=("$p")
  done
  [ ${#busy[@]} -eq 0 ] || die "host port(s) already in use: ${busy[*]} (override with DEVNET_RPC_PORT / DEVNET_BEACON_PORT / DEVNET_SIDECAR_PORT)"
}

check_subnet() {
  local own="postcurve-devnet_devnet" n
  for n in $(docker network ls -q); do
    local name subnets
    name=$(docker network inspect "$n" --format '{{.Name}}')
    [ "$name" = "$own" ] && continue
    subnets=$(docker network inspect "$n" --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}')
    case " $subnets " in *" $SUBNET_PREFIX.0/24 "*) die "subnet $SUBNET_PREFIX.0/24 is used by docker network '$name' (set DEVNET_SUBNET_PREFIX)";; esac
  done
  if ip -4 route 2>/dev/null | grep -v "br-" | grep -q "^$SUBNET_PREFIX\."; then
    die "subnet $SUBNET_PREFIX.0/24 is already routed on this host (set DEVNET_SUBNET_PREFIX)"
  fi
}

pull_images() {
  local img t
  for img in "${IMAGES[@]}"; do
    docker image inspect "$img" >/dev/null 2>&1 && continue
    for t in 1 2 3 4; do
      log "pulling $img (try $t)"
      docker pull -q "$img" >/dev/null 2>&1 && break
      [ "$t" = 4 ] && die "could not pull $img"
      sleep 3
    done
  done
}

# --- init: keys, genesis, validator keystores, sidecar config ---------------

gen_accounts() {
  local spec name bal w out="[]"
  for spec in "${ACCOUNT_SPEC[@]}"; do
    name=${spec%%:*}; bal=${spec##*:}
    w=$(cast wallet new --json)
    out=$(jq -c --arg n "$name" --arg b "$bal" --argjson w "$w" \
      '. + [{name: $n, balanceEth: ($b | tonumber), address: $w[0].address, privateKey: $w[0].private_key}]' <<<"$out")
  done
  printf '%s\n' "$out" | jq . > "$ACCOUNTS"
  chmod 600 "$ACCOUNTS"
}

gen_mnemonic() {
  cast wallet new-mnemonic --words 24 2>/dev/null | awk '/^Phrase:/ { getline; print; exit }' > "$DATA/keys/validator.mnemonic"
  chmod 600 "$DATA/keys/validator.mnemonic"
  [ "$(wc -w < "$DATA/keys/validator.mnemonic")" = 24 ] || die "mnemonic generation failed"
}

run_setup_container() { # SERVICE LOGFILE
  if ! compose --profile setup run --rm -T "$1" > "$2" 2>&1; then
    log "$1 failed; last lines of $2 (redacted):"
    tail -n 30 "$2" | redact >&2
    die "$1 failed"
  fi
}

init() {
  need
  [ -e "$DATA" ] && die "$DATA exists but is incomplete; run ./devnet.sh reset"
  check_subnet
  check_ports
  pull_images

  # Every image runs as root, so data/ can be private to this user.
  umask 077
  mkdir -p "$DATA"/{keys,config,logs,genesis,validator-keys,ethrex,lighthouse-beacon,lighthouse-beacon-2,lighthouse-validator,sidecar/db}

  log "generating fresh funded accounts and validator mnemonic (stored under data/keys/)"
  gen_accounts
  gen_mnemonic
  openssl rand -hex 32 > "$DATA/keys/sidecar-admin.key"

  local premine
  premine=$(jq -c 'map({key: .address, value: {balance: "\(.balanceEth)ETH"}}) | from_entries' "$ACCOUNTS")
  local ts; ts=$(date +%s)
  local delay; delay=$(sed -n 's/^export GENESIS_DELAY="\([0-9]*\)".*/\1/p' "$DIR/genesis.values.env")
  {
    cat "$DIR/genesis.values.env"
    echo
    echo "# --- generated by devnet.sh on $(date -u +%FT%TZ); secret, never commit ---"
    echo "export GENESIS_TIMESTAMP=\"$ts\""
    echo "export EL_AND_CL_MNEMONIC=\"$(cat "$DATA/keys/validator.mnemonic")\""
    echo "export EL_PREMINE_ADDRS='$premine'"
  } > "$DATA/config/values.env"

  local deployer registry
  deployer=$(account_address deployer)
  registry=$(cast compute-address --nonce 0 "$deployer" | awk '{print $NF}')

  jq -n --arg relayer "$(account_key relayer)" --arg registry "$registry" '{
    entryPoints: ["0x00000000000000000000000000000000000000aa"],
    canonicalEntryPoint: "0x00000000000000000000000000000000000000aa",
    standardMempoolId: "QmcFZKUX9qoo3StwVycJTAhwdiqbEjcwNvQVK246p3z1rk",
    supportedMempools: [{ mempoolId: "QmcFZKUX9qoo3StwVycJTAhwdiqbEjcwNvQVK246p3z1rk",
                          entryPoint: "0x00000000000000000000000000000000000000aa" }],
    relayers: [$relayer],
    rpcEndpoint: "http://ethrex:8545",
    rpcEndpointSubmit: "http://ethrex:8545",
    stakingRegistryAddress: $registry
  }' > "$DATA/sidecar/config.json"
  {
    echo "SKANDHA_FAUCET_KEY=$(account_key faucet)"
    echo "SKANDHA_ADMIN_KEY=$(cat "$DATA/keys/sidecar-admin.key")"
  } > "$DATA/sidecar/sidecar.env"

  {
    echo "DEVNET_RPC_PORT=$RPC_PORT"
    echo "DEVNET_BEACON_PORT=$BEACON_PORT"
    echo "DEVNET_SIDECAR_PORT=$SIDECAR_PORT"
    echo "DEVNET_SUBNET_PREFIX=$SUBNET_PREFIX"
    echo "DEVNET_FEE_RECIPIENT=$(account_address dev)"
  } > "$COMPOSE_ENV"

  log "generating genesis (log: data/logs/genesis.log)"
  run_setup_container genesis "$DATA/logs/genesis.log"
  log "generating validator keystores (log: data/logs/validator-keys.log)"
  run_setup_container validator-keys "$DATA/logs/validator-keys.log"

  # The EL genesis block carries GENESIS_TIMESTAMP; slot 0 (CL genesis) is GENESIS_DELAY later.
  # Fork times come from genesis.json (ethrex calls Hegota "bogota").
  local genesis_time=$((ts + delay)) amsterdam hegota
  amsterdam=$(jq -r '.config.amsterdamTime' "$DATA/genesis/metadata/genesis.json")
  hegota=$(jq -r '.config.bogotaTime' "$DATA/genesis/metadata/genesis.json")
  [[ "$hegota" =~ ^[0-9]+$ ]] || die "genesis.json has no bogotaTime (Hegota); check genesis.values.env"
  jq -n --argjson chainId "$CHAIN_ID" --argjson g "$genesis_time" --argjson a "$amsterdam" --argjson h "$hegota" \
    --arg registry "$registry" --arg rpc "$RPC" --arg sidecar "$SIDECAR" --arg beacon "$BEACON" '{
      chainId: $chainId, genesisTime: $g, amsterdamTime: $a, hegotaTime: $h,
      stakingRegistry: $registry,
      entryPoint: "0x00000000000000000000000000000000000000aa",
      rpcUrl: $rpc, sidecarUrl: $sidecar, beaconUrl: $beacon,
      accountsFile: "data/keys/accounts.json"
    }' > "$META"
  log "genesis at $(date -d @"$genesis_time" +%T), Hegota (frame txs) at $(date -d @"$hegota" +%T)"
}

# --- chain helpers -----------------------------------------------------------

head_number() { local h; h=$(rpc_result "$RPC" eth_blockNumber); [ -n "$h" ] && echo $((h)) || echo -1; }
head_timestamp() {
  local t; t=$(rpc "$RPC" eth_getBlockByNumber '["latest",false]' | jq -r '.result.timestamp // empty' 2>/dev/null || true)
  [ -n "$t" ] && echo $((t)) || echo 0
}

wait_for_blocks() {
  local now g; now=$(date +%s); g=$(meta .genesisTime)
  [ "$now" -lt "$g" ] && log "waiting $((g - now)) s for genesis..."
  local deadline=$(( (now > g ? now : g) + 180 ))
  until [ "$(head_number)" -ge 1 ]; do
    [ "$(date +%s)" -gt "$deadline" ] && die "no blocks 3 minutes after genesis; see ./devnet.sh logs ethrex lighthouse-beacon"
    sleep 3
  done
  log "chain is producing blocks (head $(head_number))"
}

wait_hegota() {
  # Two slots past activation: a raw frame tx sent to ethrex in the very first Hegota block was
  # once dropped silently from its mempool (the identical tx mined fine when resent later).
  local h; h=$(( $(meta .hegotaTime) + 12 ))
  local last=-1
  while [ "$(head_timestamp)" -lt "$h" ]; do
    local left=$((h - $(date +%s)))
    if [ "$left" -lt -120 ]; then
      die "Hegota time passed $((-left)) s ago but the head block is older; the chain is stuck (./devnet.sh status, ./devnet.sh logs)"
    fi
    if [ $((left / 60)) -ne "$last" ] && [ "$left" -gt 0 ]; then
      last=$((left / 60)); log "Hegota in ~${left} s (head block $(head_number))"
    fi
    sleep 6
  done
  log "Hegota is active at block $(head_number): frame transactions are valid"
}

wait_receipt() { # HASH -> prints receipt JSON
  local r
  for _ in $(seq 1 60); do
    r=$(rpc "$RPC" eth_getTransactionReceipt "[\"$1\"]" | jq -c '.result // empty' 2>/dev/null || true)
    [ -n "$r" ] && { echo "$r"; return 0; }
    sleep 2
  done
  return 1
}

predeploy() {
  [ -f "$META" ] || die "not initialized; run ./devnet.sh up"
  local registry deployer code nonce
  registry=$(meta .stakingRegistry)
  deployer=$(account_address deployer)
  code=$(rpc_result "$RPC" eth_getCode "[\"$registry\",\"latest\"]")
  if [ -n "$code" ] && [ "$code" != "0x" ]; then
    log "staking registry already deployed at $registry"
    return 0
  fi
  nonce=$(cast nonce "$deployer" --rpc-url "$RPC")
  [ "$nonce" = 0 ] || die "deployer nonce is $nonce, not 0: the registry would not land at $registry (reset the devnet)"
  log "deploying NaiveStakingRegistry from deployer $deployer"
  # A fresh chain starts with a ~1 gwei base fee that decays block by block toward 7 wei,
  # so price off the node's suggestion rather than a constant.
  local hash receipt price
  price=$(( $(cast gas-price --rpc-url "$RPC") * 2 ))
  [ "$price" -ge "$MIN_GAS_PRICE" ] || price=$MIN_GAS_PRICE
  hash=$(cast send --async --rpc-url "$RPC" --private-key "$(account_key deployer)" \
    --legacy --gas-price "$price" --gas-limit 6000000 \
    --create "$(tr -d '[:space:]' < "$DIR/contracts/NaiveStakingRegistry.initcode")")
  receipt=$(wait_receipt "$hash") || die "registry deployment $hash not mined"
  [ "$(jq -r .status <<<"$receipt")" = "0x1" ] || die "registry deployment $hash reverted"
  [ "$(jq -r .contractAddress <<<"$receipt" | tr 'A-F' 'a-f')" = "$(tr 'A-F' 'a-f' <<<"$registry")" ] \
    || die "registry landed at an unexpected address"
  log "staking registry deployed at $registry (tx $hash, block $(( $(jq -r .blockNumber <<<"$receipt") )))"
}

# --- commands ----------------------------------------------------------------

cmd_up() {
  local wait=1
  [ "${1:-}" = "--no-wait" ] && wait=0
  need
  if ! initialized; then init; else check_subnet; check_ports; pull_images; fi
  log "starting ${LONG_RUNNING[*]}"
  compose up -d "${LONG_RUNNING[@]}" 2>&1 | grep -v -E '^\s*$' >&2 || true
  local g h; g=$(meta .genesisTime); h=$(meta .hegotaTime)
  log "ethrex RPC  $RPC   (chain id $CHAIN_ID)"
  log "sidecar RPC $SIDECAR"
  log "genesis $(date -d @"$g" +%T), Amsterdam $(date -d @"$(meta .amsterdamTime)" +%T), Hegota $(date -d @"$h" +%T)"
  [ "$wait" = 1 ] || return 0
  wait_for_blocks
  predeploy
  wait_hegota
  cmd_status
}

cmd_down() { compose down --remove-orphans; }

cmd_reset() {
  need
  compose down --remove-orphans 2>/dev/null || true
  if [ -e "$DATA" ]; then
    log "deleting $DATA (chain, keys, config)"
    # Containers write root-owned files; delete them from a container instead of sudo.
    docker run --rm -v "$DATA:/wipe" alpine:3.24 sh -c 'rm -rf /wipe/* /wipe/.[!.]* /wipe/..?*' \
      || die "could not delete $DATA"
    rmdir "$DATA"
  fi
  [ "${1:-}" = "--no-up" ] || cmd_up
}

cmd_status() {
  [ -f "$META" ] || { echo "not initialized (run ./devnet.sh up)"; return 1; }
  echo "== containers"
  compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}' 2>/dev/null || true
  echo "== execution (ethrex)  $RPC"
  local cid n ts h now
  cid=$(rpc_result "$RPC" eth_chainId)
  if [ -z "$cid" ]; then echo "  RPC not answering"; else
    n=$(head_number); ts=$(head_timestamp); h=$(meta .hegotaTime); now=$(date +%s)
    echo "  chain id     $((cid))"
    echo "  head block   $n  ($(( now - ts )) s old)"
    if [ "$ts" -ge "$h" ]; then echo "  fork         Hegota active (frame txs valid)"
    elif [ "$ts" -ge "$(meta .amsterdamTime)" ]; then echo "  fork         Amsterdam; Hegota in $((h - now)) s"
    else echo "  fork         Osaka; Hegota in $((h - now)) s"; fi
    echo "  client       $(rpc_result "$RPC" web3_clientVersion)"
  fi
  echo "== consensus (lighthouse-beacon)  $BEACON"
  local sync peers
  sync=$(curl -s --max-time 3 "$BEACON/eth/v1/node/syncing" | jq -c '.data | {head_slot, sync_distance, is_syncing, el_offline}' 2>/dev/null || true)
  peers=$(curl -s --max-time 3 "$BEACON/eth/v1/node/peer_count" | jq -r '.data.connected' 2>/dev/null || true)
  echo "  sync         ${sync:-not answering}"
  echo "  peers        ${peers:-?} (needs >= 1, lighthouse-beacon-2)"
  echo "== sidecar  $SIDECAR"
  local scid reg code
  scid=$(rpc_result "$SIDECAR" eth_chainId)
  if [ -z "$scid" ]; then echo "  not answering"; else
    reg=$(rpc "$SIDECAR" skandha_config | jq -r '.result.stakingRegistryAddress // empty' 2>/dev/null || true)
    echo "  chain id     $((scid))"
    echo "  registry     ${reg:-unknown} (configured)"
  fi
  reg=$(meta .stakingRegistry)
  code=$(rpc_result "$RPC" eth_getCode "[\"$reg\",\"latest\"]")
  if [ -n "$code" ] && [ "$code" != "0x" ]; then echo "  registry     deployed at $reg"; else echo "  registry     NOT deployed yet at $reg (./devnet.sh predeploy)"; fi
  echo "== keys  $ACCOUNTS (gitignored; ./devnet.sh accounts lists addresses)"
}

cmd_accounts() {
  [ -f "$ACCOUNTS" ] || die "not initialized"
  echo "keys: $ACCOUNTS"
  local name addr bal
  while read -r name addr; do
    bal=$(cast balance "$addr" --rpc-url "$RPC" --ether 2>/dev/null || echo "?")
    printf '  %-9s %s  %s ETH\n' "$name" "$addr" "$bal"
  done < <(jq -r '.[] | "\(.name) \(.address)"' "$ACCOUNTS")
}

cmd_key() {
  [ -n "${1:-}" ] || die "usage: ./devnet.sh key NAME"
  [ -f "$ACCOUNTS" ] || die "not initialized"
  local k; k=$(account_key "$1")
  [ -n "$k" ] || die "no account named $1"
  printf '%s\n' "$k"
}

cmd_smoke() {
  command -v bun >/dev/null || die "bun is required for the smoke tests"
  [ -d "$DIR/tools/node_modules" ] || (cd "$DIR/tools" && bun install --frozen-lockfile 2>/dev/null || bun install)
  (cd "$DIR/tools" && bun run smoke.ts "$@")
}

case "${1:-}" in
  up) shift; cmd_up "$@" ;;
  down) cmd_down ;;
  reset) shift; cmd_reset "$@" ;;
  status) cmd_status ;;
  wait-hegota) wait_hegota ;;
  predeploy) predeploy ;;
  accounts) cmd_accounts ;;
  key) shift; cmd_key "$@" ;;
  smoke) shift; cmd_smoke "$@" ;;
  logs) shift; compose logs -f --tail 100 "$@" ;;
  compose) shift; compose "$@" ;;
  *) sed -n '3,19p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
