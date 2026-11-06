/**
 * Tests for the canary's detection logic.
 *
 * The cases that matter are the ones where a wrong answer is expensive: a false alarm
 * when an RPC read fails, an alarm on the first run before anything is known, a missed
 * sweep because the amount was expressed as a fraction, and dormancy restarting for the
 * wrong reason.
 */

import { describe, expect, test } from 'bun:test'
import { evaluate, withTxHash, type EvaluateInput, type Thresholds } from './detect'
import {
	ALERT_SCHEMA,
	STATE_SCHEMA,
	emptyState,
	formatWeiAsEth,
	type CanaryState,
	type WatchEntry,
} from './types'

const ETH = 10n ** 18n
const DAY = 86400

const WHALE = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'

const thresholds: Thresholds = {
	minDormancySeconds: 365 * DAY,
	minMovedFraction: 0.5,
	minMovedWei: 100n * ETH,
	minBalanceWei: 1000n * ETH,
}

const entry = (address: string, overrides: Partial<WatchEntry> = {}): WatchEntry => ({
	address,
	label: 'test entry',
	exposure: { kind: 'transaction-sender', source: 'test', evidenceNonce: 1 },
	lastOutgoingBlock: 100,
	lastOutgoingAt: 1_000_000_000,
	...overrides,
})

const stateWith = (
	addresses: Record<string, { balanceWei: bigint; lastOutgoingAt: number; observed?: boolean }>,
	blockNumber = 1000,
	updatedAt = 1_000_000_000 + 400 * DAY,
): CanaryState => ({
	schema: STATE_SCHEMA,
	chainId: 1,
	blockNumber,
	updatedAt,
	addresses: Object.fromEntries(
		Object.entries(addresses).map(([address, v]) => [
			address.toLowerCase(),
			{
				address,
				balanceWei: v.balanceWei.toString(),
				blockNumber,
				observedAt: updatedAt,
				lastOutgoingBlock: 100,
				lastOutgoingAt: v.lastOutgoingAt,
				dormancyObserved: v.observed ?? false,
			},
		]),
	),
})

const run = (input: Partial<EvaluateInput> & Pick<EvaluateInput, 'entries' | 'observations'>) =>
	evaluate({
		priorState: null,
		observedBlock: 2000,
		observedAt: 1_000_000_000 + 500 * DAY,
		thresholds,
		chain: { id: 1, label: 'ethereum mainnet', creChainName: 'ethereum-mainnet' },
		run: { workflow: 'test', mode: 'unit-test', watchlistSource: 'test fixture' },
		...input,
	})

describe('first run', () => {
	test('records a baseline and raises nothing, even for a huge balance', () => {
		const result = run({
			entries: [entry(WHALE)],
			observations: [{ address: WHALE, balanceWei: 50_000n * ETH }],
		})

		expect(result.alerts).toEqual([])
		expect(result.decisions[0]?.kind).toBe('baseline')
		expect(result.nextState.addresses[WHALE.toLowerCase()]).toMatchObject({
			balanceWei: (50_000n * ETH).toString(),
			blockNumber: 2000,
			lastOutgoingBlock: 100,
			lastOutgoingAt: 1_000_000_000,
			dormancyObserved: false,
		})
	})

	test('with no watchlist seed, the dormancy clock starts at the first observation', () => {
		const result = run({
			entries: [entry(WHALE, { lastOutgoingBlock: undefined, lastOutgoingAt: undefined })],
			observations: [{ address: WHALE, balanceWei: 50_000n * ETH }],
		})

		const stored = result.nextState.addresses[WHALE.toLowerCase()]
		expect(stored.lastOutgoingAt).toBe(1_000_000_000 + 500 * DAY)
		expect(stored.lastOutgoingBlock).toBe(2000)
		expect(result.decisions[0]?.detail).toContain('watchlist carried no seed')
	})

	test('an empty prior state is treated as no prior state', () => {
		const result = run({
			entries: [entry(WHALE)],
			priorState: emptyState(1),
			observations: [{ address: WHALE, balanceWei: 50_000n * ETH }],
		})
		expect(result.alerts).toEqual([])
		expect(result.decisions[0]?.kind).toBe('baseline')
	})
})

describe('a sweep after long dormancy', () => {
	const priorState = stateWith({ [WHALE]: { balanceWei: 10_000n * ETH, lastOutgoingAt: 1_000_000_000 } })

	test('alerts, with the numbers it saw', () => {
		const result = run({
			entries: [entry(WHALE)],
			priorState,
			observations: [{ address: WHALE, balanceWei: 10n * ETH }],
		})

		expect(result.alerts).toHaveLength(1)
		const alert = result.alerts[0]
		expect(alert.schema).toBe(ALERT_SCHEMA)
		expect(alert.address).toBe(WHALE)
		expect(alert.severity).toBe('alarm') // 99.9% of the balance left
		expect(alert.movement.movedWei).toBe((9_990n * ETH).toString())
		expect(alert.movement.movedEth).toBe('9990')
		expect(alert.movement.movedFraction).toBeCloseTo(0.999, 5)
		expect(alert.movement.baselineBlock).toBe(1000)
		expect(alert.movement.observedBlock).toBe(2000)
		expect(alert.movement.txHash).toBeNull()
		expect(alert.movement.txHashSource).toBe('unavailable')
		expect(alert.dormancy.seconds).toBe(500 * DAY)
		expect(alert.dormancy.days).toBe(500)
		expect(alert.dormancy.observed).toBe(false)
		expect(alert.cluster).toEqual({ alertsThisRun: 1, addressesChecked: 1 })
		expect(alert.proves).toContain('Nothing on its own')
	})

	test('the alert id is stable across identical runs and changes with the blocks', () => {
		const first = run({
			entries: [entry(WHALE)],
			priorState,
			observations: [{ address: WHALE, balanceWei: 10n * ETH }],
		})
		const again = run({
			entries: [entry(WHALE)],
			priorState,
			observations: [{ address: WHALE, balanceWei: 10n * ETH }],
		})
		const later = run({
			entries: [entry(WHALE)],
			priorState,
			observations: [{ address: WHALE, balanceWei: 10n * ETH }],
			observedBlock: 2001,
		})

		expect(first.alerts[0].id).toBe(again.alerts[0].id)
		expect(first.alerts[0].id).not.toBe(later.alerts[0].id)
		expect(first.alerts[0].id).toBe(`1:${WHALE.toLowerCase()}:1000-2000`)
	})

	test('the dormancy clock restarts at the move, so the next run starts from here', () => {
		const result = run({
			entries: [entry(WHALE)],
			priorState,
			observations: [{ address: WHALE, balanceWei: 10n * ETH }],
		})
		expect(result.nextState.addresses[WHALE.toLowerCase()]).toMatchObject({
			balanceWei: (10n * ETH).toString(),
			lastOutgoingBlock: 2000,
			lastOutgoingAt: 1_000_000_000 + 500 * DAY,
			dormancyObserved: true,
		})
	})

	test('severity is only a watch when a minority of the balance moves', () => {
		const result = run({
			entries: [entry(WHALE)],
			priorState,
			observations: [{ address: WHALE, balanceWei: 4_000n * ETH }], // 60% moved
		})
		expect(result.alerts[0].severity).toBe('watch')
		expect(result.alerts[0].movement.movedFraction).toBeCloseTo(0.6, 5)
	})
})

describe('thresholds', () => {
	const prior = (balance: bigint, lastOutgoingAt: number) =>
		stateWith({ [WHALE]: { balanceWei: balance, lastOutgoingAt } })

	test('a move inside the dormancy window does not alert', () => {
		const result = run({
			entries: [entry(WHALE)],
			// last outgoing 100 days before the observation
			priorState: prior(10_000n * ETH, 1_000_000_000 + 400 * DAY),
			observations: [{ address: WHALE, balanceWei: 10n * ETH }],
		})
		expect(result.alerts).toEqual([])
		expect(result.decisions[0]?.kind).toBe('move-below-threshold')
		expect(result.decisions[0]?.detail).toContain('dormant 8640000s, needs 31536000s')
	})

	test('a small share of the balance does not alert', () => {
		const result = run({
			entries: [entry(WHALE)],
			priorState: prior(10_000n * ETH, 1_000_000_000),
			observations: [{ address: WHALE, balanceWei: 9_000n * ETH }], // 10%
		})
		expect(result.alerts).toEqual([])
		expect(result.decisions[0]?.detail).toContain('10.00% of the balance, needs 50.00%')
	})

	test('a large share of a small balance does not alert', () => {
		const result = run({
			entries: [entry(WHALE)],
			priorState: prior(150n * ETH, 1_000_000_000),
			observations: [{ address: WHALE, balanceWei: 0n }],
		})
		expect(result.alerts).toEqual([])
		expect(result.decisions[0]?.detail).toContain('below minimum 1000 ETH')
	})

	test('the absolute floor blocks a full sweep that is still small in ETH', () => {
		const tight: Thresholds = { ...thresholds, minBalanceWei: 10n * ETH, minMovedWei: 500n * ETH }
		const result = run({
			entries: [entry(WHALE)],
			priorState: prior(200n * ETH, 1_000_000_000),
			observations: [{ address: WHALE, balanceWei: 0n }],
			thresholds: tight,
		})
		expect(result.alerts).toEqual([])
		expect(result.decisions[0]?.detail).toContain('moved 200 ETH, needs 500 ETH')
	})

	test('exactly on every threshold alerts', () => {
		const exact: Thresholds = {
			minDormancySeconds: 500 * DAY,
			minMovedFraction: 0.5,
			minMovedWei: 500n * ETH,
			minBalanceWei: 1000n * ETH,
		}
		const result = run({
			entries: [entry(WHALE)],
			priorState: prior(1000n * ETH, 1_000_000_000),
			observations: [{ address: WHALE, balanceWei: 500n * ETH }],
			thresholds: exact,
		})
		expect(result.alerts).toHaveLength(1)
		expect(result.alerts[0].movement.movedFraction).toBe(0.5)
	})
})

describe('failed reads', () => {
	test('an RPC failure never raises an alert and never loses the old state', () => {
		const priorState = stateWith({ [WHALE]: { balanceWei: 10_000n * ETH, lastOutgoingAt: 1_000_000_000 } })
		const result = run({
			entries: [entry(WHALE)],
			priorState,
			observations: [{ address: WHALE, error: 'balanceAt failed: connection refused' }],
		})

		expect(result.alerts).toEqual([])
		expect(result.decisions[0]).toMatchObject({ kind: 'read-failed' })
		expect(result.nextState.addresses[WHALE.toLowerCase()]).toEqual(
			priorState.addresses[WHALE.toLowerCase()],
		)
	})

	test('a missing observation is treated as a failed read, not as a zero balance', () => {
		const priorState = stateWith({ [WHALE]: { balanceWei: 10_000n * ETH, lastOutgoingAt: 1_000_000_000 } })
		const result = run({ entries: [entry(WHALE)], priorState, observations: [] })

		expect(result.alerts).toEqual([])
		expect(result.decisions[0]?.kind).toBe('read-failed')
		expect(result.nextState.addresses[WHALE.toLowerCase()].balanceWei).toBe((10_000n * ETH).toString())
	})

	test('one failed read does not stop another address from alerting', () => {
		const priorState = stateWith({
			[WHALE]: { balanceWei: 10_000n * ETH, lastOutgoingAt: 1_000_000_000 },
			[OTHER]: { balanceWei: 20_000n * ETH, lastOutgoingAt: 1_000_000_000 },
		})
		const result = run({
			entries: [entry(WHALE), entry(OTHER)],
			priorState,
			observations: [
				{ address: WHALE, error: 'timeout' },
				{ address: OTHER, balanceWei: 0n },
			],
		})

		expect(result.alerts).toHaveLength(1)
		expect(result.alerts[0].address).toBe(OTHER)
		expect(result.alerts[0].cluster.addressesChecked).toBe(2)
	})
})

describe('activity that is not a signature', () => {
	test('an incoming transfer does not reset dormancy and does not alert', () => {
		const priorState = stateWith({ [WHALE]: { balanceWei: 10_000n * ETH, lastOutgoingAt: 1_000_000_000 } })
		const result = run({
			entries: [entry(WHALE)],
			priorState,
			observations: [{ address: WHALE, balanceWei: 12_000n * ETH }],
		})

		expect(result.alerts).toEqual([])
		expect(result.decisions[0]?.kind).toBe('funded')
		const stored = result.nextState.addresses[WHALE.toLowerCase()]
		expect(stored.balanceWei).toBe((12_000n * ETH).toString())
		expect(stored.lastOutgoingAt).toBe(1_000_000_000)
	})

	test('an unchanged balance is quiet and only moves the observation forward', () => {
		const priorState = stateWith({ [WHALE]: { balanceWei: 10_000n * ETH, lastOutgoingAt: 1_000_000_000 } })
		const result = run({
			entries: [entry(WHALE)],
			priorState,
			observations: [{ address: WHALE, balanceWei: 10_000n * ETH }],
		})

		expect(result.alerts).toEqual([])
		expect(result.decisions[0]?.kind).toBe('quiet')
		expect(result.nextState.addresses[WHALE.toLowerCase()]).toMatchObject({
			blockNumber: 2000,
			observedAt: 1_000_000_000 + 500 * DAY,
			lastOutgoingAt: 1_000_000_000,
		})
	})
})

describe('a cluster of sweeps', () => {
	test('two addresses sweeping in one run are an alarm, even for a modest share', () => {
		const priorState = stateWith({
			[WHALE]: { balanceWei: 10_000n * ETH, lastOutgoingAt: 1_000_000_000 },
			[OTHER]: { balanceWei: 10_000n * ETH, lastOutgoingAt: 1_000_000_000 },
		})
		const result = run({
			entries: [entry(WHALE), entry(OTHER)],
			priorState,
			observations: [
				{ address: WHALE, balanceWei: 4_000n * ETH }, // 60%
				{ address: OTHER, balanceWei: 4_500n * ETH }, // 55%
			],
		})

		expect(result.alerts).toHaveLength(2)
		for (const alert of result.alerts) {
			expect(alert.severity).toBe('alarm')
			expect(alert.cluster).toEqual({ alertsThisRun: 2, addressesChecked: 2 })
		}
	})
})

describe('state hygiene', () => {
	test('addresses dropped from the watchlist are dropped from the state', () => {
		const priorState = stateWith({
			[WHALE]: { balanceWei: 10_000n * ETH, lastOutgoingAt: 1_000_000_000 },
			[OTHER]: { balanceWei: 10_000n * ETH, lastOutgoingAt: 1_000_000_000 },
		})
		const result = run({
			entries: [entry(WHALE)],
			priorState,
			observations: [{ address: WHALE, balanceWei: 10_000n * ETH }],
		})
		expect(Object.keys(result.nextState.addresses)).toEqual([WHALE.toLowerCase()])
	})

	test('state lookups are case-insensitive on the address', () => {
		const priorState = stateWith({ [WHALE.toUpperCase().replace('0X', '0x')]: { balanceWei: 10_000n * ETH, lastOutgoingAt: 1_000_000_000 } })
		const result = run({
			entries: [entry(WHALE)],
			priorState,
			observations: [{ address: WHALE.toUpperCase().replace('0X', '0x'), balanceWei: 0n }],
		})
		expect(result.alerts).toHaveLength(1)
	})

	test('an address listed twice is checked once and alerts once', () => {
		const priorState = stateWith({ [WHALE]: { balanceWei: 10_000n * ETH, lastOutgoingAt: 1_000_000_000 } })
		const result = run({
			entries: [entry(WHALE), entry(WHALE.toUpperCase().replace('0X', '0x'))],
			priorState,
			observations: [{ address: WHALE, balanceWei: 0n }],
		})
		expect(result.alerts).toHaveLength(1)
		expect(result.alerts[0].cluster).toEqual({ alertsThisRun: 1, addressesChecked: 1 })
		expect(result.decisions.filter((d) => d.kind === 'alert')).toHaveLength(1)
	})

	test('a zero prior balance cannot produce a move or divide by zero', () => {
		const priorState = stateWith({ [WHALE]: { balanceWei: 0n, lastOutgoingAt: 1_000_000_000 } })
		const result = run({
			entries: [entry(WHALE)],
			priorState,
			observations: [{ address: WHALE, balanceWei: 0n }],
		})
		expect(result.alerts).toEqual([])
		expect(result.decisions[0]?.kind).toBe('quiet')
	})
})

describe('helpers', () => {
	test('withTxHash fills the transaction in, or leaves the alert honest', () => {
		const priorState = stateWith({ [WHALE]: { balanceWei: 10_000n * ETH, lastOutgoingAt: 1_000_000_000 } })
		const [alert] = run({
			entries: [entry(WHALE)],
			priorState,
			observations: [{ address: WHALE, balanceWei: 0n }],
		}).alerts

		const hash = `0x${'ab'.repeat(32)}`
		expect(withTxHash(alert, hash).movement).toMatchObject({
			txHash: hash,
			txHashSource: 'rpc-block-scan',
		})
		expect(withTxHash(alert, null).movement).toMatchObject({
			txHash: null,
			txHashSource: 'unavailable',
		})
	})

	test('formatWeiAsEth keeps wei exact without floating point', () => {
		expect(formatWeiAsEth(0n)).toBe('0')
		expect(formatWeiAsEth(ETH)).toBe('1')
		expect(formatWeiAsEth(1_234_500_000_000_000_000n)).toBe('1.2345')
		expect(formatWeiAsEth(123_456_789n * ETH + 1n)).toBe('123456789')
	})
})
