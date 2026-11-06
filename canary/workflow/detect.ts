/**
 * The canary's detection logic, with no I/O in it.
 *
 * Everything that decides whether to shout lives here so it can be tested without a
 * chain, a node or a network: the workflow hands it what it read, this returns the
 * alerts to send and the state to store.
 *
 * Rules, in the order they matter:
 *
 *  1. A balance the canary could not read is not evidence of anything. The address
 *     keeps its previous state and the run reports `read-failed`. Never an alert.
 *  2. With no prior state for an address, the run records a baseline and stays quiet.
 *     A first run can't know whether a balance is new or old.
 *  3. Only outgoing value counts as activity for the dormancy clock. Receiving ETH
 *     needs no signature from the holder, so being paid does not make an address
 *     "awake" and does not reset dormancy.
 *  4. An outgoing move alerts only if all of these hold: the address was worth at
 *     least `minBalanceWei`, it had been dormant for at least `minDormancySeconds`,
 *     and the move was at least `minMovedFraction` of the balance and at least
 *     `minMovedWei`.
 *  5. Severity is `alarm` when the move took almost everything, or when two or more
 *     addresses alert in the same run. Unrelated addresses sweeping together is the
 *     pattern that would actually suggest someone is breaking keys.
 */

import {
	ALERT_CLAIM,
	ALERT_PROVES,
	ALERT_SCHEMA,
	formatWeiAsEth,
	STATE_SCHEMA,
	type AddressState,
	type Alert,
	type CanaryState,
	type WatchEntry,
} from './types'

export type Thresholds = {
	/** How long an address must have been quiet before a move is interesting. */
	minDormancySeconds: number
	/** Share of the balance that must leave, 0..1. */
	minMovedFraction: number
	/** Absolute floor on the amount moved, in wei. */
	minMovedWei: bigint
	/** Addresses worth less than this are watched but never alert. */
	minBalanceWei: bigint
}

export type ChainInfo = {
	id: number
	label: string
	creChainName: string
}

export type RunInfo = {
	workflow: string
	/** "cre-cli-simulation" or "cre-don". Comes from config; never inferred. */
	mode: string
	watchlistSource: string
}

/** One balance read. `balanceWei` absent means the read failed. */
export type Observation = {
	address: string
	balanceWei?: bigint
	error?: string
}

export type DecisionKind =
	| 'alert'
	| 'baseline'
	| 'quiet'
	| 'funded'
	| 'move-below-threshold'
	| 'read-failed'

export type Decision = {
	address: string
	kind: DecisionKind
	detail: string
}

export type EvaluateInput = {
	entries: WatchEntry[]
	/** Last state the canary stored, or null on the very first run. */
	priorState: CanaryState | null
	observations: Observation[]
	/** Head block the balances were read at. */
	observedBlock: number
	/** Timestamp of that block, unix seconds. Chain time, not wall-clock time. */
	observedAt: number
	thresholds: Thresholds
	chain: ChainInfo
	run: RunInfo
}

export type EvaluateResult = {
	/** Alerts to send. `movement.txHash` is null until a locator fills it in. */
	alerts: Alert[]
	/** State to store if, and only if, the alerts were delivered. */
	nextState: CanaryState
	decisions: Decision[]
}

const key = (address: string) => address.toLowerCase()

const round = (n: number, decimals: number) => {
	const f = 10 ** decimals
	return Math.round(n * f) / f
}

/** movedWei / balanceBeforeWei as a double, without losing precision to bigint->number. */
const fractionOf = (part: bigint, whole: bigint): number => {
	if (whole <= 0n) return 0
	// scale to 1e9 in bigint space first, so huge balances stay exact enough
	return round(Number((part * 1_000_000_000n) / whole) / 1_000_000_000, 6)
}

const alertId = (chainId: number, address: string, baselineBlock: number, observedBlock: number) =>
	`${chainId}:${key(address)}:${baselineBlock}-${observedBlock}`

/**
 * Decide what the canary saw. Pure: same inputs, same alerts and same state.
 */
export const evaluate = (input: EvaluateInput): EvaluateResult => {
	const { entries, priorState, thresholds, chain, run, observedBlock, observedAt } = input

	const observations = new Map(input.observations.map((o) => [key(o.address), o]))
	const prior = new Map<string, AddressState>(
		Object.entries(priorState?.addresses ?? {}).map(([k, v]) => [key(k), v]),
	)

	const decisions: Decision[] = []
	const addresses: Record<string, AddressState> = {}
	const seen = new Set<string>()
	type Pending = {
		entry: WatchEntry
		before: bigint
		after: bigint
		moved: bigint
		movedFraction: number
		dormancySeconds: number
		priorState: AddressState
	}
	const pending: Pending[] = []

	for (const entry of entries) {
		const k = key(entry.address)
		// A watchlist that lists an address twice must not alert twice for one move.
		if (seen.has(k)) continue
		seen.add(k)
		const observation = observations.get(k)
		const previous = prior.get(k)

		if (!observation || observation.balanceWei === undefined) {
			// Rule 1: a failed read is not evidence. Carry the old state forward.
			if (previous) addresses[k] = previous
			decisions.push({
				address: entry.address,
				kind: 'read-failed',
				detail: observation?.error ?? 'no balance returned for this address',
			})
			continue
		}

		const balance = observation.balanceWei

		if (!previous) {
			// Rule 2: first sighting. Record, stay quiet.
			const seededBlock = entry.lastOutgoingBlock
			const seededAt = entry.lastOutgoingAt
			addresses[k] = {
				address: entry.address,
				balanceWei: balance.toString(),
				blockNumber: observedBlock,
				observedAt,
				lastOutgoingBlock: seededBlock ?? observedBlock,
				lastOutgoingAt: seededAt ?? observedAt,
				dormancyObserved: false,
			}
			decisions.push({
				address: entry.address,
				kind: 'baseline',
				detail:
					seededAt === undefined
						? `baseline ${formatWeiAsEth(balance)} ETH at block ${observedBlock}; dormancy clock starts now (watchlist carried no seed)`
						: `baseline ${formatWeiAsEth(balance)} ETH at block ${observedBlock}; dormant since block ${seededBlock} per watchlist seed`,
			})
			continue
		}

		const before = BigInt(previous.balanceWei)

		if (balance > before) {
			// Rule 3: incoming value is not the holder signing anything.
			addresses[k] = {
				...previous,
				address: entry.address,
				balanceWei: balance.toString(),
				blockNumber: observedBlock,
				observedAt,
			}
			decisions.push({
				address: entry.address,
				kind: 'funded',
				detail: `received ${formatWeiAsEth(balance - before)} ETH; dormancy clock untouched`,
			})
			continue
		}

		if (balance === before) {
			addresses[k] = {
				...previous,
				address: entry.address,
				blockNumber: observedBlock,
				observedAt,
			}
			decisions.push({
				address: entry.address,
				kind: 'quiet',
				detail: `unchanged at ${formatWeiAsEth(balance)} ETH`,
			})
			continue
		}

		// Value left the address: that is a signature, so the dormancy clock restarts here.
		const moved = before - balance
		const movedFraction = fractionOf(moved, before)
		const dormancySeconds = Math.max(0, observedAt - previous.lastOutgoingAt)

		addresses[k] = {
			address: entry.address,
			balanceWei: balance.toString(),
			blockNumber: observedBlock,
			observedAt,
			lastOutgoingBlock: observedBlock,
			lastOutgoingAt: observedAt,
			dormancyObserved: true,
		}

		const failed: string[] = []
		if (before < thresholds.minBalanceWei)
			failed.push(
				`balance ${formatWeiAsEth(before)} ETH below minimum ${formatWeiAsEth(thresholds.minBalanceWei)} ETH`,
			)
		if (dormancySeconds < thresholds.minDormancySeconds)
			failed.push(
				`dormant ${dormancySeconds}s, needs ${thresholds.minDormancySeconds}s`,
			)
		if (movedFraction < thresholds.minMovedFraction)
			failed.push(
				`moved ${(movedFraction * 100).toFixed(2)}% of the balance, needs ${(thresholds.minMovedFraction * 100).toFixed(2)}%`,
			)
		if (moved < thresholds.minMovedWei)
			failed.push(
				`moved ${formatWeiAsEth(moved)} ETH, needs ${formatWeiAsEth(thresholds.minMovedWei)} ETH`,
			)

		if (failed.length > 0) {
			decisions.push({
				address: entry.address,
				kind: 'move-below-threshold',
				detail: `outgoing ${formatWeiAsEth(moved)} ETH, no alert: ${failed.join('; ')}`,
			})
			continue
		}

		pending.push({
			entry,
			before,
			after: balance,
			moved,
			movedFraction,
			dormancySeconds,
			priorState: previous,
		})
	}

	const addressesChecked = seen.size
	const alerts: Alert[] = pending.map((p) => {
		const severity: Alert['severity'] =
			pending.length > 1 || p.movedFraction >= 0.9 ? 'alarm' : 'watch'
		return {
			schema: ALERT_SCHEMA,
			id: alertId(chain.id, p.entry.address, p.priorState.blockNumber, observedBlock),
			severity,
			raisedAt: observedAt,
			chain: { id: chain.id, label: chain.label, creChainName: chain.creChainName },
			address: p.entry.address,
			label: p.entry.label,
			exposure: p.entry.exposure,
			dormancy: {
				seconds: p.dormancySeconds,
				days: round(p.dormancySeconds / 86400, 3),
				lastOutgoingBlock: p.priorState.lastOutgoingBlock,
				lastOutgoingAt: p.priorState.lastOutgoingAt,
				observed: p.priorState.dormancyObserved,
			},
			movement: {
				balanceBeforeWei: p.before.toString(),
				balanceAfterWei: p.after.toString(),
				movedWei: p.moved.toString(),
				movedEth: formatWeiAsEth(p.moved),
				movedFraction: p.movedFraction,
				baselineBlock: p.priorState.blockNumber,
				observedBlock,
				txHash: null,
				txHashSource: 'unavailable',
			},
			thresholds: {
				minDormancySeconds: thresholds.minDormancySeconds,
				minMovedFraction: thresholds.minMovedFraction,
				minMovedWei: thresholds.minMovedWei.toString(),
				minBalanceWei: thresholds.minBalanceWei.toString(),
			},
			cluster: { alertsThisRun: pending.length, addressesChecked },
			run: { workflow: run.workflow, mode: run.mode, watchlistSource: run.watchlistSource },
			claim: ALERT_CLAIM,
			proves: ALERT_PROVES,
		}
	})

	for (const alert of alerts) {
		decisions.push({
			address: alert.address,
			kind: 'alert',
			detail: `${alert.severity}: moved ${alert.movement.movedEth} ETH (${(alert.movement.movedFraction * 100).toFixed(2)}% of balance) after ${alert.dormancy.days} days dormant`,
		})
	}

	return {
		alerts,
		nextState: {
			schema: STATE_SCHEMA,
			chainId: chain.id,
			blockNumber: observedBlock,
			updatedAt: observedAt,
			addresses,
		},
		decisions,
	}
}

/** Attach a located transaction hash to the alert for `address`, if one was found. */
export const withTxHash = (alert: Alert, txHash: string | null): Alert =>
	txHash
		? { ...alert, movement: { ...alert.movement, txHash, txHashSource: 'rpc-block-scan' } }
		: alert
