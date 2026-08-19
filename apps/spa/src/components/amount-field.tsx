"use client";

import { useTranslations } from "next-intl";
import { UnitMark } from "@/components/unit-mark";

/** Shared decimal amount input (6-dp IOU/USDT amounts, LTR digits). */
export function AmountField({
  value,
  onChange,
  id = "amount",
}: {
  value: string;
  onChange: (value: string) => void;
  id?: string;
}) {
  const t = useTranslations("common");

  return (
    <div>
      <label htmlFor={id} className="mb-xs block text-sm font-medium text-muted">
        {t("amount")}
      </label>
      <div className="flex items-center gap-sm rounded-md border border-border bg-surface-alt px-lg py-md focus-within:border-focus">
        <input
          id={id}
          dir="ltr"
          inputMode="decimal"
          placeholder={t("amountPlaceholder")}
          value={value}
          onChange={(e) => {
            const next = e.target.value;
            if (next === "" || /^\d*\.?\d{0,6}$/.test(next)) onChange(next);
          }}
          className="w-full bg-transparent text-2xl font-medium text-foreground outline-none placeholder:text-muted"
        />
        <span className="text-sm font-medium text-muted"><UnitMark /></span>
      </div>
    </div>
  );
}
