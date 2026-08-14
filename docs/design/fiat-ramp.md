# Design: Fiat ramp, rates & P2P escrow (act-1.5 — the Sarraf product loop)

Status: DESIGN — awaiting founder sign-off. No code yet.

This is the missing heart of the PoC: the flows a money-changer (Sarraf) and
their customers actually use daily. The current build proves the on-chain
plumbing (mint/transfer/redeem/offline-notes) but not the *product*. This spec
adds the fiat↔IOU on/off ramp, live exchange rates, and peer-to-peer trading
with escrow and dispute resolution.

## 0. The one architectural truth

**The fiat leg is off-chain and trust-based.** A rial/lira bank transfer or
cash handover cannot be verified on-chain. Every design choice below follows
from this:

| Layer | What lives here | Trust |
|---|---|---|
| On-chain | IOU mint/burn; IOU locked in escrow for P2P | Trustless |
| Off-chain | The local-currency payment + its evidence (bank receipt PDF/image); the exchange-rate quotes | Trust + evidence |
| The bridge | A human (seller, or the minting Sarraf) attests the fiat leg; the **minting Sarraf arbitrates disputes** because they hold the KYC and the reserve backing that tranche | Reputation / franchise value |

## 1. Terminology (per-locale, NOT "bid/ask")

The natural money-changer terms:

| Locale | Sarraf BUYS USDT (pays fiat) | Sarraf SELLS USDT (takes fiat) |
|---|---|---|
| en | Buy rate | Sell rate |
| fa | نرخ خرید | نرخ فروش |
| tr | Alış | Satış |
| ar | سعر الشراء | سعر البيع |

Rate = local-currency units per 1 USDT-IOU. All rates are per (Sarraf, fiat
currency) pair.

## 2. Exchange rates — INDICATIVE day rates + firm RFQ (DECIDED, revised 2026-08-14)

Two tiers, matching real dealer/OTC practice:

**Tier 1 — indicative board rate (guidance only).** Sarrafs set rates MANUALLY,
typically once a day. The board rate is displayed everywhere clearly labeled
**"indicative / daily guidance — request a quote for the real price"**. It is
NOT executable and NOT a firm offer. A signed record, valid until the Sarraf
posts a newer one:

```
IndicativeRate (EIP-712, signed by the Sarraf):
  sarraf:       address
  fiat:         string   // "IRR" | "TRY" | ...
  buyRate:      string   // fiat per 1 USDT the Sarraf PAYS to buy USDT from you
  sellRate:     string   // fiat per 1 USDT the Sarraf CHARGES to sell USDT to you
  minUsdt / maxUsdt: string
  effectiveFrom: uint64  // valid until superseded
  nonce:        uint64
```
- Off-chain (default): indexer serves the current record per (Sarraf, fiat);
  Sarraf updates from the desk. On-chain posting is also viable at daily cadence
  (auditable, trivial gas) — off-chain default only to spare a wallet tx.

**Tier 2 — firm price via RFQ (the executable price).** The real price is given
**after a customer RFQ**. The customer requests a quote for a specific trade;
the Sarraf returns a firm, short-lived signed quote for THAT trade; the customer
accepts within the TTL and the ramp executes against it.

```
RFQ (customer → Sarraf):        direction (on/off-ramp), fiat, usdtAmount OR fiatAmount
FirmQuote (EIP-712, Sarraf →):  sarraf, customer, direction, usdtAmount, fiatAmount,
                                 validUntil (short, e.g. 60–300s), quoteId, nonce
```
- **The firm price is a function of order SIZE.** This is the core reason RFQ
  exists: the indicative board rate is for standard/small size; a large order
  moves the Sarraf's inventory and is priced differently (wider spread), split,
  or declined. The RFQ carries the amount precisely so the Sarraf can price to
  size. The indicative board may show size-tiered guidance (e.g. a rate band for
  `<min`, `min–max`, and "RFQ for larger"), and `minUsdt/maxUsdt` on the
  IndicativeRate bound where the board number even applies.
- The **FirmQuote (not the indicative board rate) is what the order snapshots**
  for dispute evidence — it's the size-specific price both sides actually agreed.
- In the PoC the Sarraf answers RFQs manually from the desk (the indicative
  rate pre-fills their response; they adjust for size/timing and send). The
  post-PoC pricing SDK (§2a) can auto-answer RFQs from the reference+spread model,
  including a size/impact curve.
- This is why a manual day rate is safe to show: it's guidance; nobody trades on
  a stale number — the firm price is struck per trade, for that size, at request
  time.

Note: P2P orders (§4) are inherently firm — the maker posts a take-it-or-leave-it
price (using the indicative board as their own guidance), so P2P needs no RFQ
round; the posted order price is the firm offer the taker accepts.

### 2a. Pricing SDK / API (POST-PoC, designed-for)

The rate record above is agnostic to *who produced the numbers* — a human
typing them or an algorithm computing them yield the identical signed record.
So a professional-pricing layer slots in without changing anything downstream:

```
reference mid  ──►  Sarraf pricing policy  ──►  buy/sell  ──►  signed RateRecord
(PriceSource)      (spread, skew, caps,          (computed)     (same format as §2)
                    manual override)
```
- **`PriceSource`**: pluggable reference mid per corridor — USDT/IRR from a
  market feed, or composed (USDT/USD ≈ 1 × IRR/USD FX feed).
- **Pricing policy**: `spread` (width around mid), `skew` (shift mid to manage
  inventory — long USDT ⇒ skew to favor selling), floors/caps, manual override.
- **SDK/agent**: computes `buy/sell = f(reference, spread, skew)` and auto-posts
  the signed record at the Sarraf's chosen cadence.
- Product gradient: a corner-shop Sarraf types one number a day; a professional
  desk wires a feed + spread model for near-realtime prices — same rail, same
  format. The pricing SDK + reference feeds are a defensibility angle (keep
  sophisticated Sarrafs on Dovizir's tooling). Out of PoC scope; the format is
  built so it needs no change when this lands.

## 3. Direct ramp with a Sarraf (Part A — NO new contract)

The Sarraf is the counterparty. Reuses the deployed protocol (`issue`/`redeem`)
plus an off-chain order + evidence layer in the indexer.

### On-ramp (fiat → IOU): "I have rial, give me USDT-IOU"
1. Customer picks a Sarraf + amount → sees the Sarraf's **sell rate** → creates
   an on-ramp order (off-chain, indexer). Order = OPEN, references the quote hash.
2. Customer pays the Sarraf's local bank account (details shown in-app,
   off-chain) → uploads the **bank receipt** (PDF/image). Order = FIAT_CLAIMED,
   receipt hash recorded.
3. Sarraf reviews the receipt → confirms → calls `ReservePool.issue(customer,
   usdtAmount)`. Order = SETTLED. The on-chain `Issued` event closes the order
   (indexer links them).
   - Backing note: the Sarraf must have deposited USDT backing (funded issuance,
     M1 rule) — the fiat they received off-chain is what they'll use to top up
     backing. For PoC/testnet the backing is mock USDT; the fiat is the receipt.

### Off-ramp (IOU → fiat): "I have USDT-IOU, give me rial"
1. Customer picks a Sarraf + amount → sees **buy rate** → creates off-ramp order.
2. Customer redeems / sends IOU to the Sarraf on-chain (existing `redeem`).
3. Sarraf pays the customer's bank account off-chain → uploads the receipt →
   confirms. Order = SETTLED.

Evidence (receipts) stored by the indexer (off-chain blob + hash); the hash is
the tamper-evident anchor. "Regional banking verification" for PoC = **manual**
(the Sarraf eyeballs the receipt), behind an `IFiatVerifier` seam so a future
per-corridor bank-API/oracle impl (Iran Shaparak/Shetab card-to-card, Turkish
FAST webhooks) drops in without changing the flow.

## 4. P2P escrow (Part B — NEW `Escrow.sol`, needs security review)

Another *user* is the counterparty; the Sarraf only arbitrates. Trust model:
**seller confirms + minting-Sarraf arbitrates** (DECIDED).

### Actors
- **Maker** — sells IOU, wants fiat. Locks IOU into escrow.
- **Taker** — has fiat, wants IOU. Pays fiat off-chain.
- **Arbiter** — the Sarraf who minted the escrowed tranche. Derived on-chain
  from the tranche id (`trancheId = uint256(uint160(sarraf))`), so the arbiter
  is cryptographically the tranche's issuer — cannot be spoofed.

### State machine
```
OPEN ──(taker fills)──► MATCHED ──(taker uploads receipt)──► FIAT_CLAIMED
  │                        │                                     │
  │(maker cancels,         │(payment-window                      ├─(maker confirms)──► SETTLED  [IOU → taker]
  │ pre-fill)              │ elapsed, no fill)                    │
  ▼                        ▼                                     ├─(confirm-window elapsed)─► DISPUTE
REFUNDED [IOU→maker]   REFUNDED [IOU→maker]                       │
                                                                 └─(taker raises)──► DISPUTE
DISPUTE ──(arbiter decides)──► RESOLVED_TAKER [IOU→taker]  |  RESOLVED_MAKER [IOU→maker]
```

### Rules
- Maker locks `usdtAmount` of tranche T + records: fiat currency, agreed fiat
  amount, quote hash, their (off-chain) bank details reference, payment-window.
- One active fill per order. On MATCHED a payment-window timer starts.
- Taker pays fiat off-chain → uploads receipt (hash on-chain, blob off-chain) →
  FIAT_CLAIMED, confirm-window timer starts.
- Happy path: maker confirms receipt → IOU released to taker → SETTLED.
- Griefing coverage:
  - Taker fills but never pays → payment-window elapses → maker cancels → IOU
    refunded to maker.
  - Maker never confirms despite payment → confirm-window elapses OR taker
    raises → DISPUTE.
- **DISPUTE** → the arbiter (minting Sarraf of T) reviews the receipt + quote
  and calls `resolve(orderId, toTaker|toMaker)`. Final for PoC. (Appeal /
  soulbound-reputation layer is a later act; dispute is the Sarraf's job per the
  founder docs.)
- Arbiter cannot be maker or taker of the same order (no self-deal) — flagged
  edge: a Sarraf trading their own tranche must route through a different tranche
  or is blocked from arbitrating their own trade.
- CEI + reentrancy guard; all IOU transfers after state writes; evidence hash
  immutable once set; timers bounded.

### What's on-chain vs off-chain in P2P
- On-chain: the escrowed IOU, order state, timers, the receipt **hash**, the
  arbiter's resolution.
- Off-chain (indexer): the order book, the receipt **blob**, the chat/timer UI
  (US#5), bank-detail exchange, the signed rate quote.

## 5. Repo touchpoints

- **Contracts:** new `Escrow.sol` (P2P only — Part A needs none). No change to M1
  contracts. Deploy.s.sol += Escrow. Escrow gets the same adversarial-review
  pass M1 got before merge.
- **Indexer:** rate-quote store/serve; on/off-ramp order model + receipt store;
  P2P order book; escrow event indexing; `IFiatVerifier` seam (manual now).
- **Web:** rates board (consumer + desk); on/off-ramp order screens with receipt
  upload; P2P marketplace + escrow flow (chat + countdown, US#5); **dispute
  console on the Sarraf desk**. en+fa first.
- **SDK:** Escrow ABI; EIP-712 quote sign/verify helpers.

## 6. Security surface (for the Escrow.sol review)

The only value at risk is escrowed IOU; the attack is release-to-wrong-party.
Review must cover: arbiter-spoofing (derive from tranche, don't trust a param);
reentrancy on release/refund; double-fill / double-resolve; timer manipulation;
evidence-hash immutability; arbiter self-deal; and a maker/taker griefing matrix.
Same rigor as M1 (which is why two independent reviewers found the conviction
drain there).

## 7. Suggested build order (once signed off)
1. Rates: quote format + indexer serve + rates board (consumer + desk). Cheap,
   high-visual-impact, unblocks everything.
2. Part A direct ramp: on/off-ramp order model + receipt evidence + Sarraf
   confirm UI. Proves the core story with zero new contract risk.
3. Part B: `Escrow.sol` + adversarial review + P2P marketplace UI + dispute
   console. The harder, trust-critical pass.

## 8. Open questions for the founder
- **Bank details exchange:** how do counterparties share bank/card numbers —
  in-app (indexer, encrypted) or out-of-band? PoC default: in-app, per-order,
  visible only to the matched counterparty.
- **Which fiat corridors for the PoC demo?** IRR + TRY assumed (Iran-via-Turkey
  pilot). Confirm.
- **Real bank verification:** out of PoC scope (manual + seam). When it comes,
  it's a per-corridor integration — worth naming the target rails now (Iran
  Shetab/Shaparak card-to-card receipts? Turkish FAST?).
