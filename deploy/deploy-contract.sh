#!/usr/bin/env bash
# Deploy LatchkeyBilling, reading ALL config from packages/proxy/.env (single source of truth).
# No inline env vars needed. Usage: bash deploy/deploy-contract.sh
#
# Reads from packages/proxy/.env:
#   BASE_RPC_URL           RPC endpoint to deploy against
#   USDC_ADDRESS           the ERC-20 the contract pulls (constructor `usdc`)
#   TREASURY_ADDRESS       receives the 1% fee (constructor `treasury`)
#   OWNER_ADDRESS          cold key/multisig that can rotate proxy/treasury (constructor `owner`)
#   PROXY_PRIVATE_KEY      the proxy operator key — its ADDRESS becomes constructor `proxy`
#   DEPLOYER_PRIVATE_KEY   wallet that pays gas (optional; defaults to PROXY_PRIVATE_KEY)
#
# `proxy` is derived automatically from PROXY_PRIVATE_KEY — you never set PROXY_ADDRESS by hand.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Defaults to the single source of truth; override DEPLOY_ENV_FILE to deploy from another env.
ENV_FILE="${DEPLOY_ENV_FILE:-$ROOT/packages/proxy/.env}"
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE — copy packages/proxy/.env.example and fill it in" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

CAST="${CAST:-cast}"
command -v "$CAST" >/dev/null || CAST="$HOME/.foundry/bin/cast"
FORGE="${FORGE:-forge}"
command -v "$FORGE" >/dev/null || FORGE="$HOME/.foundry/bin/forge"

# Deployer pays gas (any funded wallet). Defaults to the proxy key if not set separately.
DEPLOYER_PRIVATE_KEY="${DEPLOYER_PRIVATE_KEY:-${PROXY_PRIVATE_KEY:-}}"

: "${BASE_RPC_URL:?set BASE_RPC_URL in packages/proxy/.env}"
: "${USDC_ADDRESS:?set USDC_ADDRESS in packages/proxy/.env}"
: "${TREASURY_ADDRESS:?set TREASURY_ADDRESS in packages/proxy/.env}"
: "${OWNER_ADDRESS:?set OWNER_ADDRESS (cold key/multisig) in packages/proxy/.env}"
: "${PROXY_PRIVATE_KEY:?set PROXY_PRIVATE_KEY in packages/proxy/.env}"
: "${DEPLOYER_PRIVATE_KEY:?set DEPLOYER_PRIVATE_KEY or PROXY_PRIVATE_KEY}"

# Deploy.s.sol reads PROXY_ADDRESS as the `proxy` constructor arg — derive it from the key.
PROXY_ADDRESS="$("$CAST" wallet address --private-key "$PROXY_PRIVATE_KEY")"
export USDC_ADDRESS TREASURY_ADDRESS OWNER_ADDRESS PROXY_ADDRESS

echo "Deploying LatchkeyBilling to $BASE_RPC_URL"
echo "  usdc     = $USDC_ADDRESS"
echo "  proxy    = $PROXY_ADDRESS   (derived from PROXY_PRIVATE_KEY)"
echo "  treasury = $TREASURY_ADDRESS"
echo "  owner    = $OWNER_ADDRESS"
if [ "$(printf '%s' "$PROXY_ADDRESS" | tr 'A-F' 'a-f')" = "$(printf '%s' "$TREASURY_ADDRESS" | tr 'A-F' 'a-f')" ]; then
  echo "  ⚠️  treasury == proxy — the 1% fee is NOT separated. Set a distinct TREASURY_ADDRESS."
fi
echo

cd "$ROOT/packages/contracts"
"$FORGE" script script/Deploy.s.sol:Deploy \
  --rpc-url "$BASE_RPC_URL" \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --broadcast

echo
echo "Next: copy the deployed address into packages/proxy/.env (BILLING_CONTRACT_ADDRESS) and"
echo "packages/contracts/README.md, then run: bash deploy/validate-deployment.sh"
