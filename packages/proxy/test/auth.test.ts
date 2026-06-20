// packages/proxy/test/auth.test.ts
import { describe, it, expect } from 'bun:test'
import { verifyBearerToken, encodeBearerToken, encodeSolanaBearerToken } from '../src/middleware/auth'
import { privateKeyToAccount } from 'viem/accounts'
import bs58 from 'bs58'
import * as ed from '@noble/ed25519'

const TEST_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const
// Deterministic 32-byte seed for Solana tests
const SOLANA_SEED = new Uint8Array(32).fill(42)

describe('auth — EVM', () => {
  it('verifies a valid EVM bearer token', async () => {
    const account = privateKeyToAccount(TEST_PRIVATE_KEY)
    const encoded = await encodeBearerToken(TEST_PRIVATE_KEY)
    const { callerAddress, chain } = await verifyBearerToken(encoded)
    expect(callerAddress.toLowerCase()).toBe(account.address.toLowerCase())
    expect(chain).toBe('evm')
  })

  it('rejects an expired token', async () => {
    const encoded = await encodeBearerToken(TEST_PRIVATE_KEY, Math.floor(Date.now() / 1000) - 1)
    await expect(verifyBearerToken(encoded)).rejects.toThrow('expired')
  })

  it('rejects a tampered token', async () => {
    const account = privateKeyToAccount(TEST_PRIVATE_KEY)
    const token = {
      address: account.address,
      expiry: Math.floor(Date.now() / 1000) + 3600,
      nonce: 'test',
      sig: ('0x' + 'aa'.repeat(65)) as `0x${string}`
    }
    const encoded = Buffer.from(JSON.stringify(token)).toString('base64')
    await expect(verifyBearerToken(encoded)).rejects.toThrow()
  })

  it('rejects a token signed by a different EVM key (address spoof)', async () => {
    // Sign a well-formed EIP-712 token with the attacker's key but claim the victim's address.
    const victim = privateKeyToAccount(('0x' + '11'.repeat(32)) as `0x${string}`)
    const attacker = privateKeyToAccount(TEST_PRIVATE_KEY)
    const expiry = Math.floor(Date.now() / 1000) + 3600
    const nonce = 'spoof-nonce'
    const sig = await attacker.signTypedData({
      domain: { name: 'Latchkey LLM Marketplace', version: '1', chainId: 8453 },
      types: {
        BearerToken: [
          { name: 'address', type: 'address' },
          { name: 'expiry', type: 'uint256' },
          { name: 'nonce', type: 'string' },
        ],
      },
      primaryType: 'BearerToken',
      message: { address: victim.address, expiry: BigInt(expiry), nonce },
    })
    const token = { address: victim.address, expiry, nonce, sig }
    const encoded = Buffer.from(JSON.stringify(token)).toString('base64')
    await expect(verifyBearerToken(encoded)).rejects.toThrow('Invalid signature')
  })

  it('rejects a token missing a required field before signature work', async () => {
    const account = privateKeyToAccount(TEST_PRIVATE_KEY)
    const token = { address: account.address, expiry: Math.floor(Date.now() / 1000) + 3600, nonce: 'n' }
    const encoded = Buffer.from(JSON.stringify(token)).toString('base64')
    await expect(verifyBearerToken(encoded)).rejects.toThrow('Missing token fields')
  })
})

describe('auth — Solana', () => {
  it('verifies a valid Solana bearer token round-trip', async () => {
    const pubKey = await ed.getPublicKeyAsync(SOLANA_SEED)
    const expectedAddress = bs58.encode(pubKey)
    const encoded = await encodeSolanaBearerToken(SOLANA_SEED)
    const { callerAddress, chain } = await verifyBearerToken(encoded)
    expect(callerAddress).toBe(expectedAddress)
    expect(chain).toBe('solana')
  })

  it('rejects an expired Solana token', async () => {
    const encoded = await encodeSolanaBearerToken(SOLANA_SEED, Math.floor(Date.now() / 1000) - 1)
    await expect(verifyBearerToken(encoded)).rejects.toThrow('expired')
  })

  it('rejects a Solana token with a bad signature', async () => {
    const pubKey = await ed.getPublicKeyAsync(SOLANA_SEED)
    const address = bs58.encode(pubKey)
    // Build a valid-looking token but with a garbage signature
    const token = {
      address,
      expiry: Math.floor(Date.now() / 1000) + 3600,
      nonce: 'test-nonce',
      sig: bs58.encode(new Uint8Array(64).fill(0xab)),
    }
    const encoded = Buffer.from(JSON.stringify(token)).toString('base64')
    await expect(verifyBearerToken(encoded)).rejects.toThrow('Invalid Solana signature')
  })

  it('rejects a Solana token whose address does not match the signer', async () => {
    // Sign with one key but claim a different address
    const otherSeed = new Uint8Array(32).fill(99)
    const otherPubKey = await ed.getPublicKeyAsync(otherSeed)
    // Encode a token that says address = otherPubKey but is signed by SOLANA_SEED
    const spoofedToken = {
      address: bs58.encode(otherPubKey),
      expiry: Math.floor(Date.now() / 1000) + 3600,
      nonce: 'x',
      sig: bs58.encode(await ed.signAsync(
        new TextEncoder().encode(`latchkey:${bs58.encode(otherPubKey)}:${Math.floor(Date.now() / 1000) + 3600}:x`),
        SOLANA_SEED,
      )),
    }
    const encoded = Buffer.from(JSON.stringify(spoofedToken)).toString('base64')
    await expect(verifyBearerToken(encoded)).rejects.toThrow('Invalid Solana signature')
  })
})
