"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useAccount } from "wagmi";
import { parseIou } from "@dovizir/sdk";
import { QrCode } from "@/components/notes/qr-code";
import { UnitMark } from "@/components/unit-mark";

/**
 * Seller terminal: type an amount, show the customer a QR. The QR encodes a
 * /pay deep link carrying the SHOP HANDLE (the connected wallet) and the
 * amount — never anything the customer must type, and the shop's address is
 * only inside the payment link, not printed on the wall.
 *
 * Settlement is payShop on the customer's phone: the shop is paid instantly,
 * and the purchase opens its insurance coverage in the same transaction.
 */
export default function PosPage() {
  const t = useTranslations("pos");
  const { address, isConnected } = useAccount();
  const [amount, setAmount] = useState("");

  const parsed = (() => {
    try {
      return amount ? parseIou(amount) : 0n;
    } catch {
      return 0n;
    }
  })();

  const link =
    isConnected && parsed > 0n
      ? `${window.location.origin}/pay?shop=${address}&amount=${parsed.toString()}`
      : null;

  return (
    <div className="flex flex-col gap-xl">
      <section className="rounded-lg bg-surface p-xl shadow-card">
        <h1 className="text-lg font-semibold text-foreground">{t("chargeTitle")}</h1>
        <p className="mt-xs text-sm text-muted">{t("chargeHint")}</p>

        <label className="mt-lg block text-sm font-medium text-muted" htmlFor="charge-amount">
          {t("chargeAmount")}
        </label>
        <div className="mt-xs flex items-center gap-sm">
          <input
            id="charge-amount"
            dir="ltr"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className="w-full rounded-md border border-border bg-surface-alt px-lg py-md text-lg text-foreground outline-none focus:border-focus"
          />
          <UnitMark />
        </div>

        {!isConnected && <p className="mt-md text-sm text-danger">{t("connectFirst")}</p>}

        {link && (
          <div className="mt-xl flex flex-col items-center gap-md">
            <QrCode value={link} />
            <p className="text-center text-sm text-muted">{t("showCustomer")}</p>
          </div>
        )}
      </section>
    </div>
  );
}
