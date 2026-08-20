/**
 * A sarraf's purchase-insurance position, reduced from PurchaseInsurance events.
 *
 * This is the desk's answer to "what is in it for me": bonds under management,
 * premium accrued and earned, live covered exposure, and — the number they will
 * actually act on — what is withdrawable right now.
 *
 * Mirrors the contract deliberately, so the desk never disagrees with chain
 * state. Every rule below exists in PurchaseInsurance.sol; if one changes there,
 * it changes here.
 */
import type { IndexedEvent } from "./types.js";

/** Cushion each layer retains against live exposure. Mirrors the contract. */
export const RESERVE_RATIO_BPS = 1_000; // 10%
const BPS = 10_000n;

export interface SarrafInsurance {
  /** Sum of bonds posted by shops this sarraf underwrote. */
  bondsUnderManagement: bigint;
  shopCount: number;
  /** Premium inside its coverage window — accrued but not yet theirs. */
  unearned: bigint;
  /** Premium whose coverage closed. Withdrawable above the cushion. */
  earned: bigint;
  /** Covered purchase value still live, which the cushion is held against. */
  outstandingExposure: bigint;
  /** earned − reserveRatio × outstandingExposure, floored at zero. */
  withdrawable: bigint;
  /** Losses that pierced a shop's bond and reached this sarraf's layer. */
  strikes: number;
}

const lc = (v: unknown) => String(v ?? "").toLowerCase();
const big = (v: unknown) => BigInt(String(v ?? "0"));

export function sarrafInsurance(events: IndexedEvent[], sarraf: string): SarrafInsurance {
  const s = lc(sarraf);

  /** shop -> its underwriting sarraf, learned from ShopRegistered. Later events
   *  name only the shop, so attribution has to be carried forward. */
  const shopOwner = new Map<string, string>();
  const shopBond = new Map<string, bigint>();

  /** purchaseId -> what it put at risk. Coverage-closing events name only the
   *  purchase, never the amount, so the exposure to release has to be
   *  remembered from PurchaseRecorded. Four different events close coverage —
   *  earn, buyer confirmation, and either ruling — and every one of them must
   *  release, or the desk's exposure drifts upward forever and understates
   *  what the sarraf can withdraw. */
  const live = new Map<string, { amount: bigint; premium: bigint }>();

  /** Release a purchase's exposure exactly once, whichever path closed it. */
  const close = (purchaseId: string): { amount: bigint; premium: bigint } | undefined => {
    const rec = live.get(String(purchaseId));
    if (!rec) return undefined;
    live.delete(String(purchaseId));
    outstandingExposure -= rec.amount;
    return rec;
  };

  let unearned = 0n;
  let earned = 0n;
  let outstandingExposure = 0n;
  let strikes = 0;

  const mine = (shop: string) => shopOwner.get(lc(shop)) === s;
  /** The contract's frozen rounding: maintenance takes the floor half, the
   *  sarraf's layer takes the remainder, so an odd wei lands with the sarraf. */
  const sarrafCut = (premium: bigint) => premium - premium / 2n;

  for (const e of events) {
    if (e.contract !== "purchaseInsurance") continue;
    const a = e.args;

    switch (e.event) {
      case "ShopRegistered": {
        shopOwner.set(lc(a.shop), lc(a.sarraf));
        if (lc(a.sarraf) === s) shopBond.set(lc(a.shop), big(a.bond));
        break;
      }
      case "BondToppedUp": {
        if (!mine(a.shop)) break;
        shopBond.set(lc(a.shop), (shopBond.get(lc(a.shop)) ?? 0n) + big(a.amount));
        break;
      }
      case "BondReleased": {
        if (!mine(a.shop)) break;
        shopBond.set(lc(a.shop), (shopBond.get(lc(a.shop)) ?? 0n) - big(a.amount));
        break;
      }
      case "PurchaseRecorded": {
        if (!mine(a.shop)) break;
        unearned += sarrafCut(big(a.premium));
        outstandingExposure += big(a.amount);
        live.set(String(a.purchaseId), { amount: big(a.amount), premium: big(a.premium) });
        break;
      }
      case "PremiumEarned": {
        if (lc(a.sarraf) !== s) break;
        close(String(a.purchaseId));
        const cut = sarrafCut(big(a.premium));
        unearned -= cut;
        earned += cut;
        break;
      }
      case "ReceiptConfirmed": {
        // The buyer confirmed at the counter: coverage ends early and the
        // premium is earned immediately.
        const rec = close(String(a.purchaseId));
        if (!rec) break;
        const cut = sarrafCut(rec.premium);
        unearned -= cut;
        earned += cut;
        break;
      }
      case "ClaimRuled": {
        // Either ruling ends coverage. Rejected: the premium is earned.
        // Upheld: the loss is handled by LossAbsorbed, but the exposure it
        // stood against is released here regardless.
        const rec = close(String(a.purchaseId));
        if (!rec) break;
        if (String(a.upheld) === "false") {
          const cut = sarrafCut(rec.premium);
          unearned -= cut;
          earned += cut;
        }
        break;
      }
      case "LossAbsorbed": {
        if (!mine(a.shop)) break;
        // The waterfall drains unearned before earned, as the contract does.
        shopBond.set(lc(a.shop), (shopBond.get(lc(a.shop)) ?? 0n) - big(a.fromBond));
        let take = big(a.fromSarraf);
        const fromUnearned = take < unearned ? take : unearned;
        unearned -= fromUnearned;
        take -= fromUnearned;
        earned -= take < earned ? take : earned;
        break;
      }
      case "SarrafStrike": {
        if (lc(a.sarraf) === s) strikes = Number(a.strikes);
        break;
      }
      case "SarrafPenalized": {
        if (lc(a.sarraf) === s) earned -= big(a.amount);
        break;
      }
      case "Withdrawn": {
        if (lc(a.layer) === s) earned -= big(a.amount);
        break;
      }
    }
  }

  const bondsUnderManagement = [...shopBond.values()].reduce((t, v) => t + v, 0n);
  const cushion = (outstandingExposure * BigInt(RESERVE_RATIO_BPS)) / BPS;
  const withdrawable = earned > cushion ? earned - cushion : 0n;

  return {
    bondsUnderManagement,
    shopCount: shopBond.size,
    unearned,
    earned,
    outstandingExposure,
    withdrawable,
    strikes,
  };
}

/** Wire-safe form of {@link sarrafInsurance}: every bigint stringified, per
 *  the store.ts convention — a route returning raw bigints 500s on
 *  serialization. */
export function insuranceView(events: IndexedEvent[], sarraf: string) {
  const p = sarrafInsurance(events, sarraf);
  return {
    bondsUnderManagement: p.bondsUnderManagement.toString(),
    shopCount: p.shopCount,
    unearned: p.unearned.toString(),
    earned: p.earned.toString(),
    outstandingExposure: p.outstandingExposure.toString(),
    withdrawable: p.withdrawable.toString(),
    strikes: p.strikes,
  };
}
