# Security Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the pre-launch security review in `docs/superpowers/specs/2026-06-01-security-review-design.md` — verify (or patch + test) EVM signature verification and pull-worker crash safety, and run a dependency audit, then record findings back into the spec.

**Architecture:** This is a verification pass, not a feature build. Most of the target behavior already has tests (`test/auth.test.ts`, `test/puller.test.ts`). Each area is: (1) read the code and trace the relevant path, (2) confirm coverage or add the specific missing test (red→green), (3) write a finding back into the spec. Only commit code when a gap is found; otherwise the deliverable is a documented finding.

**Tech Stack:** Bun (`bun test`), TypeScript, viem (EIP-712 / `recoverTypedDataAddress`), `@noble/ed25519` + bs58 (Solana), `bun:sqlite`.

**Scope note:** Per the spec, Area 1 covers the **EVM** signature path only. The Solana ed25519 path is intentionally out of scope for this pass.

---

## File Map

| File | Role in this plan |
|------|-------------------|
| `packages/proxy/src/middleware/auth.ts` | Subject of Area 1. Read-only unless a gap is found. |
| `packages/proxy/test/auth.test.ts` | Area 1 tests. Add gap-filling cases here. |
| `packages/proxy/src/puller.ts` | Subject of Area 2. Read-only unless a gap is found. |
| `packages/proxy/test/puller.test.ts` | Area 2 tests. Add the crash-before-write case here. |
| `packages/proxy/package.json` | Area 3 — dependency versions. |
| `docs/superpowers/specs/2026-06-01-security-review-design.md` | Findings summary + Definition-of-done checkboxes are written here. |

All `bun` commands run from `packages/proxy` unless stated otherwise.

---

## Task 0: Branch and baseline

**Files:** none (setup)

- [ ] **Step 1: Create the working branch**

```bash
cd /Users/stevejobs/code/latchkey
git checkout -b ma/security-review
```

- [ ] **Step 2: Confirm the suite is green before any change**

Run:
```bash
cd packages/proxy && ~/.bun/bin/bun test
```
Expected: all tests pass (this is the baseline; any later red must be caused by a new test you wrote).

---

## Task 1 — Area 1: EVM signature verification

**Files:**
- Read: `packages/proxy/src/middleware/auth.ts:40-91` (`verifyBearerToken`) and `:8-20` (`DOMAIN`, `BEARER_TYPES`)
- Test: `packages/proxy/test/auth.test.ts`

**What the existing code does (verify against the file):**
- `recoverTypedDataAddress` recovers a checksummed address; the comparison normalises both sides: `recovered.toLowerCase() !== token.address.toLowerCase()` (`auth.ts:70`). ✅ spec point 1.
- `DOMAIN` = `{ name: 'Latchkey LLM Marketplace', version: '1', chainId: 8453 }`; `BEARER_TYPES.BearerToken` = `address`/`expiry(uint256)`/`nonce(string)`. The signer (`encodeBearerToken`, `auth.ts:101-106`) uses the exact same `DOMAIN`/`BEARER_TYPES`/`primaryType`. ✅ spec point 2 for the in-repo signer.
- Field presence is checked before any signature work (`auth.ts:50-52`), and a `JSON.parse` failure throws `Malformed token` (`auth.ts:46`). The only `return` paths are after a passing signature check. ✅ spec point 3.

**Existing coverage:** valid token, expired token, tampered (garbage) signature (`auth.test.ts:12-37`).

**Gap to fill:** there is no test proving a *well-formed signature by the wrong key* (cross-signed token) is rejected, and none proving a token missing a required field is rejected before the signature path. Add both.

- [ ] **Step 1: Write the failing tests**

Add inside the `describe('auth — EVM', ...)` block in `packages/proxy/test/auth.test.ts`:

```typescript
  it('rejects a token signed by a different EVM key (address spoof)', async () => {
    // Sign a token with key A but claim address B
    const victim = privateKeyToAccount(
      ('0x' + '11'.repeat(32)) as `0x${string}`,
    )
    const expiry = Math.floor(Date.now() / 1000) + 3600
    const nonce = 'spoof-nonce'
    const attacker = privateKeyToAccount(TEST_PRIVATE_KEY)
    const sig = await attacker.signTypedData({
      domain: { name: 'Latchkey LLM Marketplace', version: '1', chainId: 8453 },
      types: { BearerToken: [
        { name: 'address', type: 'address' },
        { name: 'expiry', type: 'uint256' },
        { name: 'nonce', type: 'string' },
      ] },
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
```

- [ ] **Step 2: Run the tests to confirm behavior**

Run:
```bash
cd packages/proxy && ~/.bun/bin/bun test test/auth.test.ts
```
Expected: both new tests PASS (they assert behavior the code already implements — they lock it in). If either FAILS, that is a real gap → stop and fix `auth.ts` before continuing.

- [ ] **Step 3: Write the Area 1 finding**

In `docs/superpowers/specs/2026-06-01-security-review-design.md`, under `## Area 1`, append a `**Findings:**` block stating: comparison is case-normalised (`auth.ts:70`); in-repo signer/verifier share `DOMAIN`/`BEARER_TYPES`; no malformed-token branch skips the check; cross-signed and missing-field rejection now covered by tests. **Flag for follow-up:** the client SDK is not in this repo — note that the EIP-712 `DOMAIN`/`BEARER_TYPES` match must also be confirmed against the actual client SDK source, which this pass could not inspect.

- [ ] **Step 4: Commit**

```bash
cd /Users/stevejobs/code/latchkey
git add packages/proxy/test/auth.test.ts docs/superpowers/specs/2026-06-01-security-review-design.md
git commit -m "test: lock in EVM bearer token spoof + missing-field rejection (security review Area 1)"
```

---

## Task 2 — Area 2: pull-worker crash safety

**Files:**
- Read: `packages/proxy/src/puller.ts:65-117` (`processPulls`) and `src/db.ts:109-120` (`wallet_state` schema)
- Test: `packages/proxy/test/puller.test.ts`

**Map each spec scenario to existing coverage (verify against the file):**

| Spec scenario | Code path | Existing test |
|---------------|-----------|---------------|
| Crash **before** the `UPDATE … pending_pull_*` write | No pending row written; `accrued_usd` was committed at billing time, so debt survives and is retried next sweep | **Gap — add in Step 1** |
| Crash **after** the write, **before** broadcast | Step 1 selects `pending_pull_usd IS NOT NULL`, finds no receipt, re-broadcasts saved raw tx (same hash ⇒ no double-bill) | `puller.test.ts:121` "re-broadcasts the saved raw tx…" |
| Crash **after** broadcast, **before** `settle()` | Step 1 finds a confirmed receipt via `getReceipt` and settles without re-broadcast | `puller.test.ts:131` "settles directly when the in-flight tx already succeeded (no re-broadcast)" |

**Gap to fill:** no test proves the first scenario — that a crash *before* the pending-pull write leaves `accrued_usd` intact (debt not lost) and `pending_pull_usd` null, so the next sweep pulls cleanly.

- [ ] **Step 1: Write the failing test**

Add inside `packages/proxy/test/puller.test.ts`, in the `describe('processPulls — crash recovery (reconcile)', ...)` block:

```typescript
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

    // Next sweep with a healthy chain settles cleanly — no double-bill.
    await processPulls(db, mockChain(), OPTS)
    const settled = getWalletState(db, '0xcrash')!
    expect(settled.accrued_usd).toBeCloseTo(0, 10)
    expect(settled.total_pulled_usd).toBeCloseTo(0.12, 10)
  })
```

- [ ] **Step 2: Run the test**

Run:
```bash
cd packages/proxy && ~/.bun/bin/bun test test/puller.test.ts
```
Expected: PASS. If it FAILS (e.g. `accrued_usd` was mutated, or a pending row was left behind), that is a real crash-safety bug → stop and fix `puller.ts` before continuing.

- [ ] **Step 3: Write the Area 2 finding**

In the spec, under `## Area 2`, append a `**Findings:**` block: all three scenarios traced against the real `wallet_state`-column state machine; scenarios 2 and 3 covered by `puller.test.ts:121` / `:131`; scenario 1 now covered by the new test. Note the re-broadcast idempotency relies on `signPull` producing the same hash for the same `(nonce, payload)` — confirmed by the persist-before-broadcast invariant at `puller.ts:107-112`.

- [ ] **Step 4: Commit**

```bash
cd /Users/stevejobs/code/latchkey
git add packages/proxy/test/puller.test.ts docs/superpowers/specs/2026-06-01-security-review-design.md
git commit -m "test: cover crash-before-pending-write pull path (security review Area 2)"
```

---

## Task 3 — Area 3: dependency audit

**Files:**
- Read: `packages/proxy/package.json` (deps)
- Write: findings into the spec

- [ ] **Step 1: Run the audit and capture output**

Run:
```bash
cd packages/proxy && ~/.bun/bin/bun audit
```
Record the full output verbatim (you will paste it into the spec). Note the count of advisories by severity.

- [ ] **Step 2: Record the `@solana/web3.js` disposition**

`package.json` pins `@solana/web3.js` at `^1.98.4` — the **legacy 1.x** branch (the spec prefers the 2.x rewrite for reduced supply-chain surface). For this pass, **do not migrate** (that is a refactor, explicitly out of scope per the spec). Record the pinned version and the disposition: "1.x — accepted for this pass; 2.x migration is a separate future spec."

- [ ] **Step 3: Triage and fix high-severity findings only**

For each advisory in the Step 1 output:
- **High/critical:** fix by bumping the affected package to the patched range, then re-run `~/.bun/bin/bun audit` and `~/.bun/bin/bun test` to confirm green. Record the before/after.
- **Medium/low:** write a one-line disposition (accept / plan to fix / already mitigated). Do not bump.

If there are zero high/critical findings, record "no high-severity advisories" and skip the bump.

- [ ] **Step 4: Write the Area 3 finding**

In the spec, under `## Area 3`, append a `**Findings:**` block with: the verbatim `bun audit` summary, the `@solana/web3.js` version + disposition, and a per-finding disposition line for every medium/low advisory.

- [ ] **Step 5: Commit**

```bash
cd /Users/stevejobs/code/latchkey
git add packages/proxy/package.json packages/proxy/bun.lock docs/superpowers/specs/2026-06-01-security-review-design.md
git commit -m "chore: dependency audit findings + any high-severity bumps (security review Area 3)"
```
(If no `package.json`/lockfile changes were needed, only add the spec file.)

---

## Task 4 — Findings summary and Definition of Done

**Files:**
- Write: `docs/superpowers/specs/2026-06-01-security-review-design.md`

- [ ] **Step 1: Check off the Definition of Done**

In the spec's `## Definition of done` section, tick each box that the prior tasks satisfied:
```markdown
- [x] EVM sig check: documented as verified or fix + test committed
- [x] Crash safety: all three scenarios traced and documented or fixed
- [x] Dependency audit: `bun audit` output recorded; all high-severity findings resolved; dispositions written for medium/low
- [x] This spec updated with findings summary
```
Only tick a box if the corresponding Task actually completed; leave unticked + add a note for anything deferred (e.g. the client-SDK EIP-712 confirmation from Task 1 Step 3).

- [ ] **Step 2: Run the full suite one last time**

Run:
```bash
cd packages/proxy && ~/.bun/bin/bun test
```
Expected: all tests pass, including the cases added in Tasks 1 and 2.

- [ ] **Step 3: Commit**

```bash
cd /Users/stevejobs/code/latchkey
git add docs/superpowers/specs/2026-06-01-security-review-design.md
git commit -m "docs: security review findings summary + DoD (2026-06-01)"
```

---

## Notes on the phase-completion protocol (CLAUDE.md)

This plan covers the review work itself. Per `CLAUDE.md`, finishing a phase also requires: DeepSeek review of the changes, opening a PR for CodeRabbit, an independent ChatGPT review of the diff, reconciling findings + replying on inline comments, and a deploy + production E2E. Run those after Task 4 if this review is being treated as a phase. **No deploy is required if no production code changed** — if all three areas verified clean (tests only), the PR + reviews still apply but the deploy step is a no-op.
