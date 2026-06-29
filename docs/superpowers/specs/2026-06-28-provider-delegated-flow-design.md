# Provider Self-Onboarding: latchkey-hosted flow (design, WIP)

_Date: 2026-06-28. Status: in progress (grilling). Comment inline on this PR._

This pass covers the latchkey-hosted provider flow only.
A Provider uploads an upstream credential and per-Model pricing; latchkey runs bitllm on their behalf, custodies the credential encrypted, and routes by cheapest cost.
(Previously called "API-delegating"; see `docs/adr/0005` for the bitllm protocol vs latchkey application split.)
Running your own bitllm host, and subscription resale, are separate efforts.

## Decisions so far (grilled)

1. **Provider identity = wallet.** One wallet owns exactly one Provider. The wallet is also the
   payout address. Seeded operator Providers are grandfathered (no wallet, operator-managed).
2. **latchkey custodies the uploaded credential, encrypted at rest.** There is no "never holds keys" principle (that premise was wrong; corrected in `docs/adr/0005`). A bitllm-host Provider uploads nothing, so latchkey holds no credential for it.
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
  mode: 'latchkey_hosted' | 'bitllm_host'
  endpoint: string                   // upstream API (latchkey_hosted) or the Provider's own bitllm host
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
