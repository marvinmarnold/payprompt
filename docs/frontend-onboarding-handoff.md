# Handoff — Wallet-Onboarding Frontend

_Date: 2026-06-19_

**You're building:** a browser frontend that onboards a user's wallet to the Latchkey proxy using
**in-browser signing** (MetaMask / injected / WalletConnect) — no private keys are ever pasted. This
replaces the CLI flow (`encodeBearerToken(privateKey)` in `packages/proxy/src/middleware/auth.ts`)
with the connected wallet signing the same EIP-712 payload in the browser.

> The CLI uses `TEST_PRIVATE_KEY` for dev. Your frontend signs with the **user's** browser wallet —
> same protocol, the key just never leaves the wallet. Use the test wallet below for your own testing.

## What "onboarding" produces

1. **A USDC allowance** approved to the billing contract (so the proxy can pull payment).
2. **A bearer token** — an EIP-712 signature the user presents to the proxy as their API key.

With those two, the user can call the proxy (via their own tools) and you can show a credits/usage dashboard.

## Constants (Base Sepolia, current deployment)

| Thing | Value |
|------|-------|
| Proxy base URL | `https://api.latchkey.me` |
| Network | Base **Sepolia** — chainId `84532`, RPC `https://sepolia.base.org` |
| USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (6 decimals) |
| Billing contract (`LatchkeyBilling`) | `0x9DE2D0a4a360ff6D9280063C48Bee53C32fcb34e` |
| Min allowance to pass the gate | `10000` atomic = **$0.01** (recommend approving ≥ `1000000` = $1) |
| Token prefix | `sk-ant-api03-` |

> Addresses change on redeploy — source of truth is `packages/contracts/README.md` and
> `BILLING_CONTRACT_ADDRESS` in `packages/proxy/.env`. Make them configurable, not hardcoded.

## ⚠️ The #1 gotcha: EIP-712 domain `chainId` is a CONSTANT `8453`, not the connected chain

The proxy verifies tokens against a **fixed** domain (`packages/proxy/src/middleware/auth.ts`):

```ts
const DOMAIN = { name: 'Latchkey LLM Marketplace', version: '1', chainId: 8453 } // Base MAINNET id — intentional constant
const TYPES  = { BearerToken: [
  { name: 'address', type: 'address' },
  { name: 'expiry',  type: 'uint256' },
  { name: 'nonce',   type: 'string'  },
] }
```

Even though the wallet is connected to Base **Sepolia** (`84532`) for the approve tx, you must sign the
token with `chainId: 8453`. `signTypedData` is just signing data — it does **not** require being on that
chain. If you pass the connected chainId, signature recovery on the proxy fails → `401`.

## Onboarding flow (with viem sketches)

Recommended stack: **wagmi + viem** (the repo uses viem, so the token logic mirrors the server 1:1).
RainbowKit/ConnectKit optional for the connect UI.

### 1. Connect wallet, ensure Base Sepolia
Prompt connect; if `walletClient.chain.id !== 84532`, request a switch/add (`wallet_switchEthereumChain`
/ `wallet_addEthereumChain` with the RPC above). Needed for the approve tx in step 2.

### 2. Ensure a USDC allowance to the billing contract
```ts
import { erc20Abi } from 'viem'
const allowance = await publicClient.readContract({
  address: USDC, abi: erc20Abi, functionName: 'allowance', args: [user, BILLING],
})
if (allowance < 1_000_000n) {
  await walletClient.writeContract({          // on-chain tx → needs ETH for gas
    address: USDC, abi: erc20Abi, functionName: 'approve', args: [BILLING, 1_000_000n],
  })
}
```
(Or read the allowance from the proxy: `GET /admin/allowance/:address` → `{ "allowance_atomic": "…" }`, CORS-open.)

### 3. Generate the bearer token (in-browser EIP-712 signing)
```ts
const TOKEN_PREFIX = 'sk-ant-api03-'
async function makeToken(walletClient, user: `0x${string}`) {
  const expiry = Math.floor(Date.now() / 1000) + 30 * 24 * 3600          // unix seconds, future
  const nonce = [...crypto.getRandomValues(new Uint8Array(16))]
    .map(b => b.toString(16).padStart(2, '0')).join('')
  const sig = await walletClient.signTypedData({
    account: user, domain: DOMAIN, types: TYPES, primaryType: 'BearerToken',
    message: { address: user, expiry: BigInt(expiry), nonce },
  })
  const token = { address: user, expiry, nonce, sig }
  return TOKEN_PREFIX + btoa(JSON.stringify(token))                       // base64(JSON) + prefix
}
```
This is byte-for-byte what `encodeBearerToken` produces server-side. Hand the resulting
`sk-ant-api03-…` string to the user (and/or store it for your dashboard's API calls).

### 4. Use / verify
- The user puts the token in their client: `x-api-key: <token>` (Anthropic) or
  `Authorization: Bearer <token>` (OpenAI), base URL `https://api.latchkey.me`.
- Your dashboard reads usage from `GET /admin/usage` (CORS-open) filtered to the connected address,
  and payment history from on-chain `Pulled(address indexed caller, uint256 cumulativeService, uint256 delta, uint256 fee)`
  events on the billing contract (`delta+fee` = what the user paid that settlement).

## CORS — important constraint

Only `/admin/*` sends `Access-Control-Allow-Origin: *`. **`/v1/messages` and `/v1/chat/completions` do
NOT** — a browser SPA on another origin **cannot POST to them directly**. So:
- **Onboarding + dashboard work fully in the browser** (admin endpoints are CORS-open; on-chain reads and
  signing are local). ✅
- **In-browser chat does not** without a server change. Either (a) hand the token to the user for their
  own client (simplest, matches the product), or (b) ask the proxy team to add CORS to `/v1/*`, or (c)
  add a tiny same-origin relay. Decide this early.

## Funding (testnet)
The frontend can't mint funds. Link users to faucets and tell them they need both:
- **ETH (gas)** — [Coinbase Base Sepolia faucet](https://portal.cdp.coinbase.com/products/faucet)
- **USDC** — [Circle faucet](https://faucet.circle.com) (select Base Sepolia)

## Gate behavior (so your UX matches the backend)
- Allowance **< $0.01** → the proxy returns **402** before running the request. Block onboarding completion until the approve confirms.
- Token wrong/expired → **401**. Regenerate.
- USDC balance of `0` → the user is admitted but the background settlement (pull) fails; after repeated
  failures the wallet is blocked. So make funding USDC part of onboarding, not an afterthought.

## "Remaining credits" (product decision already made)
We decided credits = **approved allowance − used**. `used` = on-chain `settled(caller)` (cumulative
pulled) read from the billing contract; allowance from USDC/`/admin/allowance`. Remaining =
`allowance − settled`, plus an "approve more" CTA. (A future prepaid-deposit model would change this —
see `docs/superpowers/specs/` — but it isn't built.)

## Security notes
- Never touch the private key — the wallet signs; you only handle the resulting token.
- The bearer token **can spend against the user's allowance until `expiry`** — treat it like an API key.
  Consider a shorter expiry for web sessions (the 30-day default is for CLI convenience).

## Reference files in this repo
- `packages/proxy/src/middleware/auth.ts` — canonical `DOMAIN`, `BEARER_TYPES`, `encodeBearerToken`, `TOKEN_PREFIX`. **Mirror this exactly.**
- `packages/proxy/src/admin.ts` / `index.ts` — the `/admin/usage`, `/admin/wallets`, `/admin/allowance/:address` endpoints + their CORS.
- `packages/contracts/src/LatchkeyBilling.sol` — `Pulled` event + `settled(address)` getter for the dashboard.
- `docs/testing-guide.md` — the equivalent CLI flow, end to end.

## Dev/test
Test wallet (from `TEST_PRIVATE_KEY`): `0xe20c53Db98DC5faFF1114D9e56f3Dc4b006D1786`. As of this writing it
has gas but **0 USDC and 0 allowance** — fund + approve it (see `docs/testing-guide.md`) to exercise the
full loop against `https://api.latchkey.me`.

## Suggested deployment (from earlier design discussion)
Static SPA → GitHub Pages (repo is public) on a custom domain (e.g. `app.latchkey.me`). TanStack Router +
TanStack Query were the chosen libraries. Fully serverless: all data is on-chain or from the CORS-open
admin API. Not started — this is your build.
