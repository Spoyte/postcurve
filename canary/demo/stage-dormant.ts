/**
 * Stage a "large, dormant, exposed" address on the local devnet.
 *
 * Three steps, all real transactions on the devnet:
 *
 *   1. generate a fresh account (its key is written to .state/, mode 600, gitignored)
 *   2. fund it from the devnet's `dev` account
 *   3. have it send one small transaction back
 *
 * Step 3 is the point: signing that transaction puts the account's public key on the
 * chain forever. From then on the account is exactly what the canary watches, an
 * address holding real value whose key is no longer hidden behind a hash. It then sits
 * still, and `demo/sweep.ts` later empties it.
 *
 *   bun run demo/stage-dormant.ts [--fund-eth 500] [--reveal-eth 1] [--rpc URL]
 */

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
	clients,
	DEFAULT_RPC_URL,
	formatEth,
	loadDevnetAccount,
	parseEthArg,
	sendAndWait,
	writeStateFile,
} from './devnet'

const args = process.argv.slice(2)
const flag = (name: string, fallback: string) => {
	const i = args.indexOf(name)
	return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

const rpcUrl = flag('--rpc', DEFAULT_RPC_URL)
const fundWei = parseEthArg(flag('--fund-eth', '500'))
const revealWei = parseEthArg(flag('--reveal-eth', '1'))
const funderName = flag('--funder', 'dev')

const main = async () => {
	const { publicClient, walletClient } = clients(rpcUrl, 0)
	const chainId = await publicClient.getChainId()
	const { publicClient: pub, walletClient: wallet } = clients(rpcUrl, chainId)

	const funder = loadDevnetAccount(funderName)
	const funderBalance = await pub.getBalance({ address: funder.address })
	console.log(`[stage] chain ${chainId}, funder ${funderName} ${funder.address} holds ${formatEth(funderBalance)} ETH`)
	if (funderBalance < fundWei * 2n) {
		throw new Error(`funder ${funderName} holds ${formatEth(funderBalance)} ETH, not enough to send ${formatEth(fundWei)} ETH`)
	}

	// 1. a brand new account, key never printed
	const privateKey = generatePrivateKey()
	const staged = privateKeyToAccount(privateKey)
	console.log(`[stage] staged account ${staged.address} (new key, nothing on chain yet)`)

	// 2. fund it
	const funding = await sendAndWait(pub, wallet, {
		account: funder.signer,
		to: staged.address,
		value: fundWei,
		gas: 210_000n, // a transfer into a brand-new account needs state gas on this devnet
	})
	console.log(
		`[stage] funded with ${formatEth(fundWei)} ETH in block ${funding.receipt.blockNumber} (tx ${funding.hash})`,
	)

	// 3. the account signs once: its public key is now on the chain
	const reveal = await sendAndWait(pub, wallet, {
		account: staged,
		to: funder.address,
		value: revealWei,
	})
	const revealBlock = Number(reveal.receipt.blockNumber)
	const revealAt = Number(reveal.block.timestamp)
	console.log(
		`[stage] key revealed: the staged account sent ${formatEth(revealWei)} ETH back in block ${revealBlock} (tx ${reveal.hash})`,
	)

	const balance = await pub.getBalance({ address: staged.address })
	const nonce = await pub.getTransactionCount({ address: staged.address })
	console.log(
		`[stage] staged account now holds ${formatEth(balance)} ETH, nonce ${nonce}: large, exposed, and about to go quiet`,
	)

	const keyPath = writeStateFile(
		'.state/demo-account.json',
		{
			note: 'Devnet-only throwaway key for the canary demo. Worthless outside this devnet. Never reuse.',
			address: staged.address,
			privateKey,
			chainId,
			fundedTx: funding.hash,
			revealTx: reveal.hash,
			revealBlock,
			revealAt,
			balanceWeiAfterReveal: balance.toString(),
			nonceAfterReveal: nonce,
		},
		true,
	)
	const labelPath = writeStateFile('.state/demo-labels.json', {
		[staged.address]: 'staged devnet account: funded, signed once, then left alone',
	})

	console.log(`[stage] wrote ${keyPath} (mode 600) and ${labelPath}`)
	console.log(
		`[stage] dormancy clock starts at ${revealAt} (block ${revealBlock}); the devnet config alerts after 120s of quiet`,
	)
}

await main()
