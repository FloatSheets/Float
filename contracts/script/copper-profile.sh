#!/usr/bin/env bash
# Switch every Copper market's leverage profile in one command, signed by the
# Copper owner wallet (you are prompted for its key; nothing is stored).
#
#   script/copper-profile.sh closure   # before each weekend or holiday close (by 14:00 ET)
#   script/copper-profile.sh launch    # after the reopen
#   script/copper-profile.sh step-up   # after 14 days without bad debt
#
# Addresses come from deployments/copper-4663.json. COPPER_POSITION_CAP_USDG
# (default 40) keeps the per-position cap sized to the vault.
set -euo pipefail
cd "$(dirname "$0")/.."

profile="${1:-}"
case "$profile" in
  closure|launch|step-up) ;;
  *) echo "usage: script/copper-profile.sh closure|launch|step-up" >&2; exit 1 ;;
esac

record=deployments/copper-4663.json
oracle=$(sed -n 's/.*"oracle": *"\(0x[0-9a-fA-F]\{40\}\)".*/\1/p' "$record" | head -1)
clearing=$(sed -n 's/.*"clearingHouse": *"\(0x[0-9a-fA-F]\{40\}\)".*/\1/p' "$record" | head -1)
if [ -z "$oracle" ] || [ -z "$clearing" ]; then echo "Copper addresses not found in $record" >&2; exit 1; fi

echo "Copper $profile profile → clearing house $clearing (cap ${COPPER_POSITION_CAP_USDG:-40} USDG)"
RHC_RPC_URL="${RHC_RPC_URL:-https://rpc.mainnet.chain.robinhood.com}" \
FLOAT_ORACLE_ADDRESS="$oracle" FLOAT_CLEARING_HOUSE_ADDRESS="$clearing" \
COPPER_MARKET_STATE=1 COPPER_LEVERAGE_PROFILE="$profile" COPPER_POSITION_CAP_USDG="${COPPER_POSITION_CAP_USDG:-40}" \
forge script script/ConfigureCopperMarkets.s.sol --rpc-url rhc --broadcast --interactives 1
