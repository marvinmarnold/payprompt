# Claude Instructions — Latchkey

## Phase completion protocol (mandatory for every phase)

When finishing any phase of work, always follow these steps in order. Do NOT skip any step and do NOT wait for the user to ask.

### 1. TDD (Red → Green)
Build every phase test-first: write failing tests first, then implement until they pass. No feature code without a failing test first.

### 2. DeepSeek review
After all tests are green, call the DeepSeek API to review the implementation:
```bash
curl -s https://api.deepseek.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(grep DEEPSEEK_API_KEY packages/proxy/.env | cut -d= -f2)" \
  -d '{"model":"deepseek-chat","temperature":0.3,"messages":[{"role":"system","content":"You are a senior backend engineer. Be direct, flag real problems only."},{"role":"user","content":"<describe what was just built>"}]}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['choices'][0]['message']['content'])"
```
Go back and forth until agreement is reached. Fix real findings before continuing.

### 3. Open a PR
Push branch, open a GitHub PR with a clear title and summary. Wait for CodeRabbit to post its automated review (usually within a few minutes of the push).

### 4. ChatGPT independent review
Use the OpenAI API to review the same diff independently — separate from CodeRabbit. Compare both sets of findings:
```bash
# Get the diff for review
git diff main...HEAD -- '*.ts' '*.sol' | head -500
```
Then call OpenAI (capture the diff first, then embed it):
```bash
DIFF=$(git diff main...HEAD -- '*.ts' | head -500)
OPENAI_KEY=$(grep OPENAI_API_KEY packages/proxy/.env | cut -d= -f2)
curl -s https://api.openai.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_KEY" \
  -d "{\"model\":\"gpt-4o\",\"temperature\":0.3,\"messages\":[{\"role\":\"system\",\"content\":\"You are a senior backend engineer reviewing a TypeScript pull request. Be direct, flag real correctness and security issues only. Ignore style. Max 300 words.\"},
{\"role\":\"user\",\"content\":$(echo "$DIFF" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')}]}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['choices'][0]['message']['content'])"
```

### 5. Consensus and PR comments
Compare CodeRabbit and ChatGPT findings. For each finding:
- If both agree it's valid: fix it
- If one flags it and it's clearly correct: fix it
- If stale/already-fixed/intentional-design: skip it
- Post a reply comment on every CodeRabbit inline comment explaining what was done (fixed or skipped with reason)

### 6. Iterate
Keep fixing and re-running `bun test` + E2E until all tests pass and all meaningful review findings are addressed.

### 7. Deploy
```bash
bash deploy/sync-env.sh
ssh -i ~/.ssh/id_ed25519 root@151.247.22.152 "cd /root/latchkey && git fetch origin && git checkout -B ma/<N> origin/ma/<N> && systemctl restart latchkey-proxy"
```
Run production E2E to confirm green.

---

## Private key rule — NEVER commit secrets to source control

Private keys, API keys, passwords, and any credentials must NEVER appear in any source-controlled file — not in test files, not in HTML, not in scripts, not in docs, not in session summaries.

- All secrets live in `.env` files that are gitignored
- Test files must read keys via `process.env.KEY_NAME` — never hardcode
- Before committing, scan for raw 0x-prefixed hex keys, base58 seeds, or any `sk-`/`Bearer` patterns
- If a key is ever found in git history, treat it as permanently compromised and rotate it immediately

**Why this rule exists:** PROXY_PRIVATE_KEY and TEST_PRIVATE_KEY were both committed to a public repo (in session-summary.html and global-setup.ts respectively). Both had to be rotated and the billing contract redeployed.

---

## Review rule — always verify with DeepSeek before finishing a phase

Before declaring any phase of work done, call the DeepSeek API to review the implementation (see Phase completion protocol above).

Do NOT add net-new features (encryption, retries, rate limits, security hardening) proactively. The priority is getting the core architecture right. These can be layered on later without refactoring.

---

## Contract deployment rules (read before every contract deploy)

**After every `forge script` contract deployment, always do all three — in order:**
1. Record the new address in `packages/contracts/README.md` (deployed-addresses table) **and** in `packages/proxy/.env` (`BILLING_CONTRACT_ADDRESS`). The README table is the source of truth; never leave a stale address.
2. Run `bash deploy/validate-deployment.sh` — it runs the forge unit suite, then validates the live deployment's wiring + ABI on-chain (and an optional real pull). It exits non-zero on any mismatch; treat a non-zero exit as a failed deploy.
3. Run `bash deploy/sync-env.sh` so the server picks up the new `BILLING_CONTRACT_ADDRESS`.

`OWNER_ADDRESS` must be a cold key/multisig separate from the hot `PROXY_ADDRESS`. Keep `TREASURY_ADDRESS` distinct from `PROXY_ADDRESS` so the 1% fee is genuinely separated (the pre-hardening testnet deploy had them equal).

---

## Deployment rules (read before every server change)

**After any `git pull + systemctl restart` on the server, always also run:**
```bash
bash deploy/sync-env.sh
```
Quick deploys do NOT rewrite the server `.env`. Stale values (especially `BALANCE_CONTRACT_ADDRESS`) will silently break requests. `sync-env.sh` reads `packages/proxy/.env` locally and writes it to the server over SSH.

**`BALANCE_CONTRACT_ADDRESS` must be empty in phase 1.** If it has a value, the proxy checks on-chain USDC balance, which returns 0 for any unfunded wallet → 402 → no billing → admin dashboard shows nothing. Phase 1 uses mock mode (always passes). Only set a contract address when the funding flow is tested end-to-end.

**Admin dashboard auto-refreshes every 30s** — but a manual reload always works too. If you just made requests and don't see them, wait 30s or reload.

**Verify a deploy worked:** after restarting the service, make a real request and confirm the billing log updated:
```bash
curl -sf https://api.latchkey.me/admin/usage | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d['byWallet']), 'wallet entries')"
```

**Full production E2E** (run this after any proxy change):
```bash
cd packages/e2e
E2E_PROXY_URL=https://api.latchkey.me \
E2E_ADMIN_URL=https://payprompt-admin.vercel.app \
E2E_BEARER_TOKEN=$(cd ../proxy && ~/.bun/bin/bun -e "import{encodeBearerToken}from'./src/middleware/auth.ts';process.stdout.write(await encodeBearerToken('$(grep TEST_PRIVATE_KEY packages/proxy/.env | cut -d= -f2)'))") \
npx playwright test
```
The billing loop test (`Billing loop › a proxied request appears in /admin/usage`) makes a real POST and polls until billing is confirmed. If it fails, something in the auth→routing→billing chain is broken.

---

## Adding a new environment variable

All four steps are required for **app/provider vars** (API keys the proxy uses). Missing any one silently breaks something.

1. **`packages/proxy/src/db.ts`** — read it via `process.env.VAR ?? null` in `seedProviders()`
2. **`docker-compose.yml`** — add `VAR: ${VAR:-}` to the `environment` block
3. **`packages/proxy/.env.example`** — document it with an empty value (under the right section heading)
4. **`deploy/sync-env.sh`** — add the var to the heredoc so it's written to the server on every sync

**Exception — infrastructure-only vars** (e.g. `CLOUDFLARE_API_TOKEN`, `DEPLOY_PASSWORD`): skip steps 1 and 2. Only add to `.env.example` and handle in `deploy/deploy.sh` / `deploy/sync-env.sh`.

---

## Phase status

| Phase | Status | Notes |
|-------|--------|-------|
| 1 — Proxy | ✅ deployed, tested | EVM-only auth. `BALANCE_CONTRACT_ADDRESS=` (mock) |
| 2 — Pull-payment billing | ✅ deployed; ⏳ hardening redeploy pending | Live contract `0x7ddF81666B5b0ABcF26eA1576aD257244eF2F9f9` (Base Sepolia) is the **pre-hardening** version. The fee-on-top + cumulative-idempotent + rotatable-roles version is built/tested but **not yet deployed**. Deployed-address source of truth: `packages/contracts/README.md`. Pull worker active ($0.01 threshold). Proxy wallet: `0xe7Ce0c8cFD304A6aB8Dc51d1B9FA50E15C2c5f6D` |
| 3 — zkTLS | 🔲 stub only | Proof queue exists; no prover integrated (no production library available mid-2026) |
| 4 — Fingerprinting | ✅ running | Logs mismatches; no slashing yet |
| 5 — Solana rail | ✅ deployed | ed25519 bearer token auth live; on-chain Solana billing intentionally in mock mode (`SOLANA_BILLING_ENABLED` not set) — Solana callers pay nothing until a Solana program is deployed |

---

## Key file locations

| What | Where |
|------|-------|
| Local credentials / API keys | `packages/proxy/.env` (gitignored) |
| Claude Code client token | `.env.client` (gitignored) |
| Server env sync script | `deploy/sync-env.sh` |
| E2E tests | `packages/e2e/` |
| Admin dashboard | `packages/admin/` → https://payprompt-admin.vercel.app |
| Proxy entry | `packages/proxy/src/index.ts` |
| Auth (EVM + Solana token verify) | `packages/proxy/src/middleware/auth.ts` |
| Balance check | `packages/proxy/src/middleware/balance.ts` |
