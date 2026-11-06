/**
 * Tests for the workflow shell: the HTTP helpers that run on each node, the trigger
 * wiring, the shipped config files, and the promise that what detect.ts emits really
 * does match the documented alert and state schemas.
 *
 * The SendRequester here is a test double, in a test file, standing in for the CRE HTTP
 * capability. The simulation in the README is the real thing; this is not.
 */

import { describe, expect, test } from 'bun:test'
import devnetConfig from './config.devnet.json'
import mainnetConfig from './config.mainnet.json'
import { evaluate, type Thresholds } from './detect'
import {
	alertSchema,
	canaryStateSchema,
	watchlistSchema,
	WATCHLIST_SCHEMA,
	type WatchEntry,
} from './types'
import { configSchema, httpGetText, httpPostJson, initWorkflow, onCronTrigger } from './workflow'

const ETH = 10n ** 18n

type Captured = { method?: string; url?: string; headers?: Record<string, string>; body?: string }

const fakeRequester = (statusCode: number, body: unknown, captured: Captured = {}) =>
	({
		sendRequest: (request: Captured) => {
			Object.assign(captured, request)
			return {
				result: () => ({
					statusCode,
					body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
				}),
			}
		},
	}) as never

describe('httpGetText', () => {
	test('returns the body as text', () => {
		const text = httpGetText(fakeRequester(200, { ok: true }), 'http://canary.invalid/state')
		expect(JSON.parse(text)).toEqual({ ok: true })
	})

	test('throws on a non-2xx status, naming the URL and the status', () => {
		expect(() => httpGetText(fakeRequester(503, 'down'), 'http://canary.invalid/watchlist')).toThrow(
			'GET http://canary.invalid/watchlist failed with status 503',
		)
	})
})

describe('httpPostJson', () => {
	test('sends base64-encoded JSON with a JSON content type and returns the status', () => {
		const captured: Captured = {}
		const payload = JSON.stringify({ alerts: [] })
		const status = httpPostJson(fakeRequester(200, { ok: true }, captured), 'http://canary.invalid/alerts', payload)

		expect(status).toBe('200')
		expect(captured.method).toBe('POST')
		expect(captured.headers).toEqual({ 'content-type': 'application/json' })
		expect(Buffer.from(String(captured.body), 'base64').toString('utf-8')).toBe(payload)
	})

	test('throws when the sink rejects the alert, so the state is not advanced', () => {
		expect(() =>
			httpPostJson(fakeRequester(500, 'nope'), 'http://canary.invalid/alerts', '{}'),
		).toThrow('POST http://canary.invalid/alerts failed with status 500')
	})
})

describe('initWorkflow', () => {
	test('registers one cron handler on the configured schedule', () => {
		const config = configSchema.parse(devnetConfig)
		const handlers = initWorkflow(config)

		expect(handlers).toHaveLength(1)
		expect(handlers[0].fn).toBe(onCronTrigger)
		const trigger = handlers[0].trigger as { config?: { schedule?: string } }
		expect(trigger.config?.schedule).toBe(config.schedule)
	})
})

describe('shipped configs', () => {
	test('the devnet config parses and watches the local devnet', () => {
		const config = configSchema.parse(devnetConfig)
		expect(config.chain.id).toBe(1337)
		expect(config.chain.isTestnet).toBe(true)
		expect(config.run.mode).toBe('cre-cli-simulation')
		// Minutes, not years: a devnet is minutes old, and the README says so.
		expect(config.thresholds.minDormancySeconds).toBe(120)
	})

	test('the mainnet config parses and asks for real dormancy', () => {
		const config = configSchema.parse(mainnetConfig)
		expect(config.chain.id).toBe(1)
		expect(config.chain.creChainName).toBe('ethereum-mainnet')
		expect(config.thresholds.minDormancySeconds).toBeGreaterThanOrEqual(365 * 86400)
		// Matches the floor the shipped mainnet watchlist was built with, so an entry on
		// the list can actually clear the threshold.
		expect(BigInt(config.thresholds.minBalanceWei)).toBeGreaterThanOrEqual(100n * ETH)
		// No block scan on mainnet by default: a public RPC should not be asked to.
		expect(config.service.locateMove).toBe(false)
	})

	test('a nonsense threshold is rejected rather than silently clamped', () => {
		expect(() =>
			configSchema.parse({ ...devnetConfig, thresholds: { ...devnetConfig.thresholds, minMovedFraction: 1.5 } }),
		).toThrow()
	})
})

describe('what the workflow emits matches the documented schemas', () => {
	const thresholds: Thresholds = {
		minDormancySeconds: 120,
		minMovedFraction: 0.5,
		minMovedWei: 10n * ETH,
		minBalanceWei: 100n * ETH,
	}
	const address = '0x3333333333333333333333333333333333333333'
	const entry: WatchEntry = {
		address,
		label: 'staged devnet account',
		exposure: {
			kind: 'transaction-sender',
			evidenceTx: `0x${'11'.repeat(32)}`,
			evidenceBlock: 10,
			evidenceAt: 1_700_000_000,
			evidenceNonce: 1,
			source: 'chain 1337 JSON-RPC',
		},
		lastOutgoingBlock: 10,
		lastOutgoingAt: 1_700_000_000,
		balanceWeiAtBuild: (499n * ETH).toString(),
	}

	const result = evaluate({
		entries: [entry],
		priorState: {
			schema: 'postcurve.canary.state/v1',
			chainId: 1337,
			blockNumber: 20,
			updatedAt: 1_700_000_200,
			addresses: {
				[address.toLowerCase()]: {
					address,
					balanceWei: (499n * ETH).toString(),
					blockNumber: 20,
					observedAt: 1_700_000_200,
					lastOutgoingBlock: 10,
					lastOutgoingAt: 1_700_000_000,
					dormancyObserved: false,
				},
			},
		},
		observations: [{ address, balanceWei: ETH / 100n }],
		observedBlock: 60,
		observedAt: 1_700_000_400,
		thresholds,
		chain: { id: 1337, label: 'local EIP-8141 devnet', creChainName: 'private-testnet-rhyolite' },
		run: { workflow: 'postcurve-canary-devnet', mode: 'unit-test', watchlistSource: 'test fixture' },
	})

	test('every alert validates against the published alert schema', () => {
		expect(result.alerts).toHaveLength(1)
		expect(() => alertSchema.parse(result.alerts[0])).not.toThrow()
	})

	test('the state validates against the published state schema', () => {
		expect(() => canaryStateSchema.parse(result.nextState)).not.toThrow()
	})

	test('an alert survives a JSON round trip, as the hardware will read it', () => {
		const roundTripped = JSON.parse(JSON.stringify(result.alerts[0]))
		expect(() => alertSchema.parse(roundTripped)).not.toThrow()
		expect(roundTripped.movement.movedWei).toBe((499n * ETH - ETH / 100n).toString())
	})

	test('a watchlist built the way the builder builds them validates', () => {
		expect(() =>
			watchlistSchema.parse({
				schema: WATCHLIST_SCHEMA,
				chainId: 1337,
				chainLabel: 'local EIP-8141 devnet',
				source: 'chain 1337 JSON-RPC block scan',
				builtAt: 1_700_000_000,
				entries: [entry],
			}),
		).not.toThrow()
	})
})
