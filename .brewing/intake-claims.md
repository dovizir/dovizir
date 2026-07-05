# Dovizir — doc-sourced intent claims (UNVERIFIED unless marked)

> §7.18 docs path: doc-as-intent, code-as-truth. Sources: [Stories]=Dovizir Stories 2.0,
> [Comp]=Comprehensive Document v2 (CONFIDENTIAL), [Inv]=Investor's Business Insight.
> Verification status added where .brewing/as-built.md already answers.

## Vision (claimed)
Modernized Hawala on smart contracts + stablecoins for high-inflation, capital-controlled
economies (Iran first via Turkey pilot): USDT deposits mint fungible "Hawala credits"
(digital IOUs); local money-changers ("Sarrafs") do human KYC, liquidity, and act as
privacy proxy wallets. [Comp §2-3]

## Resolved-by-code
- **Chain platform contradiction**: [Inv] claims Algorand; [Comp] says Ethereum L2
  (Arbitrum or Base) + Tron ramp; [Stories] says Tron+Ethereum. CODE SAYS: Base Sepolia
  (84532) only — [Comp]'s L2 path won; Algorand claim is dead; Tron ramp not present.
- **Where the product actually is**: docs describe a full mobile app + P2P marketplace +
  Sarraf network. CODE HAS: 3 MVP contracts (ReservePool/Fees/CreditOracle), a stub
  indexer, an unwired one-button demo page. Nearly all doc claims are ROADMAP, not built.

## Key mechanism claims (verify against contracts as they land)
- Fee: 0.9% merchant "transaction insurance"; Scenario-2 split 198.20/1.80 per 200 USDT
  → Fraud Insurance Fund. [Comp][Stories US#7]
  ⚠ CODE: fee is a FLAT wei amount per tx (Fees.sol), not a percentage — divergence.
- Fraud Insurance Fund: 50% net profit → overseeing Sarraf, 50% → maintenance/gas. [Comp]
- Fractional reserve: CreditMultiplier = 1 + (R×T×min(D/Dmax,1))×0.2, cap 1.2×; margin
  call < deposits/(mult×1.1), 24h cure. [Comp Sc.5] ⚠ CODE: CreditOracle caps
  creditRateBps at 2500 (25%) — reconcile 20% vs 25%.
- Mint/redeem 1:1 USDT, pooled treasury, credits fungible; redeem to ERC20/TRC20. [Comp]
- Cross-currency (e.g. TRY) issuance: +15-20% over-collateral buffer, margin call <5%. [Comp Sc.8]
- Free P2P within Circle of Trust, rate-limited. [Comp Sc.7][Stories US#6]
- Slow Mode + multi-party approval above ~5,000 USDT. [Comp §8]
- Soulbound reputation tokens; 3→5 Maintainer jury w/ Schelling voting. [Comp §3C,§5]
- [Inv]-only: verification SUBSCRIPTION fees = 85.5% of month-19 revenue (absent from
  [Comp]/[Stories]/code) — founder must rule which fee model is real.

## MVP stories ([Stories], condensed — the likely first dash story imports)
US#1 onboarding screens · US#2 OTP-only login (email/mobile; no passwords, no social) ·
US#3 seller Business Profile · US#4 contact sync + Trust badges · US#5 charge wallet
(Tron/Ethereum, USDT/USDC only; partner exchange; P2P buy w/ chat+timer) · US#6 zero-fee
pay-friends · US#7 seller bill links/QR w/ 0.9% insurance framing · US#8 seller P2P asset
sale (5,000 USDT min balance; ≤2× balance; 7-day inactivity/3-fail license revocation) ·
US#9 QR scan (bill vs raw address) · US#10 tx list · US#11 managed wallets, no dashboard
this phase · US#12 notifications · US#13 in-app support chat.

## Contradictions for founder ruling
1. Fee model: flat wei (code) vs 0.9% (docs) vs subscription-dominant ([Inv]).
2. Timeline/funding: 6mo/$180k [Comp] vs 5mo/$436k [Inv].
3. Credit cap: 1.2× [Comp] vs 25% bps cap (code).
4. Tron ramp + USDC support: in docs, absent in code.

## Explicit non-goals this phase [Stories]
No passwords · no social login · no buyer profile · Tron+Ethereum only · USDT+USDC only ·
no dashboard/home · notifications & support history not deletable.
