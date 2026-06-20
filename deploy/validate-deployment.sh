#!/usr/bin/env bash
# Validate a LatchkeyBilling deployment — run after every deploy, and reusable for TDD.
#
# Stage 1: forge unit suite (the TDD baseline for the contract).
# Stage 2: on-chain validation of the live deployment (wiring + ABI + role checks; optional live pull).
#
# Usage:
#   bash deploy/validate-deployment.sh
#
# Reads packages/proxy/.env for BILLING_CONTRACT_ADDRESS, BASE_RPC_URL, USDC_ADDRESS,
# TREASURY_ADDRESS, PROXY_ADDRESS, OWNER_ADDRESS. To exercise a real pull, also export
# VALIDATE_LIVE_PULL=true plus VALIDATE_PROXY_KEY and VALIDATE_CALLER_ADDRESS (see the script header).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/packages/proxy/.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

# Phase-1 invariant: BALANCE_CONTRACT_ADDRESS must be empty (mock balance mode). A non-empty
# value makes the proxy read on-chain USDC balance → 0 for unfunded wallets → 402 on every request.
if [ -n "${BALANCE_CONTRACT_ADDRESS:-}" ]; then
  echo "BALANCE_CONTRACT_ADDRESS must be empty in phase 1 (got: $BALANCE_CONTRACT_ADDRESS)" >&2
  exit 1
fi

echo "==> Stage 1: forge unit suite"
( cd "$ROOT/packages/contracts" && forge test )

echo
echo "==> Stage 2: on-chain deployment validation"
: "${BILLING_CONTRACT_ADDRESS:?set BILLING_CONTRACT_ADDRESS in packages/proxy/.env}"
( cd "$ROOT/packages/proxy" && bun scripts/validate-deployment.ts )
