/**
 * Shared helpers for the staged devnet demo.
 *
 * Reads the local devnet's funded keys from its own accounts file, by path. Keys are
 * used and never printed: nothing here logs a private key, and the demo account's key
 * is written to .state/ with mode 600 (and .state/ is gitignored).
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import {
	createPublicClient,
	createWalletClient,
	defineChain,
	http,
	type Address,
	type Hex,
	type PublicClient,
	type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

export const CANARY_ROOT = join(import.meta.dir, '..')
export const resolveFromRoot = (p: string) => (isAbsolute(p) ? p : join(CANARY_ROOT, p))

export const DEFAULT_RPC_URL = process.env.CANARY_RPC_URL ?? 'http://127.0.0.1:18545'
export const DEFAULT_ACCOUNTS_FILE =
	process.env.CANARY_DEVNET_ACCOUNTS ?? join(CANARY_ROOT, '..', 'devnet', 'data', 'keys', 'accounts.json')

export const devnetChain = (chainId: number, rpcUrl: string) =>
	defineChain({
		id: chainId,
		name: 'postcurve-devnet',
		nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
		rpcUrls: { default: { http: [rpcUrl] } },
	})

type DevnetAccount = { name: string; balanceEth: number; address: Address; privateKey: Hex }

/** Load one funded devnet account by name. The key stays in memory. */
export const loadDevnetAccount = (name: string, accountsFile = DEFAULT_ACCOUNTS_FILE) => {
	let raw: string
	try {
		raw = readFileSync(accountsFile, 'utf-8')
	} catch (error) {
		throw new Error(
			`cannot read the devnet accounts file at ${accountsFile}. Start the devnet first (devnet/devnet.sh up), or set CANARY_DEVNET_ACCOUNTS. (${error instanceof Error ? error.message : String(error)})`,
		)
	}
	const accounts = JSON.parse(raw) as DevnetAccount[]
	const account = accounts.find((a) => a.name === name)
	if (!account) {
		throw new Error(`no devnet account named "${name}" (have: ${accounts.map((a) => a.name).join(', ')})`)
	}
	return { address: account.address, signer: privateKeyToAccount(account.privateKey) }
}

export const clients = (rpcUrl: string, chainId: number) => {
	const chain = devnetChain(chainId, rpcUrl)
	const publicClient = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient
	const walletClient = createWalletClient({ chain, transport: http(rpcUrl) }) as WalletClient
	return { chain, publicClient, walletClient }
}

/**
 * Price transactions at about twice the current gas price: a young devnet starts with
 * a high base fee that decays slowly, and anything cheaper sits pending for minutes.
 */
export const feeFor = async (publicClient: PublicClient) => {
	const gasPrice = await publicClient.getGasPrice()
	const maxFeePerGas = gasPrice * 2n
	return { maxFeePerGas, maxPriorityFeePerGas: gasPrice / 10n + 1n }
}

export const sendAndWait = async (
	publicClient: PublicClient,
	walletClient: WalletClient,
	params: { account: ReturnType<typeof privateKeyToAccount>; to: Address; value: bigint; gas?: bigint },
) => {
	const fees = await feeFor(publicClient)
	const hash = await walletClient.sendTransaction({
		account: params.account,
		chain: walletClient.chain,
		to: params.to,
		value: params.value,
		gas: params.gas ?? 21000n,
		...fees,
	})
	const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
	const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber })
	return { hash, receipt, block }
}

export const writeStateFile = (relativePath: string, value: unknown, secret = false) => {
	const path = resolveFromRoot(relativePath)
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
	if (secret) chmodSync(path, 0o600)
	return path
}

export const readStateFile = <T>(relativePath: string): T => {
	const path = resolveFromRoot(relativePath)
	try {
		return JSON.parse(readFileSync(path, 'utf-8')) as T
	} catch (error) {
		throw new Error(
			`cannot read ${path}. Run demo/stage-dormant.ts first. (${error instanceof Error ? error.message : String(error)})`,
		)
	}
}

export const ETH = 10n ** 18n
export const parseEthArg = (eth: string): bigint => {
	const [whole, frac = ''] = eth.split('.')
	return BigInt(whole) * ETH + BigInt((frac + '0'.repeat(18)).slice(0, 18))
}
export const formatEth = (wei: bigint) => {
	const whole = wei / ETH
	const frac = (wei % ETH).toString().padStart(18, '0').replace(/0+$/, '')
	return `${whole}${frac ? `.${frac}` : ''}`
}
