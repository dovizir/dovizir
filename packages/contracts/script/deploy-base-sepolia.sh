#!/usr/bin/env bash
#
# deploy-base-sepolia.sh — one-shot: deploy the Dovizir M1 system to Base
# Sepolia, distribute gas to the test wallets, and seed the money loop so the
# app can mint/send/redeem IOU on a real testnet.
#
# Prereq: fund DEPLOYER_ADDR (in .env.testnet) with a little Base Sepolia ETH.
# Faucets (pick one):
#   - https://www.alchemy.com/faucets/base-sepolia
#   - https://faucet.quicknode.com/base/sepolia
#   - Coinbase Wallet / CDP faucet: https://portal.cdp.coinbase.com/products/faucet
# ~0.02 ETH is plenty (deploys ~8 contracts + seeds + funds 2 wallets).
#
# Usage:  ./script/deploy-base-sepolia.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"
set -a; source "$HERE/.env.testnet"; set +a
RPC="$BASE_SEPOLIA_RPC"
export PATH="$HOME/.foundry/bin:$PATH"

S()  { cast send --rpc-url "$RPC" --private-key "$1" "${@:2}" >/dev/null; }
Cb() { cast call --rpc-url "$RPC" "$@" | sed 's/ \[.*//'; }

echo "== Preflight =="
BAL="$(cast balance "$DEPLOYER_ADDR" --rpc-url "$RPC")"
echo "  deployer $DEPLOYER_ADDR balance = $BAL wei"
if [ "$BAL" = "0" ]; then
  echo "  FAIL: deployer is unfunded. Send ~0.02 Base Sepolia ETH to:"
  echo "        $DEPLOYER_ADDR"
  echo "        then re-run this script. See faucet links in the header."
  exit 1
fi

echo "== 1. Deploy system (TWAB_WINDOW=$TWAB_WINDOW s) =="
TWAB_WINDOW="$TWAB_WINDOW" PRIVATE_KEY="$DEPLOYER_KEY" \
  forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --broadcast --slow
set -a; source "$HERE/deployments/84532.env"; set +a
USDT="$NEXT_PUBLIC_USDT_ADDRESS"; IOU="$NEXT_PUBLIC_IOU_TOKEN_ADDRESS"
SARREG="$NEXT_PUBLIC_SARRAF_REGISTRY_ADDRESS"; MEMREG="$NEXT_PUBLIC_MEMBER_REGISTRY_ADDRESS"
POOL="$NEXT_PUBLIC_RESERVE_POOL_ADDRESS"

echo "== 2. Distribute gas to test wallets =="
S "$DEPLOYER_KEY" --value 0.0002ether "$SARRAF_ADDR" 2>/dev/null || \
  cast send --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" --value 0.0002ether "$SARRAF_ADDR" >/dev/null
cast send --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" --value 0.0002ether "$CUSTOMER_ADDR" >/dev/null
echo "  funded sarraf + customer with 0.0002 ETH each"

echo "== 3. Sarraf deposits mock USDT =="
DEPOSIT=1000000000000   # 1,000,000.000000 (6-dec)
S "$SARRAF_KEY" "$USDT" 'mint(address,uint256)' "$SARRAF_ADDR" "$DEPOSIT"
S "$SARRAF_KEY" "$USDT" 'approve(address,uint256)' "$POOL" "$DEPOSIT"
S "$SARRAF_KEY" "$POOL" 'deposit(uint256)' "$DEPOSIT"
echo "  backing = $(Cb "$POOL" 'backingOf(address)(uint256)' "$SARRAF_ADDR")"

echo "== 4. Wait out the TWAB window ($TWAB_WINDOW s) so TWAB >= floor =="
sleep "$((TWAB_WINDOW + 30))"
echo "  twab = $(Cb "$SARREG" 'twabOf(address)(uint256)' "$SARRAF_ADDR")  floor = $(Cb "$SARREG" 'floor()(uint256)')"
S "$SARRAF_KEY" "$SARREG" 'evaluate()'
echo "  isCertified = $(Cb "$SARREG" 'isCertified(address)(bool)' "$SARRAF_ADDR")"

echo "== 5. Onboard the customer + issue a starter IOU balance =="
S "$SARRAF_KEY" "$MEMREG" 'addMember(address)' "$CUSTOMER_ADDR"
ISSUE=1000000000         # 1,000.000000 IOU
S "$SARRAF_KEY" "$POOL" 'issue(address,uint256)' "$CUSTOMER_ADDR" "$ISSUE"
TID="$(Cb "$POOL" 'trancheId(address)(uint256)' "$SARRAF_ADDR")"
echo "  customer IOU balance = $(Cb "$IOU" 'balanceOf(address,uint256)(uint256)' "$CUSTOMER_ADDR" "$TID")"

echo ""
echo "== DONE — Base Sepolia mint loop is live =="
echo "  Sarraf   $SARRAF_ADDR  (certified)"
echo "  Customer $CUSTOMER_ADDR (member, holds 1,000 IOU)"
echo "  Addresses written to deployments/84532.env"
echo "  Import a test key into your wallet and connect at qa.dovizir.com to"
echo "  exercise deposit / issue / send / redeem on real testnet."
