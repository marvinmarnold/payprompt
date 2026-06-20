# Deploying Latchkey

This is the "I haven't touched this in a while — how do I ship it" runbook. There are four
deployable pieces; you rarely need all four at once.

| Piece | Where it runs | When you redeploy it |
|-------|---------------|----------------------|
| **LatchkeyBilling** contract | Base Sepolia | When the Solidity changes (e.g. the fee/idempotency/rotatable hardening) |
| **Proxy** | Ubuntu VPS (`api.latchkey.me`) | When `packages/proxy` changes |
| **Admin dashboard** | Vercel (`payprompt-admin.vercel.app`) | When `packages/admin` changes (auto-deploys on push to `main`) |
| **`.env` on the server** | VPS | Whenever a value in `packages/proxy/.env` changes (esp. `BILLING_CONTRACT_ADDRESS`) |

Everything below targets **Base Sepolia** (testnet). All config lives in `packages/proxy/.env`
(gitignored). See `packages/proxy/.env.example` for the annotated list of every variable.

---

## The three "proxy" things people confuse

| Name | What it is | Used when |
|------|-----------|-----------|
| `PROXY_PRIVATE_KEY` | The proxy operator's **private** key. The running proxy signs `pull()` txs with it. | Runtime |
| `PROXY_ADDRESS` | The **address** of that same key (`privateKeyToAccount(PROXY_PRIVATE_KEY).address`). Passed as the contract's `proxy` constructor arg. | Contract deploy |
| deployer key | Any **separately funded** wallet (Base Sepolia ETH) that pays gas to send the deploy tx. Becomes neither owner nor proxy. | Contract deploy |

And the other two deploy-time addresses:
- `TREASURY_ADDRESS` — receives the 1% fee. **Keep it distinct from `PROXY_ADDRESS`** (today they're equal, so the fee isn't actually separated).
- `OWNER_ADDRESS` — a **cold** key/multisig that can later rotate `proxy`/`treasury`. Separate from the hot proxy key. Required at deploy.

---

## A. Redeploy the contract

**Prereqs:** [Foundry](https://book.getfoundry.sh/) installed; a deployer wallet funded with Base
Sepolia ETH ([faucet](https://docs.base.org/docs/tools/network-faucets)).

Fill these into `packages/proxy/.env` (all annotated in `.env.example`) — then deploy with **one
command, no inline vars**:

| `.env` key | What it is |
|------------|-----------|
| `TREASURY_ADDRESS` | receives the 1% fee — keep distinct from the proxy |
| `OWNER_ADDRESS` | cold key/multisig that can rotate proxy/treasury |
| `DEPLOYER_PRIVATE_KEY` | pays gas (optional — defaults to `PROXY_PRIVATE_KEY`) |
| `USDC_ADDRESS`, `BASE_RPC_URL`, `PROXY_PRIVATE_KEY` | already set for normal operation |

```bash
bash deploy/deploy-contract.sh        # or: bun run deploy:contract
# Reads packages/proxy/.env, derives `proxy` from PROXY_PRIVATE_KEY, broadcasts.
# → logs "LatchkeyBilling deployed at: 0xNEW..."
```

Then **record the new address in two places** (both required):
1. `packages/contracts/README.md` — the deployed-addresses table.
2. `packages/proxy/.env` — `BILLING_CONTRACT_ADDRESS=0xNEW...`.

**Validate it** (forge unit suite + on-chain wiring/ABI checks):
```bash
bash deploy/validate-deployment.sh        # expect: PASS
```

> ⚠️ A redeploy changes the contract address, so **every user must `approve()` USDC to the new
> address** — old approvals point at the old contract. The proxy's SQLite schema auto-migrates on
> restart (no manual step); `settled[caller]` starts fresh at 0 on the new contract.

---

## B. Redeploy the proxy + sync the server `.env`

```bash
# 1. Push the new BILLING_CONTRACT_ADDRESS (and any other .env changes) to the server.
bash deploy/sync-env.sh

# 2. Pull the latest code on the box and restart the service.
ssh -i ~/.ssh/id_ed25519 root@151.247.22.152 \
  "cd /root/latchkey && git fetch origin && git checkout -B main origin/main && systemctl restart latchkey-proxy"

# 3. Confirm billing is live.
curl -sf https://api.latchkey.me/admin/usage \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d['byWallet']),'wallet entries')"
```

> ⚠️ The #1 deploy footgun (per `CLAUDE.md`): skipping `sync-env.sh` leaves the server on a stale
> `BILLING_CONTRACT_ADDRESS`, which silently breaks billing. Always sync after changing the address.

For a **fresh VPS** (provisioning Bun, Caddy, systemd, DNS) use `bash deploy/deploy.sh` instead —
it needs `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PASSWORD`, and `CLOUDFLARE_API_TOKEN` in `.env`.

---

## C. Admin dashboard (Vercel)

`@latchkey/admin` auto-deploys from `main` on push. If you changed the billing contract, also update
`BILLING_CONTRACT_ADDRESS` / `USDC_ADDRESS` in the **Vercel project env**, then redeploy.

---

## Order of operations

`A` (deploy + record + validate) → `B` (sync-env + restart) → `C` (only if admin changed).
Skipping the address update or `sync-env.sh` is the usual cause of "I deployed but nothing shows up."
