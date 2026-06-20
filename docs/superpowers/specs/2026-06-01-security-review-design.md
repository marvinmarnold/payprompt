# Security Review — Design Spec

_Date: 2026-06-01_

## Goal

A focused pre-launch review pass covering the three areas with the highest real risk in the current codebase. No new features, no refactors. Output: each area is either documented as verified-correct or patched with a test.

---

## Scope

### In scope (action required)

| Area | What to do | Expected outcome |
|------|-----------|-----------------|
| EVM signature verification | Read `auth.ts`; trace the full comparison path for `recovered` vs `token.address` | Documented as verified, or a fix committed |
| SQLite WAL + crash safety | Read `puller.ts`; trace the `wallet_state` pending-pull state machine through three crash scenarios (before the pending-pull write, after the write but before broadcast, after broadcast but before settle) | Each scenario documented as safe, or a fix committed |
| Dependency audit | Run `bun audit` in `packages/proxy`; assess `@solana/web3.js` version and known CVEs | High-severity findings fixed; medium/low documented |

### Known risks — documented, not actioned now

| Risk | Why deferred |
|------|-------------|
| Per-token revocation | A leaked bearer token is valid until its `expiry` (30d default for EVM, 1h for Solana) — the same risk profile as any leaked long-lived API key. There is no instant per-token kill switch; revocation is at the wallet level (lower the on-chain allowance, or operator sets `wallet_state.blocked = 1`). Exposure is bounded by the on-chain allowance / Caller Deposit, same as the rate-limiting rationale below. Not a replay vuln — tokens are reusable by design. Revisit if instant per-token revocation becomes a requirement. |
| Admin endpoint auth | `/admin/usage`, `/admin/wallets`, `/admin/allowance/:address` are unauthenticated. Accepted: this data is read-only and is intended to migrate on-chain (public by design), so gating it now would be throwaway work. |
| Rate limiting | Deemed unnecessary while the Caller Deposit caps fronting exposure. Billing itself bounds abuse. Revisit if abuse patterns emerge at scale. |

---

## Area 1 — EVM Signature Verification

**File:** `packages/proxy/src/middleware/auth.ts`

**What to verify:**
- `recoverTypedDataAddress` returns a checksum address; confirm the comparison normalises both sides to the same case (`.toLowerCase()` on both, or viem's `isAddressEqual`)
- The EIP-712 domain and type hash match what clients sign — no mismatch between proxy and client SDK
- No branch where a malformed token can skip the signature check and proceed

**Pass criteria:** A written note in the spec (or inline comment where appropriate) confirming each point, or a fix + test if a gap is found.

---

## Area 2 — SQLite WAL + Crash Safety (Pull Worker)

**File:** `packages/proxy/src/puller.ts`

**State model (verify against the code, not against assumptions):** there is no `pending_pulls` or `pull_history` table. In-flight pull state lives in columns on `wallet_state` — `pending_pull_usd`, `pending_pull_tx`, `pending_pull_raw` (schema in `db.ts`). Accrued debt lives in `wallet_state.accrued_usd`, maintained incrementally as requests are billed (committed independently of any pull). A sweep (`processPulls`) reconciles in-flight pulls first (step 1), then starts new pulls for wallets over threshold (step 2). The pending-pull columns are written *before* broadcast; `settle()` clears them and deducts the snapshot amount.

**Crash scenarios to trace:**

| Scenario | Expected safe behavior |
|----------|----------------------|
| Crash **before** the `UPDATE wallet_state SET pending_pull_* …` write (step 2) | No pull was started. `accrued_usd` was already committed when the request was billed, so debt is not lost — it is simply picked up on the next sweep. |
| Crash **after** the pending-pull write, **before** broadcast | On restart, step 1 selects the wallet (`pending_pull_usd IS NOT NULL`), finds no on-chain receipt for the saved hash, and re-broadcasts the saved raw tx. Same nonce + payload ⇒ same hash, so this cannot double-bill. |
| Crash **after** broadcast, **before** `settle()` | On restart, step 1 finds the pending pull; the tx may already be mined. Worker checks `getReceipt(hash)` first and only `settle()`s on a confirmed success — it does not blindly re-broadcast or double-deduct. |

**Pass criteria:** Each scenario traced in comments or a written note. Any unsafe path gets a fix + test.

---

## Area 3 — Dependency Audit

**Command:**
```bash
cd packages/proxy && bun audit
```

**Focus areas:**
- Any high-severity finding: fix (update or replace dependency)
- `@solana/web3.js`: note the pinned version; check if it is on the `2.x` rewrite branch (preferred — smaller, no `Buffer` polyfill, reduced supply-chain surface) or the legacy `1.x` branch
- Medium/low findings: document with a disposition (accept / plan to fix / already mitigated)

**Pass criteria:** No unaddressed high-severity CVEs. A written disposition for every finding.

---

## What is explicitly out of scope

- Adding new features (encryption, retries, auth systems)
- Refactoring code that is not directly involved in the above three areas
- Implementing deferred risks (per-token revocation, admin auth, rate limiting) — those have their own future specs

---

## Findings (2026-06-14)

Implemented on branch `ma/security-hardening`. Forge: 29 tests green. Bun (proxy): 73 tests green.

### Area 1 — EVM signature verification — VERIFIED + tests added
- Comparison is case-normalised (`recovered.toLowerCase() !== token.address.toLowerCase()`, `auth.ts:70`). ✅
- In-repo signer (`encodeBearerToken`) and verifier share the same `DOMAIN`/`BEARER_TYPES`/`primaryType`. ✅
- Field presence is checked before any signature work (`auth.ts:50-52`); the only `return`s are post-verification. ✅
- Added tests: cross-signed EVM token (wrong key, valid EIP-712) → rejected `Invalid signature`; missing-field token → rejected `Missing token fields` (`test/auth.test.ts`).
- **Follow-up (not in this repo):** confirm the EIP-712 `DOMAIN`/`BEARER_TYPES` match the *client SDK* source — not inspectable here.

### Area 2 — Pull-worker crash safety — VERIFIED (real `wallet_state` model) + test added
- State lives in `wallet_state` columns (`pending_pull_*`), not the `pending_pulls`/`pull_history` tables the original draft imagined.
- Scenario "crash after pending-write, before broadcast" → reconcile re-broadcasts the saved raw tx (same hash, no double-bill): `test/puller.test.ts:121`.
- Scenario "crash after broadcast, before settle" → reconcile settles only on a confirmed receipt: `test/puller.test.ts:131`.
- Scenario "crash before pending-write" → `accrued_usd` survives (committed at billing time), picked up next sweep: new `crash before the pending-pull write loses nothing` test.

### Area 3 — Dependency audit — no high-severity in the proxy
- `bun audit` (workspace-wide): 24 advisories (8 high, 14 moderate, 2 low).
- **Proxy package:** the only finding is transitive `uuid <11.1.1` (moderate) via `@solana/web3.js`. `@solana/web3.js` is pinned `^1.98.4` — **legacy 1.x**. Disposition: **accept**; resolved by the 2.x migration (separate future spec). Not exploitable in our usage (no user-controlled `buf` passed to uuid).
- **All 8 highs are in other workspaces, outside the proxy's production path:** `@latchkey/indexer` via `@ponder/core` (drizzle/kysely SQL-injection in ORM internals; vite/esbuild/launch-editor **dev-server only**) and `@latchkey/admin` via `next` (postcss). Disposition: **plan to fix** by upgrading Ponder/Next in those packages; out of scope for this proxy-focused pass.

### Contract hardening (LatchkeyBilling) — implemented this pass
Triaged from the Octane "Locker Money: latchkey" report (2026-06-12). Redeploy required (see deploy notes).

- **Fee model (Octane #5) — CHANGED per product intent.** Fee is now 1% **on top** of the provider price: `pull(caller, cumulativeService)` → caller pays `delta + delta/100`, proxy receives exactly `delta`, treasury receives `delta/100`. (The old model carved the fee out of `gross`.)
- **On-chain idempotency (Octane Warning 1 + related) — ADDED.** Monotonic `settled[caller]` checkpoint; only the unsettled delta is ever charged, so honest retries, crash-recovery re-broadcasts, and overlapping snapshots cannot double-charge. Off-chain mirror: `wallet_state.settled_atomic`; the puller signs the cumulative total.
- **Rotatable roles (Octane #2 related, "immutable routing") — ADDED.** Owner-rotatable `proxy`/`treasury` (`setProxy`/`setTreasury`/`transferOwnership`, events) to recover from a compromised hot key or a token-blocklisted recipient without redeploying. Directly addresses the documented proxy-key compromise.

### Octane findings dispositions
- **#1 / #6 (no escrow → uncollectible postpaid debt):** intentional design, not a code bug. Bounded by the $0.01 pull threshold + sweep window. Mitigation (caller deposit/escrow) is a pre-scale business decision, not patched here.
- **#2, #3, #4 + insolvency/migration/stuck-transfer/relay sub-findings (PaypromptBalance):** **moot — `PaypromptBalance` is not deployed and not on any active path** (`BALANCE_CONTRACT_ADDRESS` empty; proxy never calls `debit()`). The active rail is the non-custodial pull model, which is the report's own recommended mitigation. Recommend deleting `PaypromptBalance.sol` in a follow-up.
- **#5 (fee base):** addressed by the fee-on-top change above.
- **Warning 1 + related (replay/idempotency/amount-binding):** addressed by the cumulative `settled` checkpoint above.

### DeepSeek review (per CLAUDE.md protocol)
- (1) Monotonic guarantee holds — replay/out-of-order impossible. (2) Effects-before-interactions correct; USDC `transferFrom` has no callback, no guard needed. (3) No float drift — both sides integer; contract only requires `cumulative > prev`. All confirmed.
- (4) Treasury-blocklist DoS is real: if `treasury` reverts on transfer, `pull` reverts. **Disposition:** mitigated by owner-rotatable `treasury` (single-tx recovery); a compromised owner is already game-over (can also `setProxy`), so in-contract fee accrual + sweep adds custody/complexity without materially reducing risk. **Deferred** — revisit before mainnet if desired.

## Definition of done

- [x] EVM sig check: documented as verified + cross-signed/missing-field tests committed
- [x] Crash safety: all three scenarios traced against the real `wallet_state` model + crash-before-write test committed
- [x] Dependency audit: `bun audit` recorded; no high-severity in the proxy; dispositions written for the `uuid`/`@solana/web3.js` moderate and the other-workspace highs
- [x] This spec updated with findings summary
- [x] (Beyond original scope, per user request) Fee-on-top + on-chain idempotency + rotatable roles implemented & tested; deployment validator added
- [ ] **Redeploy** the hardened `LatchkeyBilling` + update addresses + run `deploy/validate-deployment.sh` (needs deployer key — see deploy notes)
