import {
  createWalletClient, createPublicClient, http, keccak256,
  encodeFunctionData, parseAbi, type Chain,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia, base } from 'viem/chains'
import type { PullChain } from './puller'

const BILLING_ABI = parseAbi([
  'function pull(address caller, uint256 cumulativeService) external',
])

export interface PullChainConfig {
  billingContract: `0x${string}`
  proxyPrivateKey: `0x${string}`
  rpcUrl: string
}

/**
 * Real viem-backed implementation of the PullChain seam.
 *
 * The crash-safety contract requires a deterministic hash known *before*
 * broadcast: we sign the tx locally (signTransaction → serialized raw tx),
 * derive its hash as keccak256(raw), persist both, then broadcast the raw tx.
 * Re-broadcasting the identical raw tx later is a no-op (same hash on-chain).
 */
export function makePullChain(cfg: PullChainConfig): PullChain {
  const account = privateKeyToAccount(cfg.proxyPrivateKey)
  const isMainnet = cfg.rpcUrl.includes('mainnet') && !cfg.rpcUrl.includes('sepolia')
  const chain: Chain = isMainnet ? base : baseSepolia
  const transport = http(cfg.rpcUrl)
  const wallet = createWalletClient({ account, chain, transport })
  const pub = createPublicClient({ chain, transport })

  return {
    async signPull(caller, cumulativeServiceAtomic) {
      const data = encodeFunctionData({
        abi: BILLING_ABI,
        functionName: 'pull',
        args: [caller as `0x${string}`, cumulativeServiceAtomic],
      })
      // prepareTransactionRequest fills nonce, gas, and fee fields from the chain.
      const request = await wallet.prepareTransactionRequest({
        to: cfg.billingContract,
        data,
      })
      const raw = await wallet.signTransaction(request)
      return { hash: keccak256(raw), raw }
    },

    async broadcastRaw(raw) {
      try {
        await pub.sendRawTransaction({ serializedTransaction: raw as `0x${string}` })
      } catch (e) {
        // Idempotent re-broadcast: an already-known/already-mined tx is not an error here.
        const msg = (e as Error).message.toLowerCase()
        if (msg.includes('already known') || msg.includes('nonce too low') || msg.includes('already imported')) return
        throw e
      }
    },

    async getReceipt(hash) {
      try {
        const r = await pub.getTransactionReceipt({ hash: hash as `0x${string}` })
        return { status: r.status === 'success' ? 'success' : 'reverted' }
      } catch {
        return null // not yet mined / unknown
      }
    },

    async waitForReceipt(hash) {
      const r = await pub.waitForTransactionReceipt({ hash: hash as `0x${string}` })
      return { status: r.status === 'success' ? 'success' : 'reverted' }
    },
  }
}
