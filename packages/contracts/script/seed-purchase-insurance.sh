#!/usr/bin/env bash
# seed-purchase-insurance.sh — one insured purchase, end to end, on the REAL
# deployed system (Base Sepolia): register a shop under the seeded sarraf, have
# the seeded customer pay it through PurchaseInsurance.payShop, and confirm
# receipt so the premium earns. Idempotence: re-running fails loudly at
# registerShop ("already registered") rather than double-seeding.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"; cd "$HERE"
set -a; source "$HERE/.env.testnet"; set +a
RPC="$BASE_SEPOLIA_RPC"
DEP="$(python3 -c "import json;d=json.load(open('deployments/84532.json'));print(d['purchaseInsurance'])")"
IOU="$(python3 -c "import json;d=json.load(open('deployments/84532.json'));print(d['iouToken'])")"
REG="$(python3 -c "import json;d=json.load(open('deployments/84532.json'));print(d['memberRegistry'])")"
POOL="$(python3 -c "import json;d=json.load(open('deployments/84532.json'));print(d['reservePool'])")"
SHOP="$DEPLOYER_ADDR"   # the deployer wallet doubles as the demo shop owner
TRANCHE="$(python3 -c "print(int('$SARRAF_ADDR',16))")"

# The public RPC is load-balanced and its nodes lag each other's nonce view,
# so back-to-back sends from one key hit "replacement transaction underpriced".
# A short settle after every send serializes against the slowest node.
step() { echo "== $1"; shift; "$@" >/dev/null; sleep 4; }

echo "shop=$SHOP sarraf=$SARRAF_ADDR insurance=$DEP"

# 1. the sarraf needs own-tranche hawala for the bond; the shop needs a
#    premium float. Membership first (idempotent-ish: addMember may revert if
#    already a member — tolerate).
cast send --rpc-url "$RPC" --private-key "$SARRAF_KEY" "$REG" "addMember(address)" "$SARRAF_ADDR" >/dev/null 2>&1 || true
sleep 4
cast send --rpc-url "$RPC" --private-key "$SARRAF_KEY" "$REG" "addMember(address)" "$SHOP" >/dev/null 2>&1 || true
sleep 4

step "sarraf issues himself the bond (50 hawala)" \
  cast send --rpc-url "$RPC" --private-key "$SARRAF_KEY" "$POOL" "issue(address,uint256)" "$SARRAF_ADDR" 50000000
step "sarraf issues the shop a premium float (5 hawala)" \
  cast send --rpc-url "$RPC" --private-key "$SARRAF_KEY" "$POOL" "issue(address,uint256)" "$SHOP" 5000000

# 2. approvals: everyone lets the insurance contract move their hawala
step "sarraf approves insurance" \
  cast send --rpc-url "$RPC" --private-key "$SARRAF_KEY" "$IOU" "setApprovalForAll(address,bool)" "$DEP" true
step "shop approves insurance" \
  cast send --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" "$IOU" "setApprovalForAll(address,bool)" "$DEP" true
step "customer approves insurance" \
  cast send --rpc-url "$RPC" --private-key "$CUSTOMER_KEY" "$IOU" "setApprovalForAll(address,bool)" "$DEP" true

# 3. register the shop: 50-hawala bond, trust 1.0x
step "sarraf registers the shop (bond 50, trust 1.0x)" \
  cast send --rpc-url "$RPC" --private-key "$SARRAF_KEY" "$DEP" "registerShop(address,uint256,uint32)" "$SHOP" 50000000 10000

# 4. THE PURCHASE: customer pays the shop 10 hawala through payShop
step "customer pays the shop 10 hawala (insured)" \
  cast send --rpc-url "$RPC" --private-key "$CUSTOMER_KEY" "$DEP" "payShop(address,uint256)" "$SHOP" 10000000

# 5. buyer confirms at the counter: coverage closes, premium earns
step "customer confirms receipt (purchase 1)" \
  cast send --rpc-url "$RPC" --private-key "$CUSTOMER_KEY" "$DEP" "confirmReceipt(uint256)" 1

echo "== state after:"
echo "  bondOf(shop):        $(cast call --rpc-url "$RPC" "$DEP" "bondOf(address)(uint256)" "$SHOP")"
echo "  shop hawala balance: $(cast call --rpc-url "$RPC" "$IOU" "balanceOf(address,uint256)(uint256)" "$SHOP" "$TRANCHE")"
echo "  earnedOf(sarraf):    $(cast call --rpc-url "$RPC" "$DEP" "earnedOf(address)(uint256)" "$SARRAF_ADDR")"
echo "  withdrawable(sarraf):$(cast call --rpc-url "$RPC" "$DEP" "withdrawableOf(address)(uint256)" "$SARRAF_ADDR")"
echo "  maintainer earned:   $(cast call --rpc-url "$RPC" "$DEP" "earnedMaintainerOf(uint256)(uint256)" "$TRANCHE")"
