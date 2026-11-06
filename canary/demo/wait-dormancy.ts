/**
 * Wait until the staged account has been quiet for long enough that a sweep would
 * clear the devnet config's dormancy threshold. Chain time, not wall-clock time: the
 * canary measures dormancy in block timestamps, so this waits for blocks.
 *
 *   bun run demo/wait-dormancy.ts [--seconds 120] [--rpc URL]
 */

import { clients, DEFAULT_RPC_URL, readStateFile } from './devnet'

const args = process.argv.slice(2)
const flag = (name: string, fallback: string) => {
	const i = args.indexOf(name)
	return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

const rpcUrl = flag('--rpc', DEFAULT_RPC_URL)
const needed = Number(flag('--seconds', '120'))
const margin = Number(flag('--margin', '12'))

const demo = readStateFile<{ revealAt: number; revealBlock: number }>('.state/demo-account.json')
const probe = clients(rpcUrl, 0)
const chainId = await probe.publicClient.getChainId()
const { publicClient } = clients(rpcUrl, chainId)

const target = demo.revealAt + needed + margin
console.log(
	`[wait] staged account went quiet at ${demo.revealAt} (block ${demo.revealBlock}); waiting for chain time ${target} (${needed}s + ${margin}s margin)`,
)

for (;;) {
	const head = await publicClient.getBlock()
	const now = Number(head.timestamp)
	const remaining = target - now
	if (remaining <= 0) {
		console.log(`[wait] chain time ${now} at block ${head.number}: dormant ${now - demo.revealAt}s, enough`)
		break
	}
	console.log(`[wait] chain time ${now} at block ${head.number}: ${remaining}s to go`)
	await new Promise((r) => setTimeout(r, Math.min(remaining, 6) * 1000))
}
