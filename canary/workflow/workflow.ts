/**
 * postcurve canary: a Chainlink CRE workflow.
 *
 *   cron trigger
 *     -> GET the watchlist and the last known state from the canary service (HTTP)
 *     -> read the head block and one balance per watched address from an EVM chain
 *     -> decide (detect.ts)
 *     -> POST any alerts to the canary service, then POST the new state
 *
 * The two sides the Chainlink track asks for are the EVM chain (balances, head block)
 * and the canary service (an ordinary HTTP system that holds the watchlist, the state
 * and the alert sink, and that the hardware canary light polls).
 *
 * Ordering matters: the state is written only after the alerts are accepted. If the
 * alert POST fails the state stays where it was, so the next run sees the same drop
 * again and retries instead of silently swallowing it.
 *
 * Determinism matters too: in a real DON every node runs the HTTP calls and the
 * results go through consensus, so the service must answer GETs with byte-identical
 * bodies for the same state (no server timestamps, sorted keys) and must treat POSTs
 * as idempotent on `alert.id`.
 */

import {
	bigintToProtoBigInt,
	consensusIdenticalAggregation,
	cre,
	getNetwork,
	hexToBase64,
	protoBigIntToBigint,
	type CronPayload,
	type HTTPSendRequester,
	type Runtime,
} from '@chainlink/cre-sdk'
import { z } from 'zod'
import { evaluate, withTxHash, type Observation, type Thresholds } from './detect'
import {
	canaryStateSchema,
	formatWeiAsEth,
	watchlistSchema,
	type Alert,
	type CanaryState,
	type WatchEntry,
} from './types'

export const configSchema = z.object({
	/** CRE cron expression, 6 fields (seconds first). */
	schedule: z.string(),
	chain: z.object({
		/**
		 * CRE chain-selector name. The RPC URL behind it comes from project.yaml, so
		 * this is also what picks mainnet or the local devnet.
		 */
		creChainName: z.string(),
		isTestnet: z.boolean(),
		/** The real chain id, for the alert. Not readable through the EVM capability. */
		id: z.number().int().positive(),
		label: z.string(),
	}),
	service: z.object({
		/** Base URL of the canary service, e.g. http://127.0.0.1:8787 */
		baseUrl: z.string(),
		/** Set false on a chain where no locator is available (then txHash stays null). */
		locateMove: z.boolean(),
	}),
	thresholds: z.object({
		minDormancySeconds: z.number().int().nonnegative(),
		minMovedFraction: z.number().min(0).max(1),
		minMovedWei: z.string(),
		minBalanceWei: z.string(),
	}),
	/** Hard cap on addresses read per run, so one huge watchlist can't blow the budget. */
	maxAddresses: z.number().int().positive(),
	run: z.object({
		workflow: z.string(),
		/** "cre-cli-simulation" for `cre workflow simulate`, "cre-don" once deployed. */
		mode: z.string(),
	}),
})

export type Config = z.infer<typeof configSchema>

const asThresholds = (config: Config): Thresholds => ({
	minDormancySeconds: config.thresholds.minDormancySeconds,
	minMovedFraction: config.thresholds.minMovedFraction,
	minMovedWei: BigInt(config.thresholds.minMovedWei),
	minBalanceWei: BigInt(config.thresholds.minBalanceWei),
})

// ---------------------------------------------------------------- HTTP helpers

/** GET a URL and return the body as text. Runs on every node; consensus compares bodies. */
export const httpGetText = (sendRequester: HTTPSendRequester, url: string): string => {
	const response = sendRequester.sendRequest({ method: 'GET', url }).result()
	if (response.statusCode < 200 || response.statusCode >= 300) {
		throw new Error(`GET ${url} failed with status ${response.statusCode}`)
	}
	return Buffer.from(response.body).toString('utf-8')
}

/** POST JSON and return the status code as text, so consensus has something stable. */
export const httpPostJson = (
	sendRequester: HTTPSendRequester,
	url: string,
	body: string,
): string => {
	const response = sendRequester.sendRequest({
		method: 'POST',
		url,
		headers: { 'content-type': 'application/json' },
		body: Buffer.from(body, 'utf-8').toString('base64'),
	}).result()
	if (response.statusCode < 200 || response.statusCode >= 300) {
		throw new Error(`POST ${url} failed with status ${response.statusCode}`)
	}
	return String(response.statusCode)
}

const getText = (runtime: Runtime<Config>, url: string): string => {
	const http = new cre.capabilities.HTTPClient()
	return http
		.sendRequest(runtime, httpGetText, consensusIdenticalAggregation<string>())(url)
		.result()
}

const postJson = (runtime: Runtime<Config>, url: string, body: string): string => {
	const http = new cre.capabilities.HTTPClient()
	return http
		.sendRequest(runtime, httpPostJson, consensusIdenticalAggregation<string>())(url, body)
		.result()
}

// ---------------------------------------------------------------- the handler

export const onCronTrigger = (runtime: Runtime<Config>, _payload: CronPayload): string => {
	const config = runtime.config
	const base = config.service.baseUrl.replace(/\/+$/, '')

	const network = getNetwork({
		chainFamily: 'evm',
		chainSelectorName: config.chain.creChainName,
		isTestnet: config.chain.isTestnet,
	})
	if (!network) {
		throw new Error(`no CRE chain selector named ${config.chain.creChainName}`)
	}
	const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector)

	// --- the external system: what to watch, and what we saw last time
	const watchlist = watchlistSchema.parse(
		JSON.parse(getText(runtime, `${base}/watchlist?chainId=${config.chain.id}`)),
	)
	if (watchlist.chainId !== config.chain.id) {
		throw new Error(
			`watchlist is for chain ${watchlist.chainId}, this workflow watches ${config.chain.id}`,
		)
	}

	const rawState = JSON.parse(getText(runtime, `${base}/state?chainId=${config.chain.id}`)) as unknown
	const priorState: CanaryState | null =
		rawState && typeof rawState === 'object' && Object.keys(rawState as object).length > 0
			? canaryStateSchema.parse(rawState)
			: null
	if (priorState && priorState.chainId !== config.chain.id) {
		// Comparing one chain's balances against another chain's baseline would invent
		// movements out of nothing. Stop instead.
		throw new Error(
			`stored state is for chain ${priorState.chainId}, this workflow watches ${config.chain.id}`,
		)
	}
	const priorCount = priorState ? Object.keys(priorState.addresses).length : 0

	const entries: WatchEntry[] = watchlist.entries.slice(0, config.maxAddresses)
	if (watchlist.entries.length > entries.length) {
		runtime.log(
			`watchlist has ${watchlist.entries.length} entries, reading the first ${entries.length} (maxAddresses)`,
		)
	}

	// --- the chain: head block, then one balance per address at that exact block
	const header = evmClient.headerByNumber(runtime, {}).result()
	if (!header.header?.blockNumber) throw new Error('EVM headerByNumber returned no block number')
	const observedBlock = Number(protoBigIntToBigint(header.header.blockNumber))
	const observedAt = Number(header.header.timestamp)
	runtime.log(
		`chain=${config.chain.label} (id ${config.chain.id}) head=${observedBlock} at=${observedAt} watching=${entries.length} known=${priorCount}`,
	)

	const observations: Observation[] = entries.map((entry) => {
		try {
			const reply = evmClient
				.balanceAt(runtime, {
					account: hexToBase64(entry.address),
					blockNumber: bigintToProtoBigInt(observedBlock),
				})
				.result()
			if (!reply.balance) throw new Error('balanceAt returned no balance')
			return { address: entry.address, balanceWei: protoBigIntToBigint(reply.balance) }
		} catch (error) {
			// A failed read must never look like a sweep: detect.ts keeps the old state.
			const detail = error instanceof Error ? error.message : String(error)
			runtime.log(`balance read failed for ${entry.address}: ${detail}`)
			return { address: entry.address, error: detail }
		}
	})

	// --- decide
	const result = evaluate({
		entries,
		priorState,
		observations,
		observedBlock,
		observedAt,
		thresholds: asThresholds(config),
		chain: {
			id: config.chain.id,
			label: config.chain.label,
			creChainName: config.chain.creChainName,
		},
		run: {
			workflow: config.run.workflow,
			mode: config.run.mode,
			watchlistSource: watchlist.source,
		},
	})

	for (const decision of result.decisions) {
		runtime.log(`${decision.kind} ${decision.address}: ${decision.detail}`)
	}

	// --- name the transaction behind each alert, when the service can find it
	const alerts: Alert[] = result.alerts.map((alert) => {
		if (!config.service.locateMove) return alert
		try {
			const url = `${base}/locate-move?chainId=${config.chain.id}&address=${alert.address}&fromBlock=${alert.movement.baselineBlock}&toBlock=${alert.movement.observedBlock}`
			const located = JSON.parse(getText(runtime, url)) as { txHash?: string | null }
			return withTxHash(alert, located.txHash ?? null)
		} catch (error) {
			runtime.log(
				`move locator failed for ${alert.address}: ${error instanceof Error ? error.message : String(error)}`,
			)
			return alert
		}
	})

	// --- deliver: alerts first, state only once they are accepted
	if (alerts.length > 0) {
		const status = postJson(runtime, `${base}/alerts`, JSON.stringify({ alerts }))
		runtime.log(`posted ${alerts.length} alert(s), service answered ${status}`)
		for (const alert of alerts) {
			runtime.log(
				`ALERT ${alert.severity} ${alert.address} moved ${alert.movement.movedEth} ETH of ${formatWeiAsEth(BigInt(alert.movement.balanceBeforeWei))} ETH after ${alert.dormancy.days}d dormant, tx ${alert.movement.txHash ?? 'unknown'}`,
			)
		}
	}

	const stateStatus = postJson(runtime, `${base}/state`, JSON.stringify(result.nextState))
	runtime.log(
		`stored state for ${Object.keys(result.nextState.addresses).length} address(es), service answered ${stateStatus}`,
	)

	const counts: Record<string, number> = {}
	for (const decision of result.decisions) counts[decision.kind] = (counts[decision.kind] ?? 0) + 1

	return JSON.stringify({
		chainId: config.chain.id,
		block: observedBlock,
		observedAt,
		watched: entries.length,
		alerts: alerts.map((a) => ({
			id: a.id,
			severity: a.severity,
			address: a.address,
			movedEth: a.movement.movedEth,
			dormancyDays: a.dormancy.days,
			txHash: a.movement.txHash,
		})),
		decisions: counts,
		mode: config.run.mode,
	})
}

export function initWorkflow(config: Config) {
	const cron = new cre.capabilities.CronCapability()
	return [cre.handler(cron.trigger({ schedule: config.schedule }), onCronTrigger)]
}
