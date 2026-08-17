#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"; cd "$HERE"
set -a; source "$HERE/.env.testnet"; source "$HERE/deployments/84532.env"; set +a
RPC="$BASE_SEPOLIA_RPC"; export PATH="$HOME/.foundry/bin:$PATH"
USDT="$NEXT_PUBLIC_USDT_ADDRESS"; IOU="$NEXT_PUBLIC_IOU_TOKEN_ADDRESS"
SARREG="$NEXT_PUBLIC_SARRAF_REGISTRY_ADDRESS"; MEMREG="$NEXT_PUBLIC_MEMBER_REGISTRY_ADDRESS"; POOL="$NEXT_PUBLIC_RESERVE_POOL_ADDRESS"
S(){ cast send --rpc-url "$RPC" --private-key "$1" "${@:2}" >/dev/null; }
Cb(){ cast call --rpc-url "$RPC" "$@" | sed 's/ \[.*//'; }
echo "== fund test wallets =="
cast send --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" --value 0.0002ether "$SARRAF_ADDR" >/dev/null
cast send --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" --value 0.0002ether "$CUSTOMER_ADDR" >/dev/null
echo "  sarraf gas=$(cast balance $SARRAF_ADDR --rpc-url $RPC)"
echo "== sarraf deposits 1,000,000 mUSDT =="
DEPOSIT=1000000000000
S "$SARRAF_KEY" "$USDT" 'mint(address,uint256)' "$SARRAF_ADDR" "$DEPOSIT"
S "$SARRAF_KEY" "$USDT" 'approve(address,uint256)' "$POOL" "$DEPOSIT"
S "$SARRAF_KEY" "$POOL" 'deposit(uint256)' "$DEPOSIT"
echo "  backing=$(Cb $POOL 'backingOf(address)(uint256)' $SARRAF_ADDR)"
echo "== wait TWAB ${TWAB_WINDOW}s then certify =="
sleep $((TWAB_WINDOW + 20))
S "$SARRAF_KEY" "$SARREG" 'evaluate()'
echo "  certified=$(Cb $SARREG 'isCertified(address)(bool)' $SARRAF_ADDR)"
echo "== onboard customer + issue 1,000 IOU =="
S "$SARRAF_KEY" "$MEMREG" 'addMember(address)' "$CUSTOMER_ADDR"
S "$SARRAF_KEY" "$POOL" 'issue(address,uint256)' "$CUSTOMER_ADDR" 1000000000
TID=$(Cb $POOL 'trancheId(address)(uint256)' $SARRAF_ADDR)
echo "  customer IOU balance=$(Cb $IOU 'balanceOf(address,uint256)(uint256)' $CUSTOMER_ADDR $TID)"
echo "== SEED DONE — Base Sepolia mint loop live =="
