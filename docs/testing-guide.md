# Latchkey — Teammate Testing Guide

## What is this?

Latchkey is an LLM marketplace proxy. Instead of signing up for Anthropic, OpenAI, or DeepSeek accounts and managing API keys, you authenticate with a **crypto wallet signature** and pay with **USDC on-chain** — no platform accounts, no stored payment methods, no API key sharing.

The proxy is live at `https://api.latchkey.me`. It speaks both the OpenAI and Anthropic API formats, so it's a drop-in replacement for anything that takes a base URL and an API key — Claude Code, Cursor, the OpenAI SDK, raw curl, etc.

**Why this matters:** The long-term vision is a permissionless marketplace where independent providers register their own inference endpoints and compete on price. You pay them directly via a pull-payment smart contract — the platform never holds your money. Your wallet is your identity; there's no signup.

**Current state:** Phase 2 billing is live. The proxy pulls USDC from your wallet on Base Sepolia (testnet) as you spend. The pull threshold is $0.01 — once your accrued debt crosses that, the pull worker settles on-chain automatically.

---

## What you're testing

- Auth: can you generate a wallet-signed token and get admitted?
- Allowance gate: does the proxy correctly reject a wallet with no USDC allowance, and admit one that has it?
- Routing: does the proxy route to the right provider for the model you asked for?
- Format compatibility: does it work from Claude Code / Cursor / curl as a drop-in?
- Billing: does your request show up in the dashboard, and does the pull worker settle it on-chain?

---

## Step 1 — Prerequisites

**Bun** (runtime for the token generator):
```bash
curl -fsSL https://bun.sh/install | bash
```

**Repo** (just for the token generator — you don't run anything locally):
```bash
git clone https://github.com/marvinmarnold/latchkey.git
cd latchkey && bun install
```

**A wallet on Base Sepolia with USDC.** You need:
1. An EVM wallet — export the private key (a burner wallet is fine)
2. Base Sepolia ETH for gas — get it from the [Coinbase Base Sepolia faucet](https://portal.cdp.coinbase.com/products/faucet)
3. Base Sepolia USDC (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`) — get it from [Circle's testnet faucet](https://faucet.circle.com) (select Base Sepolia)

---

## Step 2 — Approve USDC allowance

Before your first request, you must approve the billing contract to pull from your wallet. The minimum required is $0.01 (10,000 USDC atomic units). Approve more upfront if you plan to make many requests.

**Using cast (Foundry):**
```bash
read -s -p "Private key (0x...): " PK && echo
cast send 0x036CbD53842c5426634e7929541eC2318f3dCF7e \
  "approve(address,uint256)" \
  0x9DE2D0a4a360ff6D9280063C48Bee53C32fcb34e \
  1000000 \
  --rpc-url https://sepolia.base.org \
  --private-key "$PK"
```
This approves $1.00 (1,000,000 atomic units at 6 decimals), enough for ~100 cheap requests.

**Using a wallet UI (MetaMask, Rabby, etc.):** Connect to Base Sepolia, call `approve` on the USDC contract (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`) with the billing contract as spender (`0x9DE2D0a4a360ff6D9280063C48Bee53C32fcb34e`).

**Verify your allowance:**
```bash
curl -s https://api.latchkey.me/admin/allowance/0xYOUR_WALLET_ADDRESS | python3 -m json.tool
```

---

## Step 3 — Generate your bearer token

```bash
read -s -p "Private key (0x...): " PK && echo
cd packages/proxy
PK="$PK" bun -e "
import { encodeBearerToken } from './src/middleware/auth.ts';
const token = await encodeBearerToken(process.env.PK);
process.stdout.write(token);
"
```

This prints a token like `sk-ant-api03-...`. **Save it.** It's valid for 30 days. Your private key never leaves your machine — the token is just an EIP-712 signed message that proves you own the key.

---

## Step 4 — Make a request

### Option A — curl (Anthropic format)
```bash
curl https://api.latchkey.me/v1/messages \
  -H "x-api-key: sk-ant-api03-YOUR_TOKEN" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 100,
    "messages": [{"role": "user", "content": "Say hello in one sentence."}]
  }'
```

### Option B — curl (OpenAI format)
```bash
curl https://api.latchkey.me/v1/chat/completions \
  -H "Authorization: Bearer sk-ant-api03-YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Say hello in one sentence."}]
  }'
```

### Option C — Claude Code

Claude Code reads `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` from your environment. You need to set these **before** launching `claude`, and the easiest way to make them permanent is to add them to your shell config.

**1. Add to your shell config** (`~/.zshrc`, `~/.bashrc`, or equivalent):
```bash
export ANTHROPIC_BASE_URL=https://api.latchkey.me
export ANTHROPIC_API_KEY=sk-ant-api03-YOUR_TOKEN
```

**2. Reload your shell:**
```bash
source ~/.zshrc   # or source ~/.bashrc
```

**3. Make sure your wallet is funded and approved** (Steps 1–2 above must be complete):
- You have Base Sepolia ETH (gas) and USDC in your wallet
- You've run the `cast send approve` command to grant the billing contract a USDC allowance

**4. Launch Claude Code:**
```bash
claude
```

**5. Verify it's working** — after your first prompt, open https://payprompt-admin.vercel.app and find your wallet address in the usage table. If it's there, billing is wired up correctly.

> **Tip:** If `claude` launches but returns a 402 error, your allowance isn't set (Step 2). If it returns 401, your token is wrong or expired — regenerate it (Step 3).

### Option D — Cursor or any OpenAI-compatible client
Set base URL to `https://api.latchkey.me` and API key to your token.

---

## Available models

| Model ID | Routes to |
|---|---|
| `claude-sonnet-4-6`, `claude-opus-4-8`, any `claude-*` | Anthropic |
| `gpt-4o`, `gpt-4o-mini`, any `gpt-*` | OpenAI |
| `deepseek-ai/DeepSeek-V3` | DeepSeek |
| `deepseek-ai/DeepSeek-V4-Pro` | DeepSeek |
| `deepseek-ai/DeepSeek-V4-Flash` | DeepSeek |
| `deepseek-ai/DeepSeek-R1` | DeepSeek |

---

## Step 5 — Verify billing

Check your usage in the dashboard:
```bash
curl -s https://api.latchkey.me/admin/usage | python3 -m json.tool
```
Or: https://payprompt-admin.vercel.app

Your wallet address will appear with token counts and a USD cost. Once your accrued debt hits $0.01, the pull worker will settle on-chain automatically — you'll see `total_pulled_usd` increment.

---

## Troubleshooting

**402 — "Approve USDC allowance..."** — you haven't approved the billing contract yet, or your allowance is below $0.01. Complete Step 2.

**402 — "Wallet blocked"** — three consecutive on-chain pulls failed (usually insufficient USDC balance). Re-approve a larger allowance and ping Marvin to unblock the wallet.

**401 Unauthorized** — token is malformed or expired. Regenerate it (Step 3).

**502 Bad Gateway** — upstream provider error. Try a different model.

**Request succeeds but isn't in the dashboard** — wait 30s for the auto-refresh, or reload manually.
