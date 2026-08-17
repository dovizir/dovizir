#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"; cd "$HERE"
set -a; source .env.testnet; source deployments/84532.env; set +a
RPC=https://base-sepolia-rpc.publicnode.com; export PATH="$HOME/.foundry/bin:$PATH"
USER_WALLET=0x7E6077e94C4654D2C1ef54875a5D3392C2d62102
USDT=$NEXT_PUBLIC_USDT_ADDRESS; IOU=$NEXT_PUBLIC_IOU_TOKEN_ADDRESS
SARREG=$NEXT_PUBLIC_SARRAF_REGISTRY_ADDRESS; MEMREG=$NEXT_PUBLIC_MEMBER_REGISTRY_ADDRESS; POOL=$NEXT_PUBLIC_RESERVE_POOL_ADDRESS
S(){ cast send --rpc-url "$RPC" --private-key "$1" "${@:2}" >/dev/null; }
Cb(){ cast call --rpc-url "$RPC" "$@" | sed 's/ \[.*//'; }
if [ "$(Cb $POOL 'backingOf(address)(uint256)' $SARRAF_ADDR)" = "0" ]; then
  echo "== deposit 1,000,000 mUSDT =="
  S $SARRAF_KEY $USDT 'mint(address,uint256)' $SARRAF_ADDR 1000000000000
  S $SARRAF_KEY $USDT 'approve(address,uint256)' $POOL 1000000000000
  S $SARRAF_KEY $POOL 'deposit(uint256)' 1000000000000
fi
echo "  backing=$(Cb $POOL 'backingOf(address)(uint256)' $SARRAF_ADDR)"
echo "== TWAB wait ${TWAB_WINDOW}s =="; sleep $((TWAB_WINDOW+20))
[ "$(Cb $SARREG 'isCertified(address)(bool)' $SARRAF_ADDR)" = "true" ] || S $SARRAF_KEY $SARREG 'evaluate()'
echo "  certified=$(Cb $SARREG 'isCertified(address)(bool)' $SARRAF_ADDR)"
echo "== onboard + issue 1,000 IOU to your wallet + demo customer =="
for M in $USER_WALLET $CUSTOMER_ADDR; do
  [ "$(Cb $MEMREG 'isMember(address)(bool)' $M)" = "true" ] || S $SARRAF_KEY $MEMREG 'addMember(address)' $M
  S $SARRAF_KEY $POOL 'issue(address,uint256)' $M 1000000000
done
TID=$(Cb $POOL 'trancheId(address)(uint256)' $SARRAF_ADDR)
echo "  YOUR wallet IOU  = $(Cb $IOU 'balanceOf(address,uint256)(uint256)' $USER_WALLET $TID)"
echo "  demo customer IOU= $(Cb $IOU 'balanceOf(address,uint256)(uint256)' $CUSTOMER_ADDR $TID)"
echo "== SEED DONE =="
