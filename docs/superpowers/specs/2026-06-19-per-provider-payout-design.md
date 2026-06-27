# Per-Provider On-Chain Payout — Design Spec

_Date: 2026-06-19 · Status: **spec only — not built**_

## Problem

The marketplace **routes** per-provider but **pays** a single wallet. `LatchkeyBilling.pull()` sends
the 99% service share to one immutable-ish `proxy` address and 1% to `treasury`. Providers have no
on-chain identity or payout address, so there is nowhere to send "provider X's 99%."

This is internally consistent **today** only because the deployment is single-operator: the seeded
providers (TwoShoes, BigThought) route to upstreams using API keys the operator holds in `.env`, so
all revenue legitimately accrues to the operator's proxy wallet. It breaks the moment independent
third-party providers onboard — which is the stated marketplace vision (`CONTEXT.md`: "you pay
providers directly; the platform never holds your money").

**Goal:** each settlement pays **1% → treasury** and **99% → the wallet of the provider that actually
served the request** (determined by the `listing_id` already recorded in `billing_log`).

## Current state (verified)

- `providers(id, name, active)` and `listings(provider_id, endpoint, api_key, prices, …)` — **no payout address** on either.
- `billing_log(caller_address, listing_id, …)` — already records which listing/provider served each request.
- `LatchkeyBilling.pull(caller, cumulativeService)` → `delta` to single `proxy`, `delta/100` to `treasury`; monotonic checkpoint `settled[caller]`.
- Off-chain accrual (`wallet_state`) is keyed **per caller** only.

## Proposed design

The fee-on-top + idempotency + rotatable-roles primitives all carry over; they gain a **provider
dimension**.

### 1. Schema
- Add `payout_address TEXT` to `providers` (one payout wallet per provider; listings inherit it via `provider_id`).
- Replace the per-caller settlement columns on `wallet_state` with a per-(caller, provider) ledger —
  e.g. a new table `provider_debt(caller_address, provider_id, accrued_usd, settled_atomic, pending_pull_usd, pending_pull_tx, pending_pull_raw, pull_failure_count, blocked)`, PK `(caller_address, provider_id)`. `wallet_state` keeps caller-level state (allowance cache, global block).

### 2. Contract (`LatchkeyBilling` v-next)
- `pull(address caller, address provider, uint256 cumulativeService)` — `onlyProxy`.
- Checkpoint becomes 2-D: `mapping(address => mapping(address => uint256)) settled` keyed `[caller][provider]`.
- `delta = cumulativeService - settled[caller][provider]`; require strictly increasing; `fee = delta/100`;
  `transferFrom(caller, address(this), delta + fee)`; `transfer(provider, delta)`; `transfer(treasury, fee)`.
- A single caller USDC **allowance to the contract still covers all providers** — the caller approves once;
  the contract pulls and forwards to each provider. Non-custodial, fee-on-top preserved, idempotent per (caller, provider).
- Keep owner-rotatable `treasury`; `proxy` (the only allowed caller) stays rotatable. Provider payout
  addresses are validated as the `provider` arg passed by the proxy (the proxy is trusted to pass the
  right address from the off-chain `providers.payout_address`).

### 3. Off-chain (puller)
- Accrue per (caller, provider): each billed request adds cost to `provider_debt[caller, listing→provider]`.
- The worker iterates per (caller, provider) over the threshold and signs the cumulative total for that
  pair (`addAtomic` guard unchanged), settling each provider independently to its own payout address.
- Crash-safety / reconcile logic unchanged, just keyed per pair.

## Decisions to make before building
1. **Checkpoint keying** — `settled[caller][provider]` (chosen) vs a per-receipt nonce. 2-D mapping is simplest and matches the off-chain ledger.
2. **Who sets `payout_address`** — operator/owner-managed at provider onboarding (simplest) vs provider self-service (needs provider auth). Recommend owner-managed for v1.
3. **Pull granularity / gas** — settling per (caller, provider) means more, smaller pulls. Keep the $0.01 threshold per pair, or batch. Revisit if gas matters.
4. **Missing payout address** — if a provider has none, fall back to the operator `proxy` wallet, or refuse to route to that listing. Recommend: refuse to onboard a listing without a payout address.
5. **Fee base** — fee stays 1% of the provider `delta`, on top (unchanged).

## Out of scope
- Building it (this is a spec only).
- Provider self-onboarding UI, staking/slashing, quality-based routing.

## Definition of done (when built)
- [ ] `providers.payout_address` + per-(caller, provider) ledger, migrated.
- [ ] `pull(caller, provider, cumulativeService)` with `settled[caller][provider]`, fee-on-top, idempotent — forge tests.
- [ ] Puller accrues + settles per (caller, provider) — bun tests incl. crash-safety.
- [ ] Validator + DEPLOY.md updated for the new ABI; redeploy + re-approval documented.
- [ ] README/CONTEXT updated: payout is now per-provider.
