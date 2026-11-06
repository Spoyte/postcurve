/**
 * The canary service: the external system the CRE workflow talks to.
 *
 * It is deliberately small and file-backed. It holds the three things the workflow
 * cannot hold itself (a workflow has no storage between runs):
 *
 *   GET  /watchlist?chainId=N   the addresses to watch, served from watchlist/*.json
 *   GET  /state?chainId=N       the last state the canary stored ({} if none yet)
 *   POST /state                 store a new state (replaces the one for that chain)
 *   POST /alerts                the alert webhook: {"alerts":[...]} , idempotent on id
 *   GET  /alerts?chainId=N      every alert raised, newest last (for a dashboard)
 *   GET  /alerts/latest?chainId=N   the newest alert, or {} (for the canary light)
 *   GET  /locate-move?chainId=N&address=0x..&fromBlock=A&toBlock=B
 *                               scans those blocks on the configured RPC and returns
 *                               the transaction that sent value out of `address`
 *   GET  /health                chain id and head block as seen from this process
 *
 * Why the GET bodies are boring: in a real DON every node fetches them and the results
 * go through identical-value consensus, so a timestamp or an unstable key order in a
 * response would break the run. Responses are built from stored values only, with
 * sorted keys. POSTs are idempotent: /alerts drops an alert whose id is already
 * stored, /state replaces.
 *
 * This is local reference plumbing, not a product: the Arkiv part of postcurve
 * replaces /watchlist and /alerts with Arkiv entities, and a real deployment would put
 * an authenticated webhook (ntfy, Slack, a pager) behind /alerts.
 *
 *   bun run tools/canary-service.ts --port 8787 --rpc http://127.0.0.1:18545 \
 *     --watchlist watchlist/watchlist.devnet.json --data .state
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { alertSchema, canaryStateSchema, watchlistSchema, type Alert } from '../workflow/types'

type Args = {
	port: number
	rpc: string
	watchlists: string[]
	dataDir: string
	maxScanBlocks: number
}

const parseArgs = (argv: string[]): Args => {
	const args: Args = {
		port: 8787,
		rpc: process.env.CANARY_RPC_URL ?? 'http://127.0.0.1:18545',
		watchlists: [],
		dataDir: '.state',
		maxScanBlocks: 5000,
	}
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i]
		const value = argv[i + 1]
		switch (flag) {
			case '--port':
				args.port = Number(value)
				i += 1
				break
			case '--rpc':
				args.rpc = String(value)
				i += 1
				break
			case '--watchlist':
				args.watchlists.push(String(value))
				i += 1
				break
			case '--data':
				args.dataDir = String(value)
				i += 1
				break
			case '--max-scan-blocks':
				args.maxScanBlocks = Number(value)
				i += 1
				break
			case '--help':
				console.log(
					'usage: bun run tools/canary-service.ts [--port 8787] [--rpc URL] [--watchlist FILE]... [--data DIR] [--max-scan-blocks 5000]',
				)
				process.exit(0)
			default:
				throw new Error(`unknown argument: ${flag}`)
		}
	}
	if (args.watchlists.length === 0) args.watchlists = ['watchlist/watchlist.devnet.json']
	return args
}

const args = parseArgs(process.argv.slice(2))
const root = join(import.meta.dir, '..')
const resolve = (p: string) => (isAbsolute(p) ? p : join(root, p))
const dataDir = resolve(args.dataDir)
mkdirSync(dataDir, { recursive: true })

// ---------------------------------------------------------------- storage

/** JSON with sorted keys, so every node sees the same bytes. */
const stableStringify = (value: unknown): string => {
	const walk = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(walk)
		if (v && typeof v === 'object') {
			const out: Record<string, unknown> = {}
			for (const k of Object.keys(v as Record<string, unknown>).sort()) {
				out[k] = walk((v as Record<string, unknown>)[k])
			}
			return out
		}
		return v
	}
	return JSON.stringify(walk(value))
}

const readJsonFile = (path: string): unknown | null => {
	try {
		return JSON.parse(readFileSync(path, 'utf-8'))
	} catch {
		return null
	}
}

const writeJsonFile = (path: string, value: unknown) => {
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

const statePath = (chainId: number) => join(dataDir, `state-${chainId}.json`)
const alertsPath = (chainId: number) => join(dataDir, `alerts-${chainId}.json`)

/** Watchlists, loaded once per request so an edit on disk is picked up. */
const loadWatchlists = () => {
	const byChain = new Map<number, ReturnType<typeof watchlistSchema.parse>>()
	for (const file of args.watchlists) {
		const raw = readJsonFile(resolve(file))
		if (!raw) {
			console.warn(`[canary-service] watchlist not readable: ${file}`)
			continue
		}
		const parsed = watchlistSchema.safeParse(raw)
		if (!parsed.success) {
			console.warn(`[canary-service] watchlist ${file} is invalid: ${parsed.error.message}`)
			continue
		}
		byChain.set(parsed.data.chainId, parsed.data)
	}
	return byChain
}

// ---------------------------------------------------------------- RPC

let rpcId = 0
const rpc = async <T>(method: string, params: unknown[]): Promise<T> => {
	const response = await fetch(args.rpc, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
	})
	if (!response.ok) throw new Error(`${method} failed: HTTP ${response.status}`)
	const body = (await response.json()) as { result?: T; error?: { message: string } }
	if (body.error) throw new Error(`${method} failed: ${body.error.message}`)
	return body.result as T
}

type RpcTx = {
	hash: string
	from: string
	to: string | null
	value: string
	nonce: string
}

/**
 * Find the transaction that sent value out of `address` between two blocks.
 *
 * This is a plain block scan over the configured RPC: honest, exact and only
 * practical over a short range, which is all the canary needs (baseline block to
 * head block of the run). On mainnet, with 10 minutes between runs, that is about
 * 50 blocks. If the range is longer than --max-scan-blocks it refuses rather than
 * hammering the node, and the alert then carries txHash: null.
 */
const locateMove = async (address: string, fromBlock: number, toBlock: number) => {
	const target = address.toLowerCase()
	const span = toBlock - fromBlock
	if (span < 0) return { txHash: null, reason: 'empty range' }
	if (span > args.maxScanBlocks) {
		return { txHash: null, reason: `range ${span} blocks exceeds max-scan-blocks ${args.maxScanBlocks}` }
	}
	// Walk backwards: the most recent outgoing transaction is the interesting one.
	let skipped = 0
	let lastSkipReason: string | undefined
	for (let n = toBlock; n >= fromBlock; n -= 1) {
		let block: { transactions: RpcTx[] } | null = null
		try {
			block = await rpc<{ transactions: RpcTx[] } | null>('eth_getBlockByNumber', [
				`0x${n.toString(16)}`,
				true,
			])
		} catch (error) {
			// A node that has pruned this block, or refuses it, costs one block of the
			// scan, not the whole answer. The caller sees how many were missed.
			skipped += 1
			lastSkipReason = error instanceof Error ? error.message : String(error)
			continue
		}
		if (!block) continue
		for (const tx of block.transactions) {
			if (tx.from?.toLowerCase() === target) {
				return {
					txHash: tx.hash,
					blockNumber: n,
					to: tx.to,
					valueWei: BigInt(tx.value).toString(),
					nonce: Number(BigInt(tx.nonce)),
					skippedBlocks: skipped,
					reason: 'found by block scan',
				}
			}
		}
	}
	return {
		txHash: null,
		skippedBlocks: skipped,
		reason:
			skipped > 0
				? `no outgoing transaction from ${address} in blocks ${fromBlock}..${toBlock}, and ${skipped} block(s) could not be read (${lastSkipReason})`
				: `no outgoing transaction from ${address} in blocks ${fromBlock}..${toBlock}`,
	}
}

// ---------------------------------------------------------------- HTTP

const json = (value: unknown, status = 200) =>
	new Response(`${stableStringify(value)}\n`, {
		status,
		headers: { 'content-type': 'application/json' },
	})

const chainIdOf = (url: URL, fallback?: number): number => {
	const raw = url.searchParams.get('chainId')
	if (raw === null) {
		if (fallback !== undefined) return fallback
		throw new Error('chainId query parameter is required')
	}
	const id = Number(raw)
	if (!Number.isInteger(id) || id <= 0) throw new Error(`bad chainId: ${raw}`)
	return id
}

const loadAlerts = (chainId: number): Alert[] => {
	const raw = readJsonFile(alertsPath(chainId))
	return Array.isArray(raw) ? (raw as Alert[]) : []
}

const server = Bun.serve({
	hostname: '127.0.0.1',
	port: args.port,
	async fetch(request) {
		const url = new URL(request.url)
		const path = url.pathname.replace(/\/+$/, '') || '/'
		try {
			if (request.method === 'GET' && path === '/health') {
				const [chainId, head] = await Promise.all([
					rpc<string>('eth_chainId', []),
					rpc<string>('eth_blockNumber', []),
				])
				return json({
					ok: true,
					rpc: args.rpc,
					chainId: Number(BigInt(chainId)),
					headBlock: Number(BigInt(head)),
					watchlists: [...loadWatchlists().keys()],
				})
			}

			if (request.method === 'GET' && path === '/watchlist') {
				const watchlists = loadWatchlists()
				const chainId = chainIdOf(url, watchlists.size === 1 ? [...watchlists.keys()][0] : undefined)
				const watchlist = watchlists.get(chainId)
				if (!watchlist) return json({ error: `no watchlist loaded for chain ${chainId}` }, 404)
				return json(watchlist)
			}

			if (request.method === 'GET' && path === '/state') {
				const chainId = chainIdOf(url)
				const stored = readJsonFile(statePath(chainId))
				return json(stored ?? {})
			}

			if (request.method === 'POST' && path === '/state') {
				const state = canaryStateSchema.parse(await request.json())
				writeJsonFile(statePath(state.chainId), state)
				console.log(
					`[canary-service] stored state chain=${state.chainId} block=${state.blockNumber} addresses=${Object.keys(state.addresses).length}`,
				)
				return json({ ok: true, addresses: Object.keys(state.addresses).length })
			}

			if (request.method === 'POST' && path === '/alerts') {
				const body = (await request.json()) as { alerts?: unknown[] }
				const incoming = (body.alerts ?? []).map((a) => alertSchema.parse(a))
				if (incoming.length === 0) return json({ ok: true, stored: 0, duplicates: 0 })
				const chainId = incoming[0].chain.id
				const existing = loadAlerts(chainId)
				const seen = new Set(existing.map((a) => a.id))
				let stored = 0
				let duplicates = 0
				for (const alert of incoming) {
					if (seen.has(alert.id)) {
						duplicates += 1
						continue
					}
					seen.add(alert.id)
					existing.push(alert)
					stored += 1
					console.log(
						`[canary-service] ALERT ${alert.severity} ${alert.address} moved ${alert.movement.movedEth} ETH after ${alert.dormancy.days}d dormant (tx ${alert.movement.txHash ?? 'unknown'})`,
					)
				}
				if (stored > 0) writeJsonFile(alertsPath(chainId), existing)
				return json({ ok: true, stored, duplicates })
			}

			if (request.method === 'GET' && path === '/alerts') {
				return json(loadAlerts(chainIdOf(url)))
			}

			if (request.method === 'GET' && path === '/alerts/latest') {
				const alerts = loadAlerts(chainIdOf(url))
				return json(alerts.length > 0 ? alerts[alerts.length - 1] : {})
			}

			if (request.method === 'GET' && path === '/locate-move') {
				const address = url.searchParams.get('address')
				const fromBlock = Number(url.searchParams.get('fromBlock'))
				const toBlock = Number(url.searchParams.get('toBlock'))
				if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
					return json({ error: 'address query parameter must be a 20-byte hex address' }, 400)
				}
				if (!Number.isInteger(fromBlock) || !Number.isInteger(toBlock)) {
					return json({ error: 'fromBlock and toBlock must be integers' }, 400)
				}
				return json(await locateMove(address, fromBlock, toBlock))
			}

			return json({ error: `no route for ${request.method} ${path}` }, 404)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			console.error(`[canary-service] ${request.method} ${path} failed: ${message}`)
			return json({ error: message }, 400)
		}
	},
})

console.log(
	`[canary-service] listening on http://${server.hostname}:${server.port} rpc=${args.rpc} watchlists=${args.watchlists.join(', ')} data=${dataDir}`,
)
