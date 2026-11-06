/**
 * Sweep the staged devnet account: the event the canary is built to notice.
 *
 * It sends almost the whole balance to a fresh address in one transaction, which is
 * what someone who had just recovered the private key would do. On the devnet the
 * sweep is signed with the staged account's own key from .state/demo-account.json; no
 * key is broken and nothing here claims otherwise.
 *
 *   bun run demo/sweep.ts [--keep-eth 0.01] [--to 0x..] [--rpc URL]
 */

import { privateKeyToAccount } from 'viem/accounts'
import { getAddress, type Address, type Hex } from 'viem'
import {
	clients,
	DEFAULT_RPC_URL,
	formatEth,
	parseEthArg,
	readStateFile,
	sendAndWait,
	writeStateFile,
} from './devnet'

const args = process.argv.slice(2)
const flag = (name: string, fallback: string) => {
	const i = args.indexOf(name)
	return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

const rpcUrl = flag('--rpc', DEFAULT_RPC_URL)
const keepWei = parseEthArg(flag('--keep-eth', '0.01'))

type DemoAccount = { address: Address; privateKey: Hex; revealBlock: number; revealAt: number }

const randomAddress = (): Address => {
	const bytes = new Uint8Array(20)
	crypto.getRandomValues(bytes)
	return getAddress(`0x${Buffer.from(bytes).toString('hex')}`)
}

const main = async () => {
	const demo = readStateFile<DemoAccount>('.state/demo-account.json')
	const probe = clients(rpcUrl, 0)
	const chainId = await probe.publicClient.getChainId()
	const { publicClient: pub, walletClient: wallet } = clients(rpcUrl, chainId)

	const account = privateKeyToAccount(demo.privateKey)
	const balanceBefore = await pub.getBalance({ address: account.address })
	const head = await pub.getBlock()
	const dormantSeconds = Number(head.timestamp) - demo.revealAt
	console.log(
		`[sweep] staged account ${account.address} holds ${formatEth(balanceBefore)} ETH and has been quiet for ${dormantSeconds}s (since block ${demo.revealBlock})`,
	)

	const to = (flag('--to', '') as Address) || randomAddress()
	const fees = await pub.getGasPrice()
	const gasCost = fees * 2n * 210_000n
	const value = balanceBefore - keepWei - gasCost
	if (value <= 0n) throw new Error(`nothing to sweep: balance ${formatEth(balanceBefore)} ETH`)

	const sweep = await sendAndWait(pub, wallet, {
		account,
		to,
		value,
		gas: 210_000n, // the destination is a brand-new account on this devnet
	})
	const balanceAfter = await pub.getBalance({ address: account.address })
	console.log(
		`[sweep] moved ${formatEth(value)} ETH to ${to} in block ${sweep.receipt.blockNumber} (tx ${sweep.hash})`,
	)
	console.log(
		`[sweep] staged account left with ${formatEth(balanceAfter)} ETH: ${((Number(value) / Number(balanceBefore)) * 100).toFixed(2)}% of the balance gone after ${dormantSeconds}s of dormancy`,
	)

	const path = writeStateFile('.state/demo-sweep.json', {
		address: account.address,
		to,
		txHash: sweep.hash,
		block: Number(sweep.receipt.blockNumber),
		at: Number(sweep.block.timestamp),
		valueWei: value.toString(),
		balanceBeforeWei: balanceBefore.toString(),
		balanceAfterWei: balanceAfter.toString(),
		dormantSecondsAtSweep: dormantSeconds,
	})
	console.log(`[sweep] wrote ${path}`)
	console.log('[sweep] run the workflow simulation again: the canary should now raise an alert')
}

await main()
