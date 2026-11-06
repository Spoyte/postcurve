/**
 * Build a canary watchlist from chain data alone.
 *
 * What goes on the list: an address that has sent at least one transaction (so its
 * public key is on-chain), still holds a lot of value, and has not sent anything
 * since that transaction.
 *
 * How it is proven, with nothing but standard JSON-RPC and no API key:
 *
 *   1. Sample old blocks and collect the senders of large-value transactions. A
 *      sender signed that transaction, so its public key is public: that is the
 *      exposure evidence, with a transaction hash and a block.
 *   2. For each candidate, compare the nonce in that transaction with the account's
 *      nonce today. If today's nonce is exactly one higher, the account has sent
 *      nothing since: dormancy is proven, not guessed, and the sampled block's
 *      timestamp is the exact start of it.
 *   3. Keep the ones that still hold at least --min-balance-eth.
 *
 * Step 2 is why this needs no archive node and no indexer: the nonce is in the latest
 * state, and the transaction that set it was in the sampled block. The cost is that
 * dormancy can only be proven for addresses whose last transaction falls inside the
 * sampled range, so a wider sample finds more. Nothing is invented: an address that
 * cannot be verified is dropped, not downgraded.
 *
 * Mainnet, roughly a thousand sampled blocks from 2016-2017:
 *
 *   bun run watchlist/build-watchlist.ts \
 *     --rpc https://ethereum.publicnode.com \
 *     --chain-id 1 --chain-label "ethereum mainnet" \
 *     --from-block 1500000 --to-block 5000000 --step 3500 \
 *     --min-tx-value-eth 100 --min-balance-eth 100 --max-entries 20 \
 *     --out watchlist/watchlist.mainnet.json
 *
 * The local devnet, every block, so the staged demo address is found:
 *
 *   bun run watchlist/build-watchlist.ts \
 *     --rpc http://127.0.0.1:18545 \
 *     --chain-id 1337 --chain-label "local EIP-8141 devnet (ethrex, chain id 1337)" \
 *     --from-block 0 --step 1 --min-tx-value-eth 1 --min-balance-eth 100 \
 *     --labels .state/demo-labels.json \
 *     --out watchlist/watchlist.devnet.json
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import {
	WATCHLIST_SCHEMA,
	formatWeiAsEth,
	watchlistSchema,
	type WatchEntry,
	type Watchlist,
} from '../workflow/types'

type Args = {
	rpc: string
	chainId: number
	chainLabel: string
	fromBlock: number
	toBlock: number | 'head'
	step: number
	minTxValueWei: bigint
	maxTxNonce: number
	minBalanceWei: bigint
	candidates: 'senders' | 'recipients' | 'both'
	unprovenDormancy: boolean
	maxCurrentNonce: number
	maxEntries: number
	out: string
	labels?: string
	concurrency: number
}

const ETH = 10n ** 18n
const toWei = (eth: string): bigint => {
	const [whole, frac = ''] = eth.split('.')
	return BigInt(whole) * ETH + BigInt((frac + '0'.repeat(18)).slice(0, 18))
}

const usage = `usage: bun run watchlist/build-watchlist.ts [options]

  --rpc URL                  JSON-RPC endpoint (default http://127.0.0.1:18545)
  --chain-id N               chain id to record in the watchlist (required)
  --chain-label TEXT         human label for the chain (required)
  --from-block N             first block to sample (default 0)
  --to-block N|head          last block to sample (default head)
  --step N                   sample every Nth block (default 1)
  --min-tx-value-eth N       only treat senders of transactions this large as candidates (default 50)
  --max-tx-nonce N           skip senders whose transaction nonce is above this; exchange hot
                             wallets have huge nonces, the accounts worth watching do not
                             (default: no limit)
  --min-balance-eth N        drop candidates holding less than this today (default 100)
  --candidates MODE          where candidates come from: senders (default), recipients, or both.
                             A sender's dormancy can be proven from its nonce; a recipient only
                             shows that an address is large and has signed at least once
  --allow-unproven-dormancy  keep large, exposed addresses whose dormancy could not be proven at
                             build time. The canary then times their dormancy from its first
                             sighting, and the entry carries no dormancy seed
  --max-current-nonce N      with --allow-unproven-dormancy, skip accounts that have sent more
                             than this many transactions (default 50): busy accounts are not
                             what this watches
  --max-entries N            keep at most this many entries, richest first (default 25)
  --labels FILE              JSON object mapping address -> label
  --concurrency N            parallel RPC requests (default 4)
  --out FILE                 where to write the watchlist (required)
`

const parseArgs = (argv: string[]): Args => {
	const args: Args = {
		rpc: process.env.CANARY_RPC_URL ?? 'http://127.0.0.1:18545',
		chainId: 0,
		chainLabel: '',
		fromBlock: 0,
		toBlock: 'head',
		step: 1,
		minTxValueWei: toWei('50'),
		maxTxNonce: Number.POSITIVE_INFINITY,
		minBalanceWei: toWei('100'),
		candidates: 'senders',
		unprovenDormancy: false,
		maxCurrentNonce: 50,
		maxEntries: 25,
		out: '',
		concurrency: 4,
	}
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i]
		const value = argv[i + 1]
		const next = () => {
			i += 1
			if (value === undefined) throw new Error(`${flag} needs a value`)
			return value
		}
		switch (flag) {
			case '--rpc':
				args.rpc = next()
				break
			case '--chain-id':
				args.chainId = Number(next())
				break
			case '--chain-label':
				args.chainLabel = next()
				break
			case '--from-block':
				args.fromBlock = Number(next())
				break
			case '--to-block': {
				const v = next()
				args.toBlock = v === 'head' ? 'head' : Number(v)
				break
			}
			case '--step':
				args.step = Math.max(1, Number(next()))
				break
			case '--min-tx-value-eth':
				args.minTxValueWei = toWei(next())
				break
			case '--max-tx-nonce':
				args.maxTxNonce = Number(next())
				break
			case '--candidates': {
				const v = next()
				if (v !== 'senders' && v !== 'recipients' && v !== 'both') {
					throw new Error(`--candidates must be senders, recipients or both, not ${v}`)
				}
				args.candidates = v
				break
			}
			case '--allow-unproven-dormancy':
				args.unprovenDormancy = true
				break
			case '--max-current-nonce':
				args.maxCurrentNonce = Number(next())
				break
			case '--min-balance-eth':
				args.minBalanceWei = toWei(next())
				break
			case '--max-entries':
				args.maxEntries = Number(next())
				break
			case '--labels':
				args.labels = next()
				break
			case '--concurrency':
				args.concurrency = Math.max(1, Number(next()))
				break
			case '--out':
				args.out = next()
				break
			case '--help':
				console.log(usage)
				process.exit(0)
			default:
				throw new Error(`unknown argument: ${flag}\n\n${usage}`)
		}
	}
	if (!args.chainId) throw new Error(`--chain-id is required\n\n${usage}`)
	if (!args.chainLabel) throw new Error(`--chain-label is required\n\n${usage}`)
	if (!args.out) throw new Error(`--out is required\n\n${usage}`)
	return args
}

const args = parseArgs(process.argv.slice(2))
const root = join(import.meta.dir, '..')
const resolve = (p: string) => (isAbsolute(p) ? p : join(root, p))

/** A JSON-RPC error answer: the node understood the request and refused it. */
class RpcError extends Error {}

/**
 * Nodes drop old block bodies (EIP-4444 and friends), and most public endpoints also
 * refuse historical state without a paid token. Both are a flat refusal for one block,
 * not a reason to stop: the block is skipped and reported at the end.
 */
const isUnavailableHistory = (error: unknown) =>
	error instanceof RpcError &&
	/prun|unavailable|not available|missing trie|archive|no historical|too old/i.test(error.message)


let rpcId = 0
const rpc = async <T>(method: string, params: unknown[], attempt = 0): Promise<T> => {
	try {
		const response = await fetch(args.rpc, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
		})
		if (response.status === 429 || response.status >= 500) {
			throw new Error(`HTTP ${response.status}`)
		}
		const body = (await response.json()) as { result?: T; error?: { message: string } }
		if (body.error) throw new RpcError(body.error.message)
		return body.result as T
	} catch (error) {
		// Rate limits and network trouble: retry. A flat refusal: do not, except for
		// "history unavailable", which on a load-balanced public endpoint depends on
		// which backend answered, so the same request can succeed on the next try.
		const retryable = !(error instanceof RpcError) || isUnavailableHistory(error)
		if (!retryable || attempt >= 4) throw error
		await new Promise((r) => setTimeout(r, 400 * 2 ** attempt))
		return rpc<T>(method, params, attempt + 1)
	}
}

let skippedBlocks = 0
let earliestAvailable: number | undefined
let firstSkipReason: string | undefined

const rpcOptionalBlock = async <T>(method: string, params: unknown[]): Promise<T | null> => {
	try {
		return await rpc<T>(method, params)
	} catch (error) {
		if (!isUnavailableHistory(error)) throw error
		skippedBlocks += 1
		const message = (error as Error).message
		firstSkipReason ??= message
		const match = /earliest available (\d+)/i.exec(message)
		if (match) {
			const earliest = Number(match[1])
			earliestAvailable = earliestAvailable === undefined ? earliest : Math.max(earliestAvailable, earliest)
		}
		return null
	}
}

/** Run `work` over `items` with a fixed number of workers. */
const pool = async <T, R>(items: T[], workers: number, work: (item: T) => Promise<R>): Promise<R[]> => {
	const results: R[] = new Array(items.length)
	let cursor = 0
	await Promise.all(
		Array.from({ length: Math.min(workers, items.length) }, async () => {
			for (;;) {
				const index = cursor++
				if (index >= items.length) return
				results[index] = await work(items[index])
			}
		}),
	)
	return results
}

type RpcBlock = {
	number: string
	timestamp: string
	transactions: { hash: string; from: string | null; to: string | null; value: string; nonce: string }[]
}

/** One transaction seen in the sample. */
type SeenTx = {
	txHash: string
	nonce: number
	block: number
	timestamp: number
	valueWei: bigint
}

type Candidate = {
	address: string
	/** The highest-nonce transaction this address was seen sending. */
	sent?: SeenTx
	/** The largest transfer this address was seen receiving. */
	received?: SeenTx
}

const main = async () => {
	const chainIdOnChain = Number(BigInt(await rpc<string>('eth_chainId', [])))
	if (chainIdOnChain !== args.chainId) {
		throw new Error(
			`--chain-id ${args.chainId} does not match the RPC, which reports chain ${chainIdOnChain}`,
		)
	}
	const head = Number(BigInt(await rpc<string>('eth_blockNumber', [])))
	const toBlock = args.toBlock === 'head' ? head : Math.min(args.toBlock, head)
	const blocks: number[] = []
	for (let n = args.fromBlock; n <= toBlock; n += args.step) blocks.push(n)
	console.log(
		`[build-watchlist] chain ${args.chainId}, head ${head}, sampling ${blocks.length} block(s) from ${args.fromBlock} to ${toBlock} step ${args.step}`,
	)

	// --- 1. candidates from the sampled blocks: who sent large value, who received it
	const best = new Map<string, Candidate>()
	let sampled = 0
	const wantSenders = args.candidates !== 'recipients'
	const wantRecipients = args.candidates !== 'senders'
	await pool(blocks, args.concurrency, async (n) => {
		const block = await rpcOptionalBlock<RpcBlock>('eth_getBlockByNumber', [`0x${n.toString(16)}`, true])
		sampled += 1
		if (sampled % 200 === 0) console.log(`[build-watchlist] sampled ${sampled}/${blocks.length} blocks`)
		if (!block) return
		const timestamp = Number(BigInt(block.timestamp))
		const blockNumber = Number(BigInt(block.number))
		for (const tx of block.transactions) {
			const valueWei = BigInt(tx.value)
			if (valueWei < args.minTxValueWei) continue
			const seen: SeenTx = {
				txHash: tx.hash,
				nonce: Number(BigInt(tx.nonce)),
				block: blockNumber,
				timestamp,
				valueWei,
			}

			if (wantSenders && tx.from && seen.nonce <= args.maxTxNonce) {
				const address = tx.from.toLowerCase()
				const entry: Candidate = best.get(address) ?? { address: tx.from }
				// Keep the highest nonce: only the account's last transaction can prove dormancy.
				if (!entry.sent || seen.nonce > entry.sent.nonce) entry.sent = seen
				best.set(address, entry)
			}

			if (wantRecipients && tx.to) {
				const address = tx.to.toLowerCase()
				const entry: Candidate = best.get(address) ?? { address: tx.to }
				if (!entry.received || seen.valueWei > entry.received.valueWei) entry.received = seen
				best.set(address, entry)
			}
		}
	})
	if (skippedBlocks > 0) {
		console.warn(
			`[build-watchlist] ${skippedBlocks} of ${blocks.length} sampled block(s) were not served: ${firstSkipReason}`,
		)
		if (earliestAvailable !== undefined) {
			console.warn(
				`[build-watchlist] this endpoint keeps history from block ${earliestAvailable}; re-run with --from-block ${earliestAvailable} or point --rpc at a node that keeps more`,
			)
		}
		if (skippedBlocks === blocks.length) {
			throw new Error(
				'every sampled block was refused, so nothing could be verified: raise --from-block or use another --rpc',
			)
		}
	}
	console.log(
		`[build-watchlist] ${best.size} candidate address(es) around transfers over ${formatWeiAsEth(args.minTxValueWei)} ETH (mode: ${args.candidates})`,
	)

	// --- 2 and 3. still rich, key already exposed, and as quiet as can be proven
	type Checked = {
		candidate: Candidate
		balanceWei: bigint
		currentNonce: number
		/** Set when the account's last transaction is in the sample, so dormancy is proven. */
		dormantSince?: SeenTx
	}
	const dropped = { poor: 0, unexposed: 0, active: 0, contract: 0 }
	const checked = await pool([...best.values()], args.concurrency, async (candidate): Promise<Checked | null> => {
		const [balanceHex, nonceHex] = await Promise.all([
			rpc<string>('eth_getBalance', [candidate.address, 'latest']),
			rpc<string>('eth_getTransactionCount', [candidate.address, 'latest']),
		])
		const balanceWei = BigInt(balanceHex)
		const currentNonce = Number(BigInt(nonceHex))

		if (balanceWei < args.minBalanceWei) {
			dropped.poor += 1
			return null
		}
		// A nonce of 0 means this account has never signed: its public key is still
		// hidden behind the address hash, so it is not what the canary watches.
		if (currentNonce === 0) {
			dropped.unexposed += 1
			return null
		}

		// Dormancy is proven only when the account's last transaction is one we sampled.
		if (candidate.sent && currentNonce === candidate.sent.nonce + 1) {
			return { candidate, balanceWei, currentNonce, dormantSince: candidate.sent }
		}

		// Otherwise the account is only known to be large and exposed. That is worth
		// watching if it is not obviously busy, and the canary times the dormancy itself.
		if (!args.unprovenDormancy) {
			dropped.active += 1
			return null
		}
		if (currentNonce > args.maxCurrentNonce) {
			dropped.active += 1
			return null
		}
		// Code at the address means a contract (or a delegated account): the nonce says
		// nothing about signatures there, so it cannot be judged this way.
		const code = await rpc<string>('eth_getCode', [candidate.address, 'latest'])
		if (code && code !== '0x') {
			dropped.contract += 1
			return null
		}
		return { candidate, balanceWei, currentNonce }
	})
	console.log(
		`[build-watchlist] dropped ${dropped.poor} too small, ${dropped.unexposed} never signed (key still hidden), ${dropped.active} too active or dormancy unprovable, ${dropped.contract} contract or delegated`,
	)

	const kept = checked
		.filter((c): c is Checked => c !== null)
		.sort((a, b) => (b.balanceWei > a.balanceWei ? 1 : b.balanceWei < a.balanceWei ? -1 : 0))
		.slice(0, args.maxEntries)

	// Label files are written by hand or by the demo, so match addresses case-insensitively.
	const labels = new Map<string, string>(
		Object.entries(
			args.labels
				? (JSON.parse(readFileSync(resolve(args.labels), 'utf-8')) as Record<string, string>)
				: {},
		).map(([address, label]) => [address.toLowerCase(), label]),
	)
	const labelFor = (address: string) => labels.get(address.toLowerCase())

	const entries: WatchEntry[] = kept.map((c) => {
		const address = c.candidate.address
		const common = {
			address,
			label: labelFor(address),
			balanceWeiAtBuild: c.balanceWei.toString(),
		}

		if (c.dormantSince) {
			// The account's own last transaction: exposure and dormancy both proven.
			const sent = c.dormantSince
			return {
				...common,
				exposure: {
					kind: 'transaction-sender' as const,
					evidenceTx: sent.txHash,
					evidenceBlock: sent.block,
					evidenceAt: sent.timestamp,
					evidenceNonce: sent.nonce,
					source: `chain ${args.chainId} JSON-RPC: sender of a ${formatWeiAsEth(sent.valueWei)} ETH transaction at nonce ${sent.nonce}, and the account nonce is still ${c.currentNonce}, so it has sent nothing since`,
				},
				lastOutgoingBlock: sent.block,
				lastOutgoingAt: sent.timestamp,
			}
		}

		// Large and exposed, but its last transaction was not in the sample: no dormancy
		// seed, so the canary starts its clock at the first run that sees this address.
		const received = c.candidate.received
		return {
			...common,
			exposure: {
				kind: 'transaction-sender' as const,
				source: `chain ${args.chainId} JSON-RPC: account nonce is ${c.currentNonce}, so it has signed at least once and its public key is on-chain${received ? `; seen receiving ${formatWeiAsEth(received.valueWei)} ETH in block ${received.block}` : ''}. Its last outgoing transaction was not in the sampled range, so dormancy was not proven at build time and the canary times it from first sighting`,
			},
		}
	})

	const watchlist: Watchlist = {
		schema: WATCHLIST_SCHEMA,
		chainId: args.chainId,
		chainLabel: args.chainLabel,
		source: `built from chain ${args.chainId} JSON-RPC alone: ${args.candidates === 'senders' ? 'senders' : args.candidates === 'recipients' ? 'recipients' : 'senders and recipients'} of transfers over ${formatWeiAsEth(args.minTxValueWei)} ETH in blocks ${args.fromBlock}..${toBlock} (step ${args.step}), kept if they hold over ${formatWeiAsEth(args.minBalanceWei)} ETH today and their account nonce is above 0 (so their public key is on-chain). Dormancy is proven by an unmoved nonce where the account's last transaction fell inside the sample${args.unprovenDormancy ? `; other entries carry no dormancy seed and the canary times them from first sighting (accounts with a nonce over ${args.maxCurrentNonce}, contracts and delegated accounts excluded)` : ' and entries without that proof were dropped'}`,
		builtAt: Math.floor(Date.now() / 1000),
		builtBy: `watchlist/build-watchlist.ts --chain-id ${args.chainId} --from-block ${args.fromBlock} --to-block ${toBlock} --step ${args.step} --min-tx-value-eth ${formatWeiAsEth(args.minTxValueWei)}${Number.isFinite(args.maxTxNonce) ? ` --max-tx-nonce ${args.maxTxNonce}` : ''} --min-balance-eth ${formatWeiAsEth(args.minBalanceWei)} --candidates ${args.candidates}${args.unprovenDormancy ? ` --allow-unproven-dormancy --max-current-nonce ${args.maxCurrentNonce}` : ''}`,
		entries,
	}
	watchlistSchema.parse(watchlist)

	const outPath = resolve(args.out)
	mkdirSync(dirname(outPath), { recursive: true })
	writeFileSync(outPath, `${JSON.stringify(watchlist, null, 2)}\n`)
	console.log(`[build-watchlist] wrote ${entries.length} entr(ies) to ${outPath}`)
	for (const entry of entries) {
		const balance = formatWeiAsEth(BigInt(entry.balanceWeiAtBuild ?? '0'))
		if (entry.lastOutgoingAt === undefined) {
			console.log(`  ${entry.address} ${balance} ETH, exposed, dormancy not proven at build time`)
			continue
		}
		const dormantDays = ((Date.now() / 1000 - entry.lastOutgoingAt) / 86400).toFixed(0)
		console.log(
			`  ${entry.address} ${balance} ETH, dormant ${dormantDays} days (since block ${entry.lastOutgoingBlock})`,
		)
	}
}

await main()
