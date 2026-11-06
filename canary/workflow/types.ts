/**
 * Shared types and JSON schemas for the postcurve canary.
 *
 * Three documents travel between the CRE workflow and the canary service:
 *
 *   watchlist  (postcurve.canary.watchlist/v1)  what to watch, and why it is exposed
 *   state      (postcurve.canary.state/v1)      what the canary saw last time
 *   alert      (postcurve.canary.alert/v1)      what it saw that it wants to shout about
 *
 * The alert document is the contract the "canary light" hardware reads, so it is
 * versioned and every field is a JSON primitive (numbers that fit a double, wei as
 * decimal strings). Nothing here depends on the CRE SDK: the service, the watchlist
 * builder and the tests import the same file as the workflow.
 */

import { z } from 'zod'

export const WATCHLIST_SCHEMA = 'postcurve.canary.watchlist/v1' as const
export const STATE_SCHEMA = 'postcurve.canary.state/v1' as const
export const ALERT_SCHEMA = 'postcurve.canary.alert/v1' as const

/** What a single alert claims, and what it does not. Repeated inside every alert. */
export const ALERT_CLAIM =
	'A large, long-dormant address whose public key is already on-chain moved a large share of its balance.'
export const ALERT_PROVES =
	'Nothing on its own. Owners wake up, custodians rebalance, and seeds get restored. Treat this as a prompt to look, not as evidence that elliptic-curve keys are being broken. A cluster of these across unrelated addresses in a short window is the signal worth acting on.'

const hexAddress = z
	.string()
	.regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 0x-prefixed 20-byte address')
const decimalString = z.string().regex(/^\d+$/, 'expected a decimal integer string')
const hexHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'expected a 0x-prefixed 32-byte hash')

/**
 * How the address revealed its public key. Sending a transaction is the only kind the
 * builder can prove from plain JSON-RPC today; the others exist because exposure also
 * happens through permits, EIP-7702 authorizations and contract-checked signatures, and
 * a later exposure scanner can fill them in without changing the schema.
 */
export const exposureKindSchema = z.enum([
	'transaction-sender',
	'eip7702-authorization',
	'offchain-signature',
	'unknown',
])

export const exposureSchema = z.object({
	/** How the key became visible. */
	kind: exposureKindSchema,
	/** The transaction that revealed it, when the evidence is a transaction. */
	evidenceTx: hexHash.optional(),
	/** Block of that transaction. */
	evidenceBlock: z.number().int().nonnegative().optional(),
	/** Unix seconds of that block. */
	evidenceAt: z.number().int().nonnegative().optional(),
	/** The nonce of that transaction. The account's nonce today is this plus one. */
	evidenceNonce: z.number().int().nonnegative().optional(),
	/** Free text: where this came from, e.g. "mainnet JSON-RPC block scan". */
	source: z.string(),
})

export const watchEntrySchema = z.object({
	address: hexAddress,
	label: z.string().optional(),
	exposure: exposureSchema,
	/**
	 * Seed for the dormancy clock: the last outgoing transaction the builder could
	 * prove. The workflow uses this only until it has recorded a state of its own.
	 */
	lastOutgoingBlock: z.number().int().nonnegative().optional(),
	lastOutgoingAt: z.number().int().nonnegative().optional(),
	/** Balance the builder saw, in wei. Informational: the workflow reads it again. */
	balanceWeiAtBuild: decimalString.optional(),
})

export const watchlistSchema = z.object({
	schema: z.literal(WATCHLIST_SCHEMA),
	chainId: z.number().int().positive(),
	/** Human label for the chain, e.g. "ethereum mainnet". */
	chainLabel: z.string(),
	/** Where the entries came from, in one line. Printed in the README and the alert. */
	source: z.string(),
	builtAt: z.number().int().nonnegative(),
	/** The exact command that produced this file, so anyone can reproduce it. */
	builtBy: z.string().optional(),
	entries: z.array(watchEntrySchema),
})

export const addressStateSchema = z.object({
	address: hexAddress,
	/** Balance in wei at `blockNumber`. */
	balanceWei: decimalString,
	blockNumber: z.number().int().nonnegative(),
	/** Block timestamp of `blockNumber`, unix seconds. */
	observedAt: z.number().int().nonnegative(),
	/** Last block in which the canary (or the builder) saw value leave this address. */
	lastOutgoingBlock: z.number().int().nonnegative(),
	lastOutgoingAt: z.number().int().nonnegative(),
	/**
	 * False when `lastOutgoing*` came from the watchlist seed rather than from an
	 * outgoing move the canary itself observed. An alert says which it used.
	 */
	dormancyObserved: z.boolean(),
})

export const canaryStateSchema = z.object({
	schema: z.literal(STATE_SCHEMA),
	chainId: z.number().int().positive(),
	/** Head block of the run that wrote this state. */
	blockNumber: z.number().int().nonnegative(),
	updatedAt: z.number().int().nonnegative(),
	/** Keyed by lowercase address. */
	addresses: z.record(addressStateSchema),
})

export const alertSchema = z.object({
	schema: z.literal(ALERT_SCHEMA),
	/** Deterministic, so re-running the same observation does not raise a new alert. */
	id: z.string(),
	severity: z.enum(['watch', 'alarm']),
	/** Chain time of the observation, unix seconds. */
	raisedAt: z.number().int().nonnegative(),
	chain: z.object({
		id: z.number().int().positive(),
		label: z.string(),
		/** The CRE chain-selector name the workflow read through. */
		creChainName: z.string(),
	}),
	address: hexAddress,
	label: z.string().optional(),
	exposure: exposureSchema,
	dormancy: z.object({
		seconds: z.number().int().nonnegative(),
		days: z.number().nonnegative(),
		lastOutgoingBlock: z.number().int().nonnegative(),
		lastOutgoingAt: z.number().int().nonnegative(),
		/** True when the canary saw the previous outgoing move itself. */
		observed: z.boolean(),
	}),
	movement: z.object({
		balanceBeforeWei: decimalString,
		balanceAfterWei: decimalString,
		movedWei: decimalString,
		movedEth: z.string(),
		/** movedWei / balanceBeforeWei, 0..1, rounded to 6 decimals. */
		movedFraction: z.number(),
		baselineBlock: z.number().int().nonnegative(),
		observedBlock: z.number().int().nonnegative(),
		/** The transaction that moved the value, when a locator found it. */
		txHash: hexHash.nullable(),
		txHashSource: z.enum(['rpc-block-scan', 'unavailable']),
	}),
	/** The thresholds this alert cleared, so a reader can judge it without the config. */
	thresholds: z.object({
		minDormancySeconds: z.number().int().nonnegative(),
		minMovedFraction: z.number(),
		minMovedWei: decimalString,
		minBalanceWei: decimalString,
	}),
	/** How many addresses alerted in the same run, and how many were checked. */
	cluster: z.object({
		alertsThisRun: z.number().int().positive(),
		addressesChecked: z.number().int().nonnegative(),
	}),
	run: z.object({
		workflow: z.string(),
		/** "cre-cli-simulation" or "cre-don". Set in the workflow config, never guessed. */
		mode: z.string(),
		watchlistSource: z.string(),
	}),
	claim: z.string(),
	proves: z.string(),
})

export type ExposureKind = z.infer<typeof exposureKindSchema>
export type Exposure = z.infer<typeof exposureSchema>
export type WatchEntry = z.infer<typeof watchEntrySchema>
export type Watchlist = z.infer<typeof watchlistSchema>
export type AddressState = z.infer<typeof addressStateSchema>
export type CanaryState = z.infer<typeof canaryStateSchema>
export type Alert = z.infer<typeof alertSchema>

export const emptyState = (chainId: number, blockNumber = 0, updatedAt = 0): CanaryState => ({
	schema: STATE_SCHEMA,
	chainId,
	blockNumber,
	updatedAt,
	addresses: {},
})

/** Wei as a fixed-point ETH string, e.g. 1234500000000000000n -> "1.2345". */
export const formatWeiAsEth = (wei: bigint, maxDecimals = 6): string => {
	const negative = wei < 0n
	const abs = negative ? -wei : wei
	const whole = abs / 10n ** 18n
	const frac = (abs % 10n ** 18n).toString().padStart(18, '0').slice(0, maxDecimals).replace(/0+$/, '')
	return `${negative ? '-' : ''}${whole.toString()}${frac ? `.${frac}` : ''}`
}
