import { describe, it, expect } from 'bun:test'
import { expectedSplit } from '../scripts/validate-deployment'

// Fee-on-top: the provider receives exactly the service delta; the treasury gets 1% on top;
// the caller pays delta + fee. This must mirror LatchkeyBilling.pull's on-chain split.
describe('expectedSplit — fee-on-top', () => {
  it('charges 1% on top for a typical delta', () => {
    expect(expectedSplit(100_000n)).toEqual({ fee: 1_000n, net: 100_000n, total: 101_000n })
  })

  it('rounds the fee down (integer division) for small deltas', () => {
    expect(expectedSplit(99n)).toEqual({ fee: 0n, net: 99n, total: 99n })
    expect(expectedSplit(199n)).toEqual({ fee: 1n, net: 199n, total: 200n })
  })

  it('net always equals the service delta (provider is paid in full)', () => {
    for (const d of [1n, 250n, 1_000_000n, 1_234_567n]) {
      expect(expectedSplit(d).net).toBe(d)
      expect(expectedSplit(d).total).toBe(d + d / 100n)
    }
  })
})
