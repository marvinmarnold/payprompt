# Provider Self-Onboarding: API-delegating flow (design, WIP)

_Date: 2026-06-28 · Status: in progress (grilling). Comment inline on this PR._

Scope of this pass: the API-delegating provider flow only (provider supplies an upstream
credential and per-Model pricing; the platform custodies the credential encrypted and routes by
cheapest cost). Self-hosted mode and subscription-resale are separate efforts.

## Decisions so far (grilled)

1. **Provider identity = wallet.** One wallet owns exactly one Provider. The wallet is also the
   payout address. Seeded operator Providers are grandfathered (no wallet, operator-managed).
2. **Custody is mode-specific** (glossary amended; `docs/adr/0005`). API-delegating mode custodies
   the provider's upstream credential, encrypted at rest. Self-hosted holds nothing.
3. **Connection is the registration unit.** A Provider registers a Connection (endpoint, wire
   format, credential). Discovery enumerates the Models on it and creates one Listing per Model.
   Provider 1 wallet, many Connections, many Listings.
4. **Pricing is per Listing (per Model), required.** No Connection-level default. A discovered
   Listing is not routable until its Provider sets its price and it is active.

## Interfaces (foundational first)

1. Domain types (below)
2. Provider auth: verify an EIP-712 `ProviderAction` plus an ownership check
3. Credential cipher: an injectable encrypt/decrypt seam (env-key AES-256-GCM now, KMS later)
4. Connection store: create/read/update Connections and Listings
5. Discovery: Connection to Listing[] (exists today, lightly adapted)
6. Forwarder: forward to a Listing's endpoint, decrypting the credential at call time
7. Router: pick the cheapest routable Listing for a Model (exists, unchanged)
8. Registration API: the REST surface Providers call

## #1 Domain types

```ts
// One per wallet: identity + payout
type Provider = {
  wallet: `0x${string}`              // canonical identity and payout address, UNIQUE
  name: string                       // display label only
  active: boolean                    // kill switch
}

// The unit a Provider registers; fans out to Listings via discovery
type Connection = {
  id: string
  providerWallet: `0x${string}`
  mode: 'delegated' | 'self_hosted'
  endpoint: string                   // upstream API (delegated) or the provider's own server
  upstreamFormat: 'openai' | 'anthropic'
  credentialEnc: string | null       // ciphertext (iv, tag, data); never plaintext, never returned
  active: boolean
}

// One Model on a Connection; price required before routable
type Listing = {
  id: string
  connectionId: string
  modelId: string                    // what the Caller requests
  providerModelId: string            // id used in the upstream call
  priceInputUsdPerM: number | null   // null = discovered but unpriced, NOT routable
  priceOutputUsdPerM: number | null
  ctxLength: number | null
  reliability: number
  active: boolean
}
```

**Schema note:** today endpoint, format, and api_key are denormalized onto every `listings` row.
These types normalize that into a `connections` table that Listings reference, so one encrypted
credential is stored per Connection rather than duplicated across model rows.

## Still open (next grill points)
- #2 the `ProviderAction` EIP-712 signature shape and replay protection
- Schema migration: introduce `connections`, move endpoint/format/credential off `listings`
- Encryption key handling (`PROVIDER_ENC_KEY`), rotation
- Model-substitution abuse and the role of fingerprinting
