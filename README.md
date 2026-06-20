# Latchkey

**One endpoint. One wallet. Every open-weight model.**

A crypto-native LLM marketplace proxy. Callers authenticate with a wallet signature instead of an API key, approve a one-time USDC allowance on Base, and make standard OpenAI or Anthropic API calls. The proxy routes to the cheapest available provider, logs billing to SQLite, and settles on-chain by pulling from the allowance. (A prepaid-deposit model — pay up front, draw down, auto-refill — is planned; see "What's built" below.)

Works out of the box with Claude Code, Cursor, the OpenAI SDK, and anything else that takes a base URL and an API key.

---

## What's built vs what's planned

### ✅ Phase 1 — Proxy (deployed)

- EIP-712 wallet-signed bearer tokens — no accounts, no signup, no gas
- OpenAI (`/v1/chat/completions`) and Anthropic (`/v1/messages`) endpoints, with format translation between both wire formats
- Cheapest-provider routing from a SQLite registry; provider discovery queries `/v1/models` on startup and creates listings automatically
- Streaming SSE passthrough with token usage extraction; per-request billing logged to SQLite
- Admin dashboard: `GET /admin/usage` (30-day aggregates by wallet/provider/model) + Next.js frontend at `payprompt-admin.vercel.app`
- Playwright E2E suite incl. full billing-loop verification
- Deployed at `https://api.latchkey.me` — Bun + Caddy on Ubuntu VPS
- **Known gaps (accepted for single-operator use):** unauthenticated admin endpoints, no rate limiting, plaintext provider API keys in SQLite.

### ✅ Phase 2 — Pull-payment billing (deployed)

- `LatchkeyBilling.sol` on Base Sepolia (`0x7ddF81666B5b0ABcF26eA1576aD257244eF2F9f9`). Callers `approve()` a USDC allowance once; a crash-safe background worker pulls when accrued debt crosses the threshold (`PULL_THRESHOLD_USD`, default $0.01).
- Per-wallet state in SQLite (`wallet_state`): accrued debt, settlement checkpoint, blocked flag.
- ⏳ **Hardening (built, on PR #8, pending redeploy):** 1% fee charged **on top** of the provider price; monotonic `settled[caller]` checkpoint for idempotent settlement (retries/overlaps can't double-charge); owner-**rotatable** `proxy`/`treasury`. The live `0x7ddF…` contract is the pre-hardening version — see `docs/DEPLOY.md` to redeploy.
- **Phase-1 mock note:** `BALANCE_CONTRACT_ADDRESS` stays empty (the legacy custodial-vault read). The pull-payment gate runs off `BILLING_CONTRACT_ADDRESS`.

### 🔜 Planned — Prepaid deposit model

- Flip from postpaid (use-then-pull) to prepaid: after the user approves an allowance, the proxy collects a deposit up front, gates usage until paid, draws the deposit down per request, and auto-refills before it runs out. Non-custodial (reuses `LatchkeyBilling`). Design TBD in a spec.

### 🔲 Phase 3 — zkTLS proof (stub)

- `tls_proof_queue` table + background worker exist; no prover integrated.
- Needed to prove API-delegating providers actually called the upstream. Blocked on a production-ready prover library (TLSNotary, Reclaim, zkPass all pre-production as of mid-2026).

### ✅ Phase 4 — Model fingerprinting (running, no enforcement)

- Fingerprint probes run on startup and every 6h; response hash drift is logged. No slashing yet (needs a staking contract).

### ✅ Phase 5 — Solana rail (auth live, billing mocked)

- ed25519 bearer-token auth is live. On-chain Solana billing is intentionally mocked (`SOLANA_BILLING_ENABLED` unset) until a Solana program is deployed — Solana callers currently pay nothing.

---

## Quickstart (local dev)

**Prerequisites:** [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`)

```bash
git clone https://github.com/marvinmarnold/latchkey.git
cd latchkey
bun install

cp packages/proxy/.env.example packages/proxy/.env
# Edit packages/proxy/.env — fill in at least one of:
#   ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, or OPENAI_API_KEY

cd packages/proxy
bun run dev
# → Latchkey proxy running on http://localhost:3000
```

### Generate a bearer token

```bash
cd packages/proxy
bun -e "
import { encodeBearerToken } from './src/middleware/auth.ts'
const token = await encodeBearerToken('0xYOUR_PRIVATE_KEY')
console.log(token)
"
```

### Test it

```bash
curl http://localhost:3000/health

curl -s http://localhost:3000/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: <YOUR_TOKEN>' \
  -d '{"model":"claude-haiku-4-5-20251001","messages":[{"role":"user","content":"Say hi."}],"max_tokens":20}'
```

### Use with Claude Code

```bash
source .env.client   # sets ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY
claude
```

### Run tests

```bash
cd packages/proxy && bun test

# E2E (local — spins up proxy + admin automatically):
cd packages/e2e && npx playwright test

# E2E (production):
cd packages/e2e
E2E_PROXY_URL=https://api.latchkey.me \
E2E_ADMIN_URL=https://payprompt-admin.vercel.app \
E2E_BEARER_TOKEN=<token> \
npx playwright test
```

---

## How requests flow

```
Caller (agent or developer)
  │  Authorization: Bearer <EIP-712 signed token>  or  x-api-key: <token>
  ▼
Proxy
  ├─ Verify token signature (viem EIP-712)
  ├─ Gate on allowance       ← mock-passes while BILLING_CONTRACT_ADDRESS is empty
  ├─ Normalise format        ← Anthropic → OpenAI if needed
  ├─ Select listing          ← cheapest active listing for model (SQLite)
  ├─ Forward request         ← streaming SSE passthrough
  ├─ Translate response      ← OpenAI → Anthropic if needed
  └─ Log billing             ← extract token usage, write to SQLite
```

---

## Bearer token format

```ts
type BearerToken = {
  address: string  // EVM wallet address (0x...)
  expiry:  number  // Unix timestamp
  nonce:   string  // random hex
  sig:     string  // EIP-712 signature
}
// base64(JSON.stringify(token))
// Passed as: Authorization: Bearer <token>  (OpenAI format)
//        or: x-api-key: <token>             (Anthropic format)
```

---

## Project layout

```
packages/proxy/        Bun/Elysia proxy server (auth, routing, billing, pull worker)
packages/admin/        Next.js admin dashboard (Vercel)
packages/e2e/          Playwright E2E tests
packages/contracts/    Solidity smart contracts (Foundry) — LatchkeyBilling.sol
packages/indexer/      Ponder on-chain event indexer
packages/devbox/       Provider devbox (see packages/devbox/CONTEXT.md)
deploy/                Server deploy + sync + deployment-validation scripts
docs/                  Design specs, ADRs, DEPLOY.md, testing-guide.md
```

## Deploying

See **[`docs/DEPLOY.md`](docs/DEPLOY.md)** for the full runbook — redeploying the contract,
syncing the server `.env`, restarting the proxy, and the admin dashboard. Every environment
variable is annotated in **`packages/proxy/.env.example`**.

## Stack

| | |
|---|---|
| **Runtime** | Bun — TypeScript natively, built-in SQLite |
| **HTTP** | Elysia — Bun-native framework |
| **Auth** | viem — EIP-712 signing and recovery |
| **Storage** | SQLite (`bun:sqlite`) |
| **Chain** | Base (EVM) — phase 2 onwards |
| **Admin** | Next.js 15 + Recharts on Vercel |
| **Reverse proxy** | Caddy — automatic HTTPS via Cloudflare DNS |
