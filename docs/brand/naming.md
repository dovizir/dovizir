# Dovizir naming & terminology — source of truth

Status: DRAFT — the unit name is a founder decision, recorded here provisionally.
This doc owns Dovizir's vocabulary. UI strings and marketing copy draw from it;
technical/contract names stay neutral (see the split below). When the unit name
is locked, we migrate "USDT-IOU" across docs + user-facing text to the owned term.

## 1. The unit — what it is

The core unit is a **dollar-backed hawala credit**: a digital IOU issued by a
Sarraf against USDT reserves, transferable peer-to-peer, redeemable ~1:1 for
USDT (delivered on the Tron/EVM leg at redemption). It is NOT itself USDT — it's
Dovizir's own credit instrument, backed by USDT.

### Naming decision (founder's call — options + recommendation)

| Option | Reads as | Ownership | Risk |
|---|---|---|---|
| **USDTH / "USDT Hawala"** (founder's initial preference) | "digital dollars, hawala-style" — instant legibility | WEAK — you cannot trademark/own a "USDT-*" name; Tether owns the mark | Tether trademark objection; brand tied to Tether's compliance (which freezes Iran-linked wallets); blurs "backed by USDT" vs "is USDT" |
| **Owned coined name + "USDT-backed" descriptor** (recommended) | your term = the noun you own; "USDT-backed dollar credit" = the tagline that keeps the "it's dollars" signal | STRONG — a name you can own, trademark, and defend | Marketing must establish "= digital dollars" (one tagline does it) |
| Neutral technical term only (e.g. "Dovizir credit") | functional, safe | Strong but flat | Less evocative than a coined mark |

**Recommendation:** coin an owned unit name; use **"USDT-backed"** (or "dollar
hawala credit") only as the descriptor, not the name. This is the only path that
actually satisfies "name it as our own" — because a USDT-derived name is, by
construction, Tether's to own, not yours. It also decouples the brand from
Tether's freeze posture, which matters for this corridor specifically.

**Provisional working name:** _(founder to fill)_ — candidates to weigh:
- a coined mark (e.g. a short Dovizir-native word) + "USDT-backed hawala credit"
- USDTH / "USDT Hawala" if the legibility win outweighs the ownership cost
Leave "USDT-IOU" in technical text until this is set.

### Technical vs marketing split (keep separate)
- **Contracts / code / this repo's technical layer:** stay neutral and precise —
  `IouToken`, "issuer-tranched IOU", "tranche". These never change with branding
  and avoid implying Tether affiliation in on-chain artifacts.
- **UI strings + marketing:** use the owned unit name. next-intl keys already
  isolate all user-facing text, so the unit name is one glossary value per
  locale — a clean swap, not a code change.

## 2. Glossary (owned terms — draw from this everywhere)

| Concept | Owned term (working) | Notes / per-locale |
|---|---|---|
| The unit | _(pending §1)_; "USDT-backed hawala credit" as descriptor | keep the descriptor consistent across locales |
| Money-changer / issuer | **Sarraf** (صرّاف) | already owned + culturally native; keep it — do NOT translate to "money changer" in-market |
| Offline cash notes | **Hawala notes** (working) | the carve→offline-spend→reconcile instrument; "hawala" here is fully ownable |
| Fiat→credit / credit→fiat | **on-ramp / off-ramp** (technical); market copy: "cash in / cash out" | |
| Indicative rate | **daily guidance rate** | labeled non-executable; see fiat-ramp.md §2 |
| Firm price | **RFQ price** / "your price" | size-dependent, struck per trade |
| P2P escrow trade | **P2P exchange** | maker/taker + Sarraf-arbitrated dispute |
| The insurance layer | **transaction insurance** (0.9% fee) | matches the docs' merchant framing |

## 3. Per-locale unit naming

The unit name + descriptor need native-speaker wording in each shipped locale
(the same gap flagged for buy/sell terms). "Sarraf" stays in every locale.
Table to fill with a native reviewer per corridor (fa, then tr/ar/ur/dari/kurdish).

**Brand rendering (founder-decided, 2026-08-21):** in Persian (fa) and Dari
(fa-AF) the brand is written **دویزیر** — one و, no ZWNJ. The earlier mixed
renderings (دوی‌زیر، دوویزیر) are superseded. Other Arabic-script locales
(ar, ur, ckb, ps) still await the same native ruling.

## 4. Migration checklist (when the unit name is locked)
- [ ] Set the unit name + descriptor here (§1) and per-locale (§3).
- [ ] Replace "USDT-IOU" in user-facing docs + UI i18n values with the owned term.
- [ ] Leave `IouToken` / "tranche" / technical prose unchanged.
- [ ] Update fiat-ramp.md and the pitch/site copy to the owned term.
