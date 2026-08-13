#!/usr/bin/env bash
#
# demo-loop.sh — prove the Dovizir M1 money loop end-to-end against a LIVE chain.
#
# This is the "one wallet-to-wallet payment an investor can click through",
# proven on-chain with real transactions and hard assertions at every step:
#   (a) a Sarraf deposits mock USDT, waits out the 7-day TWAB, and certifies;
#   (b) the Sarraf onboards a member and issues IOU to them (backed 1:1);
#   (c) that member sends IOU to a second member;
#   (d) the second member redeems through the pool — USDT out net of the 90bps
#       fee, with the fee landing in the InsuranceFund under its 50/50 split.
#
# Time-warp (step a) uses anvil's evm_increaseTime RPC, which is why this is a
# cast script and not a forge cheatcode script: forge's vm.warp cannot move a
# live chain's clock. Against Base Sepolia you would instead space the deposit
# and certification 7 real days apart.
#
# Usage:  RPC_URL=http://127.0.0.1:8545 ./script/demo-loop.sh
set -euo pipefail

RPC="${RPC_URL:-http://127.0.0.1:8545}"
CHAINID="$(cast chain-id --rpc-url "$RPC")"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$HERE/deployments/$CHAINID.env"

[ -f "$ENV_FILE" ] || { echo "FAIL: $ENV_FILE not found — run Deploy.s.sol first"; exit 1; }
set -a; # shellcheck disable=SC1090
source "$ENV_FILE"; set +a

USDT="$NEXT_PUBLIC_USDT_ADDRESS"
IOU="$NEXT_PUBLIC_IOU_TOKEN_ADDRESS"
SARREG="$NEXT_PUBLIC_SARRAF_REGISTRY_ADDRESS"
MEMREG="$NEXT_PUBLIC_MEMBER_REGISTRY_ADDRESS"
FUND="$NEXT_PUBLIC_INSURANCE_FUND_ADDRESS"
POOL="$NEXT_PUBLIC_RESERVE_POOL_ADDRESS"

# Deterministic anvil actors.
SARRAF=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
SARRAF_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
MEMBER_A=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
MEMBER_A_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
MEMBER_B=0x90F79bf6EB2c4f870365E785982E1f101E93b906
MEMBER_B_KEY=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6

# Amounts (mock USDT / IOU are 6-decimal).
DEPOSIT=1000000000000   # 1,000,000.000000
ISSUE=1000000000        #     1,000.000000
SEND=400000000          #       400.000000
REDEEM=400000000        #       400.000000  (member B redeems everything received)

S()  { cast send --rpc-url "$RPC" --private-key "$1" "${@:2}" >/dev/null; }
# cast >=1.3 appends a human suffix e.g. "1000000000 [1e9]" to numeric returns;
# strip it so values are usable as plain integers / call args.
Cb() { cast call --rpc-url "$RPC" "$@" | sed 's/ \[.*//'; }
fail=0
ok()   { echo "  PASS  $1"; }
bad()  { echo "  FAIL  $1"; fail=1; }
eq()   { if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1 expected=$3 got=$2"; fi; }

echo "== Dovizir M1 money loop @ chain $CHAINID via $RPC =="
TID="$(Cb "$POOL" 'trancheId(address)(uint256)' "$SARRAF")"

echo "-- (a) Sarraf deposits USDT and certifies --------------------------------"
S "$SARRAF_KEY" "$USDT" 'mint(address,uint256)' "$SARRAF" "$DEPOSIT"
S "$SARRAF_KEY" "$USDT" 'approve(address,uint256)' "$POOL" "$DEPOSIT"
S "$SARRAF_KEY" "$POOL" 'deposit(uint256)' "$DEPOSIT"
eq "pool backing == deposit"        "$(Cb "$POOL" 'backingOf(address)(uint256)' "$SARRAF")" "$DEPOSIT"
FLOOR="$(Cb "$SARREG" 'floor()(uint256)')"
echo "  info  certification floor = $FLOOR (min(totalDeposits/5, \$1M))"
# Warp past the 7-day TWAB window, then evaluate.
cast rpc --rpc-url "$RPC" evm_increaseTime 604801 >/dev/null
cast rpc --rpc-url "$RPC" evm_mine >/dev/null
echo "  info  sarraf 7d TWAB = $(Cb "$SARREG" 'twabOf(address)(uint256)' "$SARRAF")"
S "$SARRAF_KEY" "$SARREG" 'evaluate()'
eq "sarraf isCertified"             "$(Cb "$SARREG" 'isCertified(address)(bool)' "$SARRAF")" "true"

echo "-- (b) Sarraf onboards a member and issues IOU ---------------------------"
S "$SARRAF_KEY" "$MEMREG" 'addMember(address)' "$MEMBER_A"
eq "member A isMember"              "$(Cb "$MEMREG" 'isMember(address)(bool)' "$MEMBER_A")" "true"
eq "member A sarrafOf"             "$(Cb "$MEMREG" 'sarrafOf(address)(address)' "$MEMBER_A")" "$SARRAF"
S "$SARRAF_KEY" "$POOL" 'issue(address,uint256)' "$MEMBER_A" "$ISSUE"
eq "member A IOU balance"          "$(Cb "$IOU" 'balanceOf(address,uint256)(uint256)' "$MEMBER_A" "$TID")" "$ISSUE"
OUT="$(Cb "$POOL" 'outstandingOf(address)(uint256)' "$SARRAF")"
BACK="$(Cb "$POOL" 'backingOf(address)(uint256)' "$SARRAF")"
eq "outstanding == issued"         "$OUT" "$ISSUE"
if [ "$OUT" -le "$BACK" ]; then ok "outstanding ($OUT) <= backing ($BACK)"; else bad "outstanding $OUT > backing $BACK"; fi

echo "-- (c) Member A sends IOU to Member B ------------------------------------"
S "$MEMBER_A_KEY" "$IOU" 'safeTransferFrom(address,address,uint256,uint256,bytes)' "$MEMBER_A" "$MEMBER_B" "$TID" "$SEND" 0x
eq "member A IOU after send"       "$(Cb "$IOU" 'balanceOf(address,uint256)(uint256)' "$MEMBER_A" "$TID")" "$((ISSUE - SEND))"
eq "member B IOU after send"       "$(Cb "$IOU" 'balanceOf(address,uint256)(uint256)' "$MEMBER_B" "$TID")" "$SEND"

echo "-- (d) Member B redeems through the pool (90bps fee, 50/50 split) --------"
B_BEFORE="$(Cb "$USDT" 'balanceOf(address)(uint256)' "$MEMBER_B")"
S "$MEMBER_B_KEY" "$POOL" 'redeem(address,uint256)' "$SARRAF" "$REDEEM"
FEE=$((REDEEM * 90 / 10000))       # 90 bps, rounds down
NET=$((REDEEM - FEE))
B_AFTER="$(Cb "$USDT" 'balanceOf(address)(uint256)' "$MEMBER_B")"
eq "member B USDT out == net"      "$((B_AFTER - B_BEFORE))" "$NET"
eq "member B IOU after redeem"     "$(Cb "$IOU" 'balanceOf(address,uint256)(uint256)' "$MEMBER_B" "$TID")" "0"
eq "fund totalReserves == fee"     "$(Cb "$FUND" 'totalReserves()(uint256)')" "$FEE"
eq "fund maintenanceShare == fee/2" "$(Cb "$FUND" 'maintenanceShare()(uint256)')" "$((FEE / 2))"
eq "fund overseeingShare == fee-fee/2" "$(Cb "$FUND" 'overseeingShare()(uint256)')" "$((FEE - FEE / 2))"
eq "fund USDT balance == fee"      "$(Cb "$USDT" 'balanceOf(address)(uint256)' "$FUND")" "$FEE"

echo "== summary =============================================================="
echo "  deposit         $DEPOSIT  (1,000,000.000000 mUSDT)"
echo "  issued to A     $ISSUE  (1,000.000000 IOU)"
echo "  A -> B          $SEND  (400.000000 IOU)"
echo "  B redeemed      $REDEEM  (400.000000 IOU)"
echo "  fee (90bps)     $FEE  ($(echo "scale=6;$FEE/1000000"|bc) mUSDT) -> maintenance $((FEE/2)) + overseeing $((FEE-FEE/2))"
echo "  B received      $((B_AFTER - B_BEFORE))  ($(echo "scale=6;($B_AFTER-$B_BEFORE)/1000000"|bc) mUSDT)"
if [ "$fail" = 0 ]; then echo "== ALL ASSERTIONS PASSED =="; else echo "== ASSERTIONS FAILED =="; exit 1; fi
