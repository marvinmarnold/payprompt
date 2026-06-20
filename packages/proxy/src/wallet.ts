import type { Database } from 'bun:sqlite'

export type WalletState = {
  address: string
  accrued_usd: number
  total_pulled_usd: number
  pull_failure_count: number
  pending_pull_usd: number | null
  pending_pull_tx: string | null
  pending_pull_raw: string | null
  last_pull_at: number | null
  last_pull_tx: string | null
  blocked: number
  /** Off-chain mirror of the contract's monotonic settled[caller] (atomic USDC, fee-exclusive). */
  settled_atomic: number
}

export function getWalletState(db: Database, address: string): WalletState | null {
  return db
    .query<WalletState, [string]>(`SELECT * FROM wallet_state WHERE address = ?`)
    .get(address)
}

/** Add a request's dollar cost to a wallet's off-chain debt, creating the row if needed. */
export function accrue(db: Database, address: string, costUsd: number): void {
  db.run(
    `INSERT INTO wallet_state (address, accrued_usd) VALUES (?, ?)
     ON CONFLICT(address) DO UPDATE SET accrued_usd = accrued_usd + excluded.accrued_usd`,
    [address, costUsd],
  )
}

function err402(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 402 })
}

export interface AllowanceCheck {
  /** Reads the caller's current USDC allowance to the billing contract, in atomic units. */
  readAllowance: (address: string) => Promise<bigint>
  /** Minimum allowance (atomic units) a first-seen wallet must have approved. */
  thresholdAtomic: bigint
}

/**
 * Hot-path gate. Local-only for known wallets (zero RPC):
 *  - blocked wallet → 402
 *  - known unblocked wallet → admitted, no allowance read
 *  - first-seen wallet → one allowance read; admitted + cached only if ≥ threshold, else 402
 */
export async function assertWalletAllowed(
  db: Database,
  address: string,
  { readAllowance, thresholdAtomic }: AllowanceCheck,
): Promise<void> {
  const state = getWalletState(db, address)
  if (state) {
    if (state.blocked) throw err402('Wallet blocked — re-approve allowance and contact operator to unblock')
    return // known, unblocked → no RPC
  }
  // First-seen: verify an allowance exists before admitting.
  const allowance = await readAllowance(address)
  if (allowance < thresholdAtomic) {
    throw err402('Approve USDC allowance for the billing contract before using the proxy')
  }
  // Cache the wallet so subsequent requests skip the RPC. INSERT OR IGNORE keeps
  // two concurrent first requests from racing on the PRIMARY KEY.
  db.run(`INSERT OR IGNORE INTO wallet_state (address) VALUES (?)`, [address])
}
