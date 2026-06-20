import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { openDb, closeDb } from '../src/db'
import { accrue, getWalletState } from '../src/wallet'
import { processPulls, addAtomic, type PullChain } from '../src/puller'
import { assertWalletAllowed } from '../src/wallet'
import type { Database } from 'bun:sqlite'

let db: Database
beforeEach(() => { db = openDb(':memory:') })
afterEach(() => closeDb(db))

// Controllable mock chain seam. Records calls; receipts are scripted per-hash.
function mockChain(opts: {
  receipts?: Record<string, { status: 'success' | 'reverted' } | null>
  defaultWait?: 'success' | 'reverted'  // status for waitForReceipt when not in receipts
  onBroadcast?: (raw: string) => void
  onWait?: () => void
} = {}): PullChain & { broadcasts: string[]; signed: Array<{ caller: string; gross: bigint }> } {
  const broadcasts: string[] = []
  const signed: Array<{ caller: string; gross: bigint }> = []
  return {
    broadcasts,
    signed,
    async signPull(caller, gross) {
      signed.push({ caller, gross })
      const hash = `0xhash_${caller}_${gross}`
      return { hash, raw: `raw:${hash}` }
    },
    async broadcastRaw(raw) { broadcasts.push(raw); opts.onBroadcast?.(raw) },
    async getReceipt(hash) { return opts.receipts?.[hash] ?? null },
    async waitForReceipt(hash) {
      opts.onWait?.()
      return opts.receipts?.[hash] ?? { status: opts.defaultWait ?? 'success' }
    },
  }
}

const OPTS = { thresholdUsd: 0.10, scale: 1_000_000, maxFailures: 3 }

describe('processPulls — new pull', () => {
  it('persists pending (hash + raw) BEFORE broadcasting', async () => {
    accrue(db, '0xabc', 0.12)
    let pendingAtBroadcast: string | null = null
    const chain = mockChain({ onBroadcast: () => {
      pendingAtBroadcast = getWalletState(db, '0xabc')?.pending_pull_tx ?? null
    } })
    await processPulls(db, chain, OPTS)
    // the DB row must already carry the tx hash at the moment broadcast fires
    expect(pendingAtBroadcast as string | null).toBe('0xhash_0xabc_120000')
    expect(chain.broadcasts.length).toBe(1)
  })

  it('settles by snapshot on success: debt drops, lifetime rises, pending cleared', async () => {
    accrue(db, '0xabc', 0.12)
    await processPulls(db, mockChain(), OPTS) // default receipt = success
    const s = getWalletState(db, '0xabc')!
    expect(s.accrued_usd).toBeCloseTo(0, 10)
    expect(s.total_pulled_usd).toBeCloseTo(0.12, 10)
    expect(s.pending_pull_usd).toBeNull()
    expect(s.pending_pull_tx).toBeNull()
    expect(s.last_pull_at).not.toBeNull()
  })

  it('does not pull a wallet below threshold', async () => {
    accrue(db, '0xabc', 0.05)
    const chain = mockChain()
    await processPulls(db, chain, OPTS)
    expect(chain.signed.length).toBe(0)
    expect(getWalletState(db, '0xabc')!.accrued_usd).toBeCloseTo(0.05, 10)
  })

  it('preserves debt accrued during the pull window (deduct snapshot, not zero)', async () => {
    accrue(db, '0xabc', 0.12)
    // simulate a request billed mid-pull, while waiting for the receipt
    const chain = mockChain({ onWait: () => accrue(db, '0xabc', 0.05) })
    await processPulls(db, chain, OPTS)
    const s = getWalletState(db, '0xabc')!
    expect(s.accrued_usd).toBeCloseTo(0.05, 10)   // the in-window debt survives
    expect(s.total_pulled_usd).toBeCloseTo(0.12, 10)
  })
})

describe('processPulls — failure & blocking', () => {
  it('increments failure on revert and blocks after 3', async () => {
    accrue(db, '0xbad', 0.12)
    for (let i = 1; i <= 3; i++) {
      await processPulls(db, mockChain({ defaultWait: 'reverted' }), OPTS)
      const s = getWalletState(db, '0xbad')!
      expect(s.pull_failure_count).toBe(i)
      expect(s.blocked).toBe(i >= 3 ? 1 : 0)
      // debt remains (nothing was pulled) and pending cleared so next sweep retries
      expect(s.accrued_usd).toBeCloseTo(0.12, 10)
      expect(s.pending_pull_usd).toBeNull()
    }
  })

  it('a blocked wallet is rejected by the hot-path gate', async () => {
    db.run(`INSERT INTO wallet_state (address, blocked) VALUES ('0xbad', 1)`)
    await expect(
      assertWalletAllowed(db, '0xbad', { readAllowance: async () => 10_000_000n, thresholdAtomic: 100_000n }),
    ).rejects.toMatchObject({ statusCode: 402 })
  })

  it('a blocked wallet is skipped by the pull worker', async () => {
    db.run(`INSERT INTO wallet_state (address, accrued_usd, blocked) VALUES ('0xbad', 0.50, 1)`)
    const chain = mockChain()
    await processPulls(db, chain, OPTS)
    expect(chain.signed.length).toBe(0)
  })
})

describe('processPulls — crash recovery (reconcile)', () => {
  function seedPending(amount = 0.12, hash = '0xpending') {
    db.run(
      `INSERT INTO wallet_state (address, accrued_usd, pending_pull_usd, pending_pull_tx, pending_pull_raw)
       VALUES ('0xrec', ?, ?, ?, ?)`,
      [amount, amount, hash, `raw:${hash}`],
    )
  }

  it('re-broadcasts the saved raw tx when no receipt is found, then settles', async () => {
    seedPending()
    const chain = mockChain({ receipts: { '0xpending': null } }) // getReceipt null, waitForReceipt defaults success
    await processPulls(db, chain, OPTS)
    expect(chain.broadcasts).toContain('raw:0xpending') // re-broadcast happened
    const s = getWalletState(db, '0xrec')!
    expect(s.accrued_usd).toBeCloseTo(0, 10)
    expect(s.total_pulled_usd).toBeCloseTo(0.12, 10)
  })

  it('settles directly when the in-flight tx already succeeded (no re-broadcast)', async () => {
    seedPending()
    const chain = mockChain({ receipts: { '0xpending': { status: 'success' } } })
    await processPulls(db, chain, OPTS)
    expect(chain.broadcasts.length).toBe(0) // receipt found → no re-broadcast
    expect(getWalletState(db, '0xrec')!.total_pulled_usd).toBeCloseTo(0.12, 10)
  })

  it('fails when the in-flight tx reverted', async () => {
    seedPending()
    const chain = mockChain({ receipts: { '0xpending': { status: 'reverted' } } })
    await processPulls(db, chain, OPTS)
    const s = getWalletState(db, '0xrec')!
    expect(s.pull_failure_count).toBe(1)
    expect(s.total_pulled_usd).toBeCloseTo(0, 10)
    expect(s.pending_pull_usd).toBeNull()
  })
})

describe('addAtomic — safe-integer guard for cumulative atomic math', () => {
  it('adds two atomic amounts', () => {
    expect(addAtomic(100_000, 50_000)).toBe(150_000)
  })

  it('throws rather than silently lose precision past Number.MAX_SAFE_INTEGER', () => {
    expect(() => addAtomic(Number.MAX_SAFE_INTEGER, 1)).toThrow('atomic overflow')
  })
})

describe('processPulls — cumulative settlement (on-chain idempotency)', () => {
  it('signs the cumulative service total, advancing settled_atomic across pulls', async () => {
    accrue(db, '0xc', 0.10)
    const chain = mockChain()
    await processPulls(db, chain, OPTS) // first sweep: delta 100000 → cumulative 100000
    expect(chain.signed[0].gross).toBe(100_000n)
    expect(getWalletState(db, '0xc')!.settled_atomic).toBe(100_000)

    accrue(db, '0xc', 0.12) // 120000 of new debt (above the 0.10 threshold)
    await processPulls(db, chain, OPTS) // second sweep: cumulative 220000, NOT the 120000 delta
    expect(chain.signed[1].gross).toBe(220_000n)
    expect(getWalletState(db, '0xc')!.settled_atomic).toBe(220_000)
  })

  it('does not advance settled_atomic when a pull reverts', async () => {
    accrue(db, '0xbad', 0.12)
    await processPulls(db, mockChain({ defaultWait: 'reverted' }), OPTS)
    expect(getWalletState(db, '0xbad')!.settled_atomic).toBe(0)
  })

  it('crash before the pending-pull write loses nothing: debt survives, next sweep pulls', async () => {
    accrue(db, '0xcrash', 0.12)
    // Simulate a crash during step 2 BEFORE the UPDATE persists pending_pull_*:
    // signPull throws, so processPulls rejects before writing the pending row.
    const throwingChain: PullChain = {
      async signPull() { throw new Error('crash before write') },
      async broadcastRaw() {},
      async getReceipt() { return null },
      async waitForReceipt() { return { status: 'success' } },
    }
    await expect(processPulls(db, throwingChain, OPTS)).rejects.toThrow('crash before write')
    const after = getWalletState(db, '0xcrash')!
    expect(after.accrued_usd).toBeCloseTo(0.12, 10) // debt intact
    expect(after.pending_pull_usd).toBeNull()        // nothing left in flight
    expect(after.settled_atomic).toBe(0)             // nothing settled

    // Next sweep with a healthy chain settles cleanly — no double-bill.
    await processPulls(db, mockChain(), OPTS)
    const settled = getWalletState(db, '0xcrash')!
    expect(settled.accrued_usd).toBeCloseTo(0, 10)
    expect(settled.total_pulled_usd).toBeCloseTo(0.12, 10)
    expect(settled.settled_atomic).toBe(120_000)
  })
})
