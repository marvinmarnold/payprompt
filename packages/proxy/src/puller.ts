import { keccak256 } from 'viem'
import type { Database } from 'bun:sqlite'
import type { WalletState } from './wallet'
import { DEFAULT_PULL_THRESHOLD_USD, PULL_SCALE } from './config'

/**
 * Chain seam for the pull worker. Kept tiny and injectable so the whole
 * settlement state machine is testable with no network — the real
 * implementation (viem) lives in makePullChain() below.
 */
export interface PullChain {
  /** Sign a pull(caller, cumulativeServiceAtomic) tx locally → deterministic hash + raw signed tx. No broadcast. */
  signPull(caller: string, cumulativeServiceAtomic: bigint): Promise<{ hash: string; raw: string }>
  /** Broadcast a raw signed tx. Idempotent: re-broadcasting the same tx is a no-op on-chain. */
  broadcastRaw(raw: string): Promise<void>
  /** Receipt for a hash, or null if not yet mined / never landed. */
  getReceipt(hash: string): Promise<{ status: 'success' | 'reverted' } | null>
  /** Wait for a hash to be mined and return its receipt. */
  waitForReceipt(hash: string): Promise<{ status: 'success' | 'reverted' }>
}

export interface PullOpts {
  thresholdUsd?: number // accrued debt that triggers a pull (default DEFAULT_PULL_THRESHOLD_USD)
  scale?: number        // token atomic units per dollar (default 1e6 = USDC 6 decimals)
  maxFailures?: number  // consecutive failures before blocking (default 3)
}

const now = () => Math.floor(Date.now() / 1000)

/**
 * Add two atomic USDC amounts, guarding against silent JS precision loss past 2^53.
 * settled_atomic is a JS number until it is converted to BigInt for signing; once a
 * wallet's cumulative total would exceed Number.MAX_SAFE_INTEGER, plain addition would
 * truncate and desync the off-chain mirror from the on-chain checkpoint. Throw instead.
 */
export function addAtomic(a: number, b: number): number {
  const sum = a + b
  if (!Number.isSafeInteger(sum)) {
    throw new Error(`atomic overflow: ${a} + ${b} exceeds Number.MAX_SAFE_INTEGER`)
  }
  return sum
}

function settle(
  db: Database,
  address: string,
  amountUsd: number,
  newSettledAtomic: number,
  txHash?: string,
): void {
  // Deduct the SNAPSHOT (not zero) so debt accrued during the pull window survives.
  // Advance settled_atomic to the cumulative total just settled on-chain, keeping the
  // off-chain mirror in lock-step with the contract's settled[caller] checkpoint.
  db.run(
    `UPDATE wallet_state SET
       accrued_usd = accrued_usd - ?,
       total_pulled_usd = total_pulled_usd + ?,
       pull_failure_count = 0,
       pending_pull_usd = NULL, pending_pull_tx = NULL, pending_pull_raw = NULL,
       settled_atomic = ?,
       last_pull_at = ?,
       last_pull_tx = COALESCE(?, last_pull_tx)
     WHERE address = ?`,
    [amountUsd, amountUsd, newSettledAtomic, now(), txHash ?? null, address],
  )
}

function fail(db: Database, address: string, maxFailures: number): void {
  db.run(
    `UPDATE wallet_state SET
       pull_failure_count = pull_failure_count + 1,
       pending_pull_usd = NULL, pending_pull_tx = NULL, pending_pull_raw = NULL,
       blocked = CASE WHEN pull_failure_count + 1 >= ? THEN 1 ELSE 0 END
     WHERE address = ?`,
    [maxFailures, address],
  )
}

/**
 * One sweep of the pull queue. Safe to run on an interval.
 * Step 1 reconciles any in-flight pull (crash recovery); step 2 starts new pulls.
 *
 * NOTE: this worker only handles EVM wallets via the provided PullChain (viem/Base).
 * Solana wallets accrue debt in wallet_state just like EVM wallets, but there is no
 * Solana PullChain implementation yet — their accrued_usd is never settled on-chain.
 * When Solana billing is wired, a separate Solana PullChain must be registered here.
 */
export async function processPulls(db: Database, chain: PullChain, opts: PullOpts = {}): Promise<void> {
  const thresholdUsd = opts.thresholdUsd ?? DEFAULT_PULL_THRESHOLD_USD
  const scale = opts.scale ?? PULL_SCALE
  const maxFailures = opts.maxFailures ?? 3

  // 1. Reconcile in-flight pulls FIRST (selected by pending_pull_usd, set before broadcast).
  const inflight = db
    .query<WalletState, []>(`SELECT * FROM wallet_state WHERE pending_pull_usd IS NOT NULL`)
    .all()
  const reconciled = new Set<string>()
  for (const w of inflight) {
    reconciled.add(w.address)
    // pending_pull_tx is always set alongside pending_pull_usd (same atomic write in step 2).
    // Derive it from raw as a fallback if the invariant somehow breaks.
    const hash = w.pending_pull_tx ?? (w.pending_pull_raw ? keccak256(w.pending_pull_raw as `0x${string}`) : null)
    let receipt = hash ? await chain.getReceipt(hash) : null
    if (!receipt) {
      // Never landed (crash before/at broadcast) → re-broadcast the saved raw tx.
      // Same nonce + payload = same hash, so this can't double-charge.
      if (w.pending_pull_raw) await chain.broadcastRaw(w.pending_pull_raw)
      receipt = hash ? await chain.waitForReceipt(hash) : { status: 'reverted' as const }
    }
    if (receipt.status === 'success') {
      // The signed tx encoded cumulative = settled_atomic + delta; settled_atomic is unchanged
      // until success, so recomputing the delta from the frozen snapshot reproduces that total.
      const deltaAtomic = Math.round((w.pending_pull_usd ?? 0) * scale)
      settle(db, w.address, w.pending_pull_usd ?? 0, addAtomic(w.settled_atomic, deltaAtomic), hash ?? undefined)
    } else fail(db, w.address, maxFailures)
  }

  // 2. New pulls for wallets over threshold with nothing in flight.
  // Skip any wallet already handled in step 1 — one action per wallet per sweep.
  // EVM addresses start with 0x; Solana addresses are base58 (no 0x prefix).
  // Exclude Solana wallets — there is no Solana PullChain yet.
  const due = db
    .query<{ address: string; accrued_usd: number; settled_atomic: number }, [number]>(
      `SELECT address, accrued_usd, settled_atomic FROM wallet_state
       WHERE accrued_usd >= ? AND blocked = 0 AND pending_pull_usd IS NULL
         AND address LIKE '0x%'`,
    )
    .all(thresholdUsd)
  for (const w of due) {
    if (reconciled.has(w.address)) continue
    const snapshot = w.accrued_usd
    const deltaAtomic = Math.round(snapshot * scale)
    // Sign the caller's CUMULATIVE service total, not the bare delta. The contract charges
    // only (cumulative - settled[caller]), so retries/overlaps can never double-charge.
    const cumulativeAtomic = addAtomic(w.settled_atomic, deltaAtomic)
    const { hash, raw } = await chain.signPull(w.address, BigInt(cumulativeAtomic))
    // Persist BEFORE broadcast — the crash-safety invariant.
    db.run(
      `UPDATE wallet_state SET pending_pull_usd = ?, pending_pull_tx = ?, pending_pull_raw = ? WHERE address = ?`,
      [snapshot, hash, raw, w.address],
    )
    await chain.broadcastRaw(raw)
    const receipt = await chain.waitForReceipt(hash)
    if (receipt.status === 'success') settle(db, w.address, snapshot, cumulativeAtomic, hash)
    else fail(db, w.address, maxFailures)
  }
}

/** Start the background pull worker. Returns the interval handle. */
export function startPullWorker(db: Database, chain: PullChain, opts: PullOpts = {}, intervalMs = 30_000) {
  let inFlight = false
  return setInterval(() => {
    if (inFlight) return
    inFlight = true
    processPulls(db, chain, opts)
      .catch(e => console.warn('[puller]', (e as Error).message))
      .finally(() => { inFlight = false })
  }, intervalMs)
}
