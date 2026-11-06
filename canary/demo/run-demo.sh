#!/usr/bin/env bash
# The staged canary demo on the local EIP-8141 devnet.
#
#   1. stage a large, exposed, dormant account (real transactions on the devnet)
#   2. build the devnet watchlist from chain data
#   3. start the canary service (watchlist, state, alert sink, move locator)
#   4. CRE CLI simulation #1: the canary records a baseline and stays quiet
#   5. wait until the account has been dormant past the threshold
#   6. sweep it
#   7. CRE CLI simulation #2: the canary raises an alert naming the sweep transaction
#
# Everything here runs against the local devnet and the local service. The two CRE
# runs are simulations (`cre workflow simulate`), which is what the Chainlink track
# asks for; nothing is deployed.
#
# usage: demo/run-demo.sh [--rpc URL] [--port N] [--keep-service]

set -euo pipefail

RPC_URL="${CANARY_RPC_URL:-http://127.0.0.1:18545}"
PORT=8787
KEEP_SERVICE=0

while [[ $# -gt 0 ]]; do
	case "$1" in
		--rpc) RPC_URL="$2"; shift 2 ;;
		--port) PORT="$2"; shift 2 ;;
		--keep-service) KEEP_SERVICE=1; shift ;;
		-h|--help) sed -n '2,20p' "$0"; exit 0 ;;
		*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
done

cd "$(dirname "$0")/.."
ROOT="$PWD"
STATE_DIR="$ROOT/.state/demo"
SERVICE_LOG="$ROOT/.state/canary-service.log"
SERVICE_PID=""

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

cleanup() {
	if [[ -n "$SERVICE_PID" && "$KEEP_SERVICE" -eq 0 ]]; then
		kill "$SERVICE_PID" 2>/dev/null || true
		wait "$SERVICE_PID" 2>/dev/null || true
	fi
}
trap cleanup EXIT

command -v bun >/dev/null || { echo "bun is required" >&2; exit 1; }
command -v cre >/dev/null || { echo "the CRE CLI is required: https://docs.chain.link/cre" >&2; exit 1; }

step "Checking the devnet at $RPC_URL"
CHAIN_ID_HEX=$(curl -sf -m 10 -X POST "$RPC_URL" -H 'content-type: application/json' \
	--data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' | sed -n 's/.*"result":"\([^"]*\)".*/\1/p')
if [[ -z "$CHAIN_ID_HEX" ]]; then
	echo "no JSON-RPC at $RPC_URL. Start the devnet first: (cd ../devnet && ./devnet.sh up)" >&2
	exit 1
fi
printf 'chain id %d\n' "$CHAIN_ID_HEX"

[[ -d node_modules ]] || bun install

step "1. Staging a large, exposed, dormant account"
bun run demo/stage-dormant.ts --rpc "$RPC_URL"

REVEAL_BLOCK=$(bun --print 'JSON.parse(await Bun.file(".state/demo-account.json").text()).revealBlock')
FROM_BLOCK=$(( REVEAL_BLOCK > 2 ? REVEAL_BLOCK - 2 : 0 ))

step "2. Building the devnet watchlist from chain data (blocks $FROM_BLOCK..head)"
bun run watchlist/build-watchlist.ts \
	--rpc "$RPC_URL" \
	--chain-id 1337 \
	--chain-label "local EIP-8141 devnet (ethrex, chain id 1337)" \
	--from-block "$FROM_BLOCK" --step 1 \
	--min-tx-value-eth 1 --min-balance-eth 100 \
	--labels .state/demo-labels.json \
	--out watchlist/watchlist.devnet.json

step "3. Starting the canary service on port $PORT"
mkdir -p "$STATE_DIR"
rm -f "$STATE_DIR/state-1337.json" "$STATE_DIR/alerts-1337.json"
bun run tools/canary-service.ts \
	--port "$PORT" --rpc "$RPC_URL" \
	--watchlist watchlist/watchlist.devnet.json \
	--data .state/demo >"$SERVICE_LOG" 2>&1 &
SERVICE_PID=$!
for _ in $(seq 1 40); do
	if curl -sf -m 2 "http://127.0.0.1:$PORT/health" >/dev/null; then break; fi
	sleep 0.25
done
curl -sf "http://127.0.0.1:$PORT/health"

step "4. CRE CLI simulation #1: first sighting, so the canary only records a baseline"
cre workflow simulate ./workflow --target devnet-settings --non-interactive --trigger-index 0

step "5. Waiting for the staged account to pass the dormancy threshold (120s on the devnet)"
bun run demo/wait-dormancy.ts --rpc "$RPC_URL" --seconds 120

step "6. Sweeping the staged account"
bun run demo/sweep.ts --rpc "$RPC_URL"

step "7. CRE CLI simulation #2: the sweep after dormancy, so the canary alerts"
cre workflow simulate ./workflow --target devnet-settings --non-interactive --trigger-index 0

step "The alert the service stored (this is what the canary light reads)"
curl -sf "http://127.0.0.1:$PORT/alerts/latest?chainId=1337"

step "Done"
echo "alerts:        $STATE_DIR/alerts-1337.json"
echo "canary state:  $STATE_DIR/state-1337.json"
echo "service log:   $SERVICE_LOG"
echo "watchlist:     $ROOT/watchlist/watchlist.devnet.json"
if [[ "$KEEP_SERVICE" -eq 1 ]]; then
	echo "canary service left running on port $PORT (pid $SERVICE_PID)"
	trap - EXIT
fi
