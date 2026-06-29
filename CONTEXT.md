# Latchkey and bitllm: Glossary

This repo produces two outputs (see `docs/adr/0005`): **bitllm**, a protocol for serving LLM inference, and **latchkey**, an application built on it.

## bitllm
A protocol for serving LLM inference.
Any host can run bitllm to expose a URL that answers inference requests, analogous to bittorrent for files or git for version history.
A bitllm host speaks an OpenAI-compatible wire format.
bitllm is open: anyone can run a host, and applications other than latchkey could be built on it.
_Avoid_: server, daemon (bitllm is the protocol; a host is one instance of it).

## latchkey
An application built on bitllm, analogous to what GitHub is to git: a marketplace plus admin panel.
latchkey aggregates bitllm hosts, routes each Caller request to the cheapest suitable Listing, and settles billing on-chain.
latchkey also runs a bitllm server itself, so a Provider can sell inference without running any infrastructure (see Provider).
On the consume side, latchkey proxies Callers that follow terms of service.

## Marketplace
The latchkey feature set that lets independent Providers register inference and prices, and routes Caller requests to the cheapest Listing.
Providers compete on price (v1) and eventually on quality heuristics (v2).

Long-term policy: open-weight models only, where community inference does not violate terms of service. Proprietary APIs (OpenAI, Anthropic, etc.) are not technically blocked — the platform imposes no enforcement — but are excluded by marketplace policy. During development and testing, proprietary APIs may be registered as ordinary Providers to validate routing, billing, and format translation before open-weight providers are available.

## Provider
An entity that serves inference for one or more Models and registers listings with the Marketplace. A Provider's canonical identity is the EVM **wallet** that registered it: one wallet owns exactly one Provider, only that wallet may manage the Provider's Listings, and that wallet is also the Provider's payout address. The name and active flag are a human-readable label and a kill-switch, not an identity. (Operator-seeded Providers — e.g. the dev seed's TwoShoes and BigThought — predate self-onboarding, carry no wallet, and are operator-managed rather than self-service.) The routing details (endpoint, API key, price, reliability) live on each individual Listing, not on the Provider entity itself. A single Provider may hold listings that use different upstream services and different API keys. Dev seed includes two Providers: **TwoShoes** (DeepSeek + Anthropic listings) and **BigThought** (OpenAI listings).

A Provider serves inference in one of two ways:

- **bitllm host**: the Provider runs their own bitllm host (vLLM, Ollama, llama.cpp, or any OpenAI-compatible server) and registers its URL. latchkey routes to it and holds no credential for it. (Previously called "self-hosted".)
- **latchkey-hosted**: the Provider uploads an upstream API key and pricing, and latchkey runs bitllm on their behalf, so they need no infrastructure. latchkey custodies the uploaded key, encrypted at rest. (Previously called "API-delegating".)

## Connection
The unit a Provider registers: an **(endpoint, wire format, credential)** the Provider exposes to the Marketplace. The Marketplace discovers the Models served on a Connection and creates one **Listing** per Model — Providers register Connections, not individual Listings. Pricing is **not** set on a Connection; it is set per Listing (per Model). A Provider may hold many Connections (a delegated DeepSeek key and a self-hosted vLLM box are two Connections under one wallet).

- **latchkey-hosted Connection**: the credential is the Provider's own upstream API key, custodied by latchkey encrypted at rest.
- **bitllm-host Connection**: no upstream credential (the Provider's own bitllm host holds it); an optional proxy-secret lets that host confirm a request came from latchkey.

_Avoid_: integration, account, upstream (used adjectivally elsewhere).

## Listing
A single Model offered by a Provider through one of its Connections, at a specific price. Inherits its endpoint, wire format, and credential from the Connection; carries the input/output prices (in **dollars per million tokens**), context length, provider-side model ID, reliability score, and active flag. Pricing is per Listing and **required** — there is no Connection-level default, so a freshly discovered Listing is **not routable until its Provider sets its price** (and it is active). The unit of routing: the Router selects a Listing, not a Provider. A Listing is only routable when both its own active flag and its Provider's active flag are true.

`upstream_format` declares what wire format the provider endpoint speaks: `openai` (default — covers DeepSeek, Together AI, self-hosted vLLM, etc.) or `anthropic`. The forwarder uses this to decide whether to send the internal OpenAI-format request as-is or convert it to Anthropic format at egress.

## Model
A model identified by a string ID that Callers put in the `model` field. The Router matches this against Listings using two strategies, in order: (1) exact `model_id` match — used for specific models with their own pricing; (2) prefix match against `model_prefix` — used for vendor-wide Listings that cover an entire catalogue at a single tier price. Convention: open-weight models use their HuggingFace repo ID (e.g. `meta-llama/Llama-3.1-70B-Instruct`); the platform does not enforce any scheme for proprietary models.

## Caller
The primary Caller is an Agent — autonomous software that POSTs to the proxy endpoint without human in the loop. Developers (humans) are secondary callers who use the same endpoint with a manually controlled wallet. No developer dashboard in v1.

Callers authenticate via a signed Bearer Token. Auth header conventions differ by API Format — the proxy accepts both `Authorization: Bearer <token>` (OpenAI convention) and `x-api-key: <token>` (Anthropic convention).

## API Format
The request/response schema a Caller uses to interact with the proxy. The proxy exposes multiple API Format endpoints and normalises all inbound requests to OpenAI format internally before routing to Providers (who always expose OpenAI-compatible endpoints). Responses are translated back to the Caller's original format before returning.

Supported formats (v1): OpenAI (`/v1/chat/completions`), Anthropic (`/v1/messages`).

The internal normalisation layer translates between formats. LiteLLM is excluded as a dependency (supply chain risk); translation is implemented directly or via a vetted alternative.

## Router
The component that, given a user-specified Model, selects the cheapest available Listing serving that Model (v1). Future versions (v2) will route on heuristics beyond cost (latency, reliability score, benchmark quality).

Listings are deprioritised (not slashed) for downtime — the Router scores reliability per Listing over time and routes away from unreliable Listings without on-chain penalties.

## Model Verification
The process by which the Marketplace confirms a Provider is serving the declared Model (HF repo ID).

Two mechanisms run in combination:
- **Fingerprinting** — at onboarding, the Marketplace runs a lightweight behavioural fingerprint check (known token probability signatures for the declared model) to confirm model identity before the Provider is listed.
- **Challenge Sampling** — post-listing, the Marketplace periodically sends known prompts on a randomised schedule and statistically checks responses against expected model behaviour. Catches bait-and-switch after approval.

A Provider caught serving a different model than declared is slashed and delisted. Slashed stake funds dispute resolution.

## Protocol Fee
1% of each pull settlement, taken at the smart contract level. Callers pay the Provider's listed token price; `LatchkeyBilling.pull()` routes 99% to the proxy operator and 1% to the protocol treasury. No spread or markup on top of Provider pricing.

## Stake
USDC deposited by a **Provider** before listing on the Marketplace. Slashed (partially or fully forfeited) only for provable fraud — serving a different model than declared, or overbilling. Downtime is not a slashable offence; it affects the Provider's Router score instead. No protocol token in v1. _Not_ to be used for the Caller side — a Caller posts a **Caller Deposit**, which is never slashed.

## Caller Deposit
> **Status: not yet built.** The deployed contract (`LatchkeyBilling`) still uses the allowance-gate model (ADR 0004). This definition describes the target architecture.

USDC a **Caller** deposits into the billing contract before using the proxy — credit collateral, never a fraud bond and never slashed. Minimum deposit **$1**. It bounds how much inference the proxy will front before settling on-chain: at any moment a Caller may have at most `min(deposit − used, PULL_THRESHOLD_USD)` of unsettled (fronted) usage — the smaller of their remaining deposit and the pull threshold; beyond that the proxy settles or returns 402. The Caller withdraws unused deposit subject to outstanding **Accrued Debt** being settled first. Distinct from a Provider's slashable Stake in actor, purpose, and fate.

## Session
> **Status: the Session definition below reflects the target Caller Deposit model (not yet built). The deployed proxy uses an allowance gate; see ADR 0004.**

The active billing period for a Caller — the window during which the Caller has a sufficient **Caller Deposit** held by the billing contract and their wallet is not blocked. No discrete on-chain open/close event; the Session is a soft construct defined by the presence of a sufficient deposit. Inference requests accrue debt off-chain and the proxy settles on-chain against the deposit (see **Caller Deposit** for the `min(deposit − used, PULL_THRESHOLD_USD)` fronting cap, and **Pull Threshold**). If an on-chain settlement fails three consecutive times, the wallet is blocked and the next request returns HTTP 402.

(Historical note: v1 as deployed defines the Session by a sufficient USDC *allowance* rather than a deposit; the move to a Caller Deposit is recorded in ADR 0004 and not yet built.)

## Pull Threshold
The off-chain accrued debt level (default **$0.01** for testing, configurable via `PULL_THRESHOLD_USD`; canonical default in `packages/proxy/src/config.ts`) that triggers an on-chain settlement pull. The proxy accumulates a Caller's request costs in SQLite; once the total crosses this threshold, a background worker calls `LatchkeyBilling.pull()` to move USDC from the Caller's wallet to the proxy. The threshold exists to batch small payments and avoid high on-chain transaction volume.

## Accrued Debt
The dollar-denominated sum of request costs billed to a Caller's wallet since the last successful on-chain settlement. Stored in `wallet_state.accrued_usd`. Dollars are the canonical internal unit; conversion to USDC atomic units (6 decimals) happens only at pull time.

## Proof of Inference
The mechanism by which the Marketplace verifies that a Provider made a real upstream LLM request and that billing reflects actual token usage.

- **Self-hosted Providers:** optimistic trust with on-chain staking/slashing for dispute resolution.
- **API-delegating Providers:** zkTLS — a cryptographic proof over the TLS session with the upstream API, proving the server identity and the `usage` response (token counts) without revealing the provider's API key. Settlement is async: the Caller receives a streamed response immediately; the zkTLS proof is generated in the background and settles billing on-chain within seconds.

## Chain
The blockchain network used for on-chain settlement, staking, and balance tracking.

- **v1:** Base (EVM). Native USDC, EIP-712 signing supported across major wallets.
- **v2:** Solana added as a second funding rail. Callers fund whichever chain matches their wallet; the proxy checks the correct contract before routing. Agents are chain-unaware.

## Bearer Token
The credential Callers use to authenticate requests. Derived by signing a structured message `{address, expiry, nonce}` with the Caller's EVM private key — no gas, no on-chain transaction, no registration step. The signature itself is the token.

On each request, the proxy recovers the signer address from the signature, checks that the wallet is not blocked and (for first-seen wallets) has a sufficient USDC allowance approved for `LatchkeyBilling`. If blocked or lacking allowance, returns HTTP 402. The allowance check is cached after the first request — no RPC on the steady-state hot path.

Token expiry limits the blast radius of a leaked token. Passed in request headers using the convention of the Caller's API Format: `Authorization: Bearer <token>` (OpenAI) or `x-api-key: <token>` (Anthropic).

## Session Key
A keypair generated by the Caller and authorised via a wallet signature. Used when the Caller wants to keep their root wallet cold — the session keypair signs requests instead of the root wallet. The authorisation is submitted on-chain. Optional; Callers who are comfortable signing at runtime can use a Bearer Token derived from their root wallet directly.
