# Latchkey Contracts

| Contract | Status | Purpose |
|----------|--------|---------|
| `LatchkeyBilling.sol` | **active** | Non-custodial pull-payment billing. Callers approve once; the proxy settles accrued service debt. |
| `PaypromptBalance.sol` | legacy / **not deployed** | Original custodial deposit vault. Superseded by the non-custodial pull model; kept for reference only. |
| `Counter.sol` | scaffold | Foundry template, unused. |

## Fee model (LatchkeyBilling)

The 1% Tesser fee is charged **on top of** the provider's price — it is not carved out of it.

`pull(caller, cumulativeService)` takes the caller's **cumulative** lifetime service total (atomic USDC,
fee-exclusive) and charges only the unsettled delta:

- `delta = cumulativeService - settled[caller]` (must be strictly increasing — monotonic)
- `fee   = delta / 100` (1% of the service delta, on top)
- the **caller pays `delta + fee`**, the **proxy receives exactly `delta`** (the provider's price), the **treasury receives `fee`**

`settled[caller]` is a monotonic checkpoint, so retries, crash-recovery re-broadcasts, and overlapping
snapshots can never double-charge. `proxy` and `treasury` are owner-rotatable to recover from a
compromised hot key or a token-blocklisted recipient without redeploying.

## Deployed addresses — Base Sepolia (chainId 84532)

> **Update this table and `packages/proxy/.env` (`BILLING_CONTRACT_ADDRESS`) after every deployment.**

| Contract | Address | Version | Notes |
|----------|---------|---------|-------|
| LatchkeyBilling | `0x7ddF81666B5b0ABcF26eA1576aD257244eF2F9f9` | **pre-hardening (SUPERSEDED)** | Old `pull(caller, gross)` fee-inclusive model, no `settled`/`owner`. **Pending redeploy** of the fee-on-top + cumulative + rotatable version. |
| LatchkeyBilling | _redeploy pending_ | fee-on-top + cumulative + rotatable | Set here + in `.env` once deployed and validated. |
| USDC (testnet) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | — | Base Sepolia USDC. |

## Deploy + validate

```shell
# 1. Deploy (reads USDC_ADDRESS, TREASURY_ADDRESS, PROXY_ADDRESS, and optional OWNER_ADDRESS from env)
forge script script/Deploy.s.sol:Deploy --rpc-url "$BASE_RPC_URL" --private-key "$DEPLOYER_KEY" --broadcast

# 2. Record the new address in the table above AND in packages/proxy/.env (BILLING_CONTRACT_ADDRESS)

# 3. Validate the live deployment (forge unit suite + on-chain wiring/ABI checks)
bash ../../deploy/validate-deployment.sh
```

`OWNER_ADDRESS` should be a cold key or multisig, **separate** from the hot `PROXY_ADDRESS`, so a proxy
key compromise can be recovered by rotating `proxy` via the owner. (The current testnet deployment has
`treasury == proxy`; set a distinct `TREASURY_ADDRESS` on redeploy so the fee is genuinely separated.)

---

## Foundry

**Foundry is a blazing fast, portable and modular toolkit for Ethereum application development written in Rust.**

Foundry consists of:

- **Forge**: Ethereum testing framework (like Truffle, Hardhat and DappTools).
- **Cast**: Swiss army knife for interacting with EVM smart contracts, sending transactions and getting chain data.
- **Anvil**: Local Ethereum node, akin to Ganache, Hardhat Network.
- **Chisel**: Fast, utilitarian, and verbose solidity REPL.

## Documentation

https://book.getfoundry.sh/

## Usage

### Build

```shell
$ forge build
```

### Test

```shell
$ forge test
```

### Format

```shell
$ forge fmt
```

### Gas Snapshots

```shell
$ forge snapshot
```

### Anvil

```shell
$ anvil
```

### Deploy

```shell
$ forge script script/Counter.s.sol:CounterScript --rpc-url <your_rpc_url> --private-key <your_private_key>
```

### Cast

```shell
$ cast <subcommand>
```

### Help

```shell
$ forge --help
$ anvil --help
$ cast --help
```
