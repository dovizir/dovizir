#!/usr/bin/env bash
#
# p2p-demo.sh — prove the Dovizir P2P escrow (fiat-ramp §4) end-to-end on a LIVE
# chain, with hard balance + state assertions at every step. Covers all three
# flows the review cares about:
#   (a) HAPPY   createOrder locks IOU → fill → claimFiatPaid → confirmReceived
#               → taker holds the IOU, order SETTLED.
#   (b) DISPUTE fill → claim → raiseDispute → arbiter resolve(toTaker) pays the
#               taker; a second order resolve(toMaker) refunds the maker.
#   (c) TIMEOUT fill but no fiat → payment window elapses → maker cancel refunds.
#
# Setup reuses the M1 loop: a Sarraf deposits, certifies, onboards a maker +
# taker, and issues IOU to the maker. The Sarraf is the arbiter of its own
# tranche (derived on-chain), and is neither maker nor taker (no self-deal).
#
# Usage:  RPC_URL=http://127.0.0.1:8545 ./script/p2p-demo.sh
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
POOL="$NEXT_PUBLIC_RESERVE_POOL_ADDRESS"
ESCROW="$NEXT_PUBLIC_ESCROW_ADDRESS"

[ -n "${ESCROW:-}" ] && [ "$ESCROW" != "0x0000000000000000000000000000000000000000" ] \
  || { echo "FAIL: NEXT_PUBLIC_ESCROW_ADDRESS unset in $ENV_FILE"; exit 1; }

# Deterministic anvil actors.
SARRAF=0x70997970C51812dc3A010C7d01b50e0d17dc79C8   # arbiter (tranche issuer)
SARRAF_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
MAKER=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC     # sells IOU, wants fiat
MAKER_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
TAKER=0x90F79bf6EB2c4f870365E785982E1f101E93b906     # has fiat, wants IOU
TAKER_KEY=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6

DEPOSIT=1000000000000   # 1,000,000.000000 mUSDT backing
ISSUE=1000000000        #     1,000.000000 IOU to the maker
AMT=100000000           #       100.000000 IOU locked per order
FIAT=5000000000         # agreed local-currency units (opaque to chain)
WINDOW=3600             # 1h payment window (>= 15m min, <= 30d max)
QUOTE=0x1111111111111111111111111111111111111111111111111111111111111111
RCPT=0x2222222222222222222222222222222222222222222222222222222222222222

S()  { cast send --rpc-url "$RPC" --private-key "$1" "${@:2}" >/dev/null; }
Cb() { cast call --rpc-url "$RPC" "$@" | sed 's/ \[.*//'; }
fail=0
ok()  { echo "  PASS  $1"; }
bad() { echo "  FAIL  $1"; fail=1; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1 expected=$3 got=$2"; fi; }
iou_of() { Cb "$IOU" 'balanceOf(address,uint256)(uint256)' "$1" "$TID"; }
status() { Cb "$ESCROW" 'statusOf(uint256)(uint8)' "$1"; }
# Escrow.Status: 1 Open 2 Matched 3 FiatClaimed 4 Settled 5 Refunded 6 Disputed 7 ResolvedTaker 8 ResolvedMaker

echo "== Dovizir P2P escrow @ chain $CHAINID via $RPC =="
echo "   escrow=$ESCROW"
TID="$(Cb "$POOL" 'trancheId(address)(uint256)' "$SARRAF")"

echo "-- setup: certify Sarraf, onboard maker+taker, issue IOU to maker --------"
S "$SARRAF_KEY" "$USDT" 'mint(address,uint256)' "$SARRAF" "$DEPOSIT"
S "$SARRAF_KEY" "$USDT" 'approve(address,uint256)' "$POOL" "$DEPOSIT"
S "$SARRAF_KEY" "$POOL" 'deposit(uint256)' "$DEPOSIT"
cast rpc --rpc-url "$RPC" evm_increaseTime 604801 >/dev/null
cast rpc --rpc-url "$RPC" evm_mine >/dev/null
S "$SARRAF_KEY" "$SARREG" 'evaluate()'
eq "sarraf certified" "$(Cb "$SARREG" 'isCertified(address)(bool)' "$SARRAF")" "true"
S "$SARRAF_KEY" "$MEMREG" 'addMember(address)' "$MAKER"
S "$SARRAF_KEY" "$MEMREG" 'addMember(address)' "$TAKER"
S "$SARRAF_KEY" "$POOL" 'issue(address,uint256)' "$MAKER" "$ISSUE"
eq "maker IOU issued" "$(iou_of "$MAKER")" "$ISSUE"
# Maker authorizes the escrow to custody its IOU (one-time operator approval).
S "$MAKER_KEY" "$IOU" 'setApprovalForAll(address,bool)' "$ESCROW" true

echo ""
echo "== (a) HAPPY PATH ========================================================"
OID="$(Cb "$ESCROW" 'nextOrderId()(uint256)')"
MAKER_BEFORE="$(iou_of "$MAKER")"
S "$MAKER_KEY" "$ESCROW" 'createOrder(address,uint256,string,uint256,bytes32,uint64)' "$SARRAF" "$AMT" "IRR" "$FIAT" "$QUOTE" "$WINDOW"
eq "order $OID OPEN"              "$(status "$OID")" "1"
eq "escrow holds locked IOU"      "$(iou_of "$ESCROW")" "$AMT"
eq "maker debited by amount"      "$(iou_of "$MAKER")" "$((MAKER_BEFORE - AMT))"
eq "arbiter of order == sarraf"   "$(cast --to-checksum "$(Cb "$ESCROW" 'arbiterOf(uint256)(address)' "$OID")")" "$(cast --to-checksum "$SARRAF")"
S "$TAKER_KEY" "$ESCROW" 'fillOrder(uint256)' "$OID"
eq "order MATCHED"                "$(status "$OID")" "2"
S "$TAKER_KEY" "$ESCROW" 'claimFiatPaid(uint256,bytes32)' "$OID" "$RCPT"
eq "order FIAT_CLAIMED"           "$(status "$OID")" "3"
TAKER_BEFORE="$(iou_of "$TAKER")"
S "$MAKER_KEY" "$ESCROW" 'confirmReceived(uint256)' "$OID"
eq "order SETTLED"                "$(status "$OID")" "4"
eq "taker received the IOU"       "$(iou_of "$TAKER")" "$((TAKER_BEFORE + AMT))"
eq "escrow emptied"               "$(iou_of "$ESCROW")" "0"

echo ""
echo "== (b) DISPUTE ==========================================================="
echo "-- b1: arbiter resolves to TAKER ----------------------------------------"
OID="$(Cb "$ESCROW" 'nextOrderId()(uint256)')"
S "$MAKER_KEY" "$ESCROW" 'createOrder(address,uint256,string,uint256,bytes32,uint64)' "$SARRAF" "$AMT" "IRR" "$FIAT" "$QUOTE" "$WINDOW"
S "$TAKER_KEY" "$ESCROW" 'fillOrder(uint256)' "$OID"
S "$TAKER_KEY" "$ESCROW" 'claimFiatPaid(uint256,bytes32)' "$OID" "$RCPT"
S "$TAKER_KEY" "$ESCROW" 'raiseDispute(uint256)' "$OID"
eq "order DISPUTED"               "$(status "$OID")" "6"
# non-arbiter cannot resolve
if cast send --rpc-url "$RPC" --private-key "$MAKER_KEY" "$ESCROW" 'resolve(uint256,bool)' "$OID" true >/dev/null 2>&1
then bad "non-arbiter resolve should revert"; else ok "non-arbiter resolve reverted"; fi
TAKER_BEFORE="$(iou_of "$TAKER")"
S "$SARRAF_KEY" "$ESCROW" 'resolve(uint256,bool)' "$OID" true
eq "order RESOLVED_TAKER"         "$(status "$OID")" "7"
eq "taker awarded the IOU"        "$(iou_of "$TAKER")" "$((TAKER_BEFORE + AMT))"
eq "escrow emptied"               "$(iou_of "$ESCROW")" "0"

echo "-- b2: arbiter resolves to MAKER (refund) -------------------------------"
OID="$(Cb "$ESCROW" 'nextOrderId()(uint256)')"
MAKER_BEFORE="$(iou_of "$MAKER")"
S "$MAKER_KEY" "$ESCROW" 'createOrder(address,uint256,string,uint256,bytes32,uint64)' "$SARRAF" "$AMT" "IRR" "$FIAT" "$QUOTE" "$WINDOW"
S "$TAKER_KEY" "$ESCROW" 'fillOrder(uint256)' "$OID"
S "$TAKER_KEY" "$ESCROW" 'claimFiatPaid(uint256,bytes32)' "$OID" "$RCPT"
S "$MAKER_KEY" "$ESCROW" 'raiseDispute(uint256)' "$OID"
S "$SARRAF_KEY" "$ESCROW" 'resolve(uint256,bool)' "$OID" false
eq "order RESOLVED_MAKER"         "$(status "$OID")" "8"
eq "maker refunded the IOU"       "$(iou_of "$MAKER")" "$MAKER_BEFORE"
eq "escrow emptied"               "$(iou_of "$ESCROW")" "0"

echo ""
echo "== (c) TIMEOUT ==========================================================="
OID="$(Cb "$ESCROW" 'nextOrderId()(uint256)')"
MAKER_BEFORE="$(iou_of "$MAKER")"
S "$MAKER_KEY" "$ESCROW" 'createOrder(address,uint256,string,uint256,bytes32,uint64)' "$SARRAF" "$AMT" "IRR" "$FIAT" "$QUOTE" "$WINDOW"
S "$TAKER_KEY" "$ESCROW" 'fillOrder(uint256)' "$OID"
eq "escrow holds locked IOU"      "$(iou_of "$ESCROW")" "$AMT"
# cancel before the window elapses must revert
if cast send --rpc-url "$RPC" --private-key "$MAKER_KEY" "$ESCROW" 'cancel(uint256)' "$OID" >/dev/null 2>&1
then bad "cancel before timeout should revert"; else ok "cancel before timeout reverted"; fi
# warp past the payment window with no fiat claimed
cast rpc --rpc-url "$RPC" evm_increaseTime "$((WINDOW + 1))" >/dev/null
cast rpc --rpc-url "$RPC" evm_mine >/dev/null
S "$MAKER_KEY" "$ESCROW" 'cancel(uint256)' "$OID"
eq "order REFUNDED"               "$(status "$OID")" "5"
eq "maker made whole"             "$(iou_of "$MAKER")" "$MAKER_BEFORE"
eq "escrow emptied"               "$(iou_of "$ESCROW")" "0"

echo ""
if [ "$fail" = 0 ]; then echo "== ALL P2P ESCROW ASSERTIONS PASSED =="; else echo "== ASSERTIONS FAILED =="; exit 1; fi
