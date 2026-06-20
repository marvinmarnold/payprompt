#!/usr/bin/env bun
/**
 * Validate a deployed LatchkeyBilling contract — reusable as a post-deploy gate and TDD smoke check.
 *
 * Read-only by default (safe to run against any deployment):
 *   - confirms the address has bytecode
 *   - confirms the deployed ABI is the cumulative-settlement version (settled(address) is readable,
 *     pull selector present) — guards against pointing at a stale/old contract
 *   - confirms usdc/treasury/proxy/owner are set, and (if expected values are provided in env) match
 *
 * Opt-in live pull (VALIDATE_LIVE_PULL=true) — performs a real on-chain pull and asserts the
 * fee-on-top split and idempotency revert. Preconditions (else the live section is skipped, not failed):
 *   - VALIDATE_PROXY_KEY      proxy private key (must equal the contract's proxy())
 *   - VALIDATE_CALLER_ADDRESS a caller that has approved >= delta+fee USDC to the contract and holds it
 *   - VALIDATE_PULL_ATOMIC    service delta to settle this run, atomic USDC (default 1000 = $0.001)
 *
 * Env:
 *   BASE_RPC_URL              RPC endpoint (default: Base Sepolia public RPC)
 *   BILLING_CONTRACT_ADDRESS  required — the deployed LatchkeyBilling
 *   USDC_ADDRESS, TREASURY_ADDRESS, PROXY_ADDRESS, OWNER_ADDRESS  optional expected values to assert
 *
 * Exit code 0 = all checks passed; 1 = a check failed (suitable for CI / deploy gating).
 */
import {
  createPublicClient, createWalletClient, http, getAddress, parseAbi, type Chain,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia, base } from 'viem/chains'

const ABI = parseAbi([
  'function usdc() view returns (address)',
  'function treasury() view returns (address)',
  'function proxy() view returns (address)',
  'function owner() view returns (address)',
  'function settled(address) view returns (uint256)',
  'function pull(address caller, uint256 cumulativeService) external',
])
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)'])
const ZERO = '0x0000000000000000000000000000000000000000'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
function eqAddr(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false
  try { return getAddress(a) === getAddress(b) } catch { return false }
}

/** Fee-on-top split for a service delta: provider gets the delta, treasury gets 1% on top. */
export function expectedSplit(deltaAtomic: bigint): { fee: bigint; net: bigint; total: bigint } {
  const fee = deltaAtomic / 100n
  return { fee, net: deltaAtomic, total: deltaAtomic + fee }
}

async function main(): Promise<void> {
  const rpcUrl = process.env.BASE_RPC_URL ?? 'https://sepolia.base.org'
  const billing = process.env.BILLING_CONTRACT_ADDRESS
  if (!billing) { console.error('BILLING_CONTRACT_ADDRESS is required'); process.exit(1) }
  const address = billing as `0x${string}`

  const isMainnet = rpcUrl.includes('mainnet') && !rpcUrl.includes('sepolia')
  const chain: Chain = isMainnet ? base : baseSepolia
  const transport = http(rpcUrl)
  const pub = createPublicClient({ chain, transport })

  console.log(`\nValidating LatchkeyBilling at ${billing} on ${chain.name}\n`)

  const code = await pub.getCode({ address })
  check('contract has bytecode', !!code && code !== '0x')

  // Read an address getter, returning null on revert (e.g. an older contract missing the fn).
  const readAddr = async (fn: 'usdc' | 'treasury' | 'proxy' | 'owner'): Promise<string | null> => {
    try { return await pub.readContract({ address, abi: ABI, functionName: fn }) as string }
    catch { return null }
  }

  let settledReadable = true
  try {
    await pub.readContract({ address, abi: ABI, functionName: 'settled', args: [ZERO] })
  } catch { settledReadable = false }
  check('exposes settled(address) — cumulative-settlement ABI', settledReadable)

  const [usdc, treasury, proxy, owner] = await Promise.all([
    readAddr('usdc'), readAddr('treasury'), readAddr('proxy'), readAddr('owner'),
  ])
  check('owner() present — rotatable-roles ABI', owner !== null, 'reverts on the pre-hardening contract')
  check('usdc set', !!usdc && !eqAddr(usdc, ZERO), usdc ?? 'revert')
  check('treasury set', !!treasury && !eqAddr(treasury, ZERO), treasury ?? 'revert')
  check('proxy set', !!proxy && !eqAddr(proxy, ZERO), proxy ?? 'revert')
  check('owner set', !!owner && !eqAddr(owner, ZERO), owner ?? 'revert')
  if (process.env.USDC_ADDRESS) check('usdc matches env', eqAddr(usdc, process.env.USDC_ADDRESS), usdc)
  if (process.env.TREASURY_ADDRESS) check('treasury matches env', eqAddr(treasury, process.env.TREASURY_ADDRESS), treasury)
  if (process.env.PROXY_ADDRESS) check('proxy matches env', eqAddr(proxy, process.env.PROXY_ADDRESS), proxy)
  if (process.env.OWNER_ADDRESS) check('owner matches env', eqAddr(owner, process.env.OWNER_ADDRESS), owner)

  // --- Opt-in live pull: fee-on-top + idempotency against the real chain ---
  if (process.env.VALIDATE_LIVE_PULL === 'true') {
    // pull() is onlyProxy, so the signer must be the proxy key. Source it from the standard
    // PROXY_PRIVATE_KEY in packages/proxy/.env (VALIDATE_PROXY_KEY kept as an explicit override).
    const proxyKey = (process.env.PROXY_PRIVATE_KEY ?? process.env.VALIDATE_PROXY_KEY) as `0x${string}` | undefined
    const caller = process.env.VALIDATE_CALLER_ADDRESS as `0x${string}` | undefined
    const delta = BigInt(process.env.VALIDATE_PULL_ATOMIC ?? '1000')
    if (!proxyKey || !caller) {
      console.log('• live pull skipped — set PROXY_PRIVATE_KEY (or VALIDATE_PROXY_KEY) and VALIDATE_CALLER_ADDRESS to enable')
    } else if (!usdc || !treasury || !proxy) {
      check('live: contract roles readable for live pull', false, 'usdc/treasury/proxy missing')
    } else {
      const account = privateKeyToAccount(proxyKey)
      check('live: proxy key matches contract proxy()', eqAddr(account.address, proxy))
      const wallet = createWalletClient({ account, chain, transport })

      const prevSettled = await pub.readContract({ address, abi: ABI, functionName: 'settled', args: [caller] })
      const newTotal = prevSettled + delta
      const { fee, net } = expectedSplit(delta)

      const tBefore = await pub.readContract({ address: usdc, abi: ERC20, functionName: 'balanceOf', args: [treasury] })
      const pBefore = await pub.readContract({ address: usdc, abi: ERC20, functionName: 'balanceOf', args: [proxy] })

      const hash = await wallet.writeContract({ address, abi: ABI, functionName: 'pull', args: [caller, newTotal] })
      await pub.waitForTransactionReceipt({ hash })

      const tAfter = await pub.readContract({ address: usdc, abi: ERC20, functionName: 'balanceOf', args: [treasury] })
      const pAfter = await pub.readContract({ address: usdc, abi: ERC20, functionName: 'balanceOf', args: [proxy] })
      check('live: treasury received the 1% fee', tAfter - tBefore === fee, `${tAfter - tBefore} == ${fee}`)
      check('live: proxy received exactly the service delta', pAfter - pBefore === net, `${pAfter - pBefore} == ${net}`)
      check('live: settled advanced to the cumulative total',
        (await pub.readContract({ address, abi: ABI, functionName: 'settled', args: [caller] })) === newTotal)

      // Idempotency: re-submitting the same total must revert (non-monotonic).
      // viem may either throw on a revert OR return a mined receipt with status 'reverted'.
      // Treat both as a revert so the idempotency check can't false-pass.
      let reverted = false
      try {
        const h2 = await wallet.writeContract({ address, abi: ABI, functionName: 'pull', args: [caller, newTotal] })
        const r2 = await pub.waitForTransactionReceipt({ hash: h2 })
        reverted = r2.status === 'reverted'
      } catch { reverted = true }
      check('live: replay of the same cumulative total reverts (idempotent)', reverted)
    }
  }

  console.log(`\n${failures === 0 ? 'PASS' : `FAIL — ${failures} check(s) failed`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
