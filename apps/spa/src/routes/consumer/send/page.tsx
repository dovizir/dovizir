"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useAccount } from "wagmi";
import { formatIou, parseIou, type Hex } from "@dovizir/sdk";
import { AmountField } from "@/components/amount-field";
import { NotDeployedBanner } from "@/components/not-deployed-banner";
import { useFriendlyTx, useIouBalance, useSend } from "@/lib/hooks";
import { looksLikeContact, useContactResolve } from "@/lib/hooks/use-contact-resolve";

type Method = "direct" | "courier";

const isAddress = (value: string): value is Hex => /^0x[0-9a-fA-F]{40}$/.test(value);

/** Send: direct on-chain transfer or courier (sign & relay) authorization. */
export default function SendPage() {
  const t = useTranslations("send");
  const tCommon = useTranslations("common");
  const { isConnected } = useAccount();
  const { total } = useIouBalance();
  const send = useSend();
  const friendly = useFriendlyTx();

  const [recipient, setRecipient] = useState("");
  const resolution = useContactResolve(recipient);
  // What actually receives the money: a pasted address as-is, or the wallet
  // the directory resolved a phone/email to. The raw-address path never
  // consults the directory — that is the degradation rule.
  const effectiveRecipient: string =
    resolution.state === "found" ? resolution.wallet : recipient;
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<Method>("direct");
  const [status, setStatus] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  const parsedAmount = (() => {
    try {
      return amount ? parseIou(amount) : 0n;
    } catch {
      return 0n;
    }
  })();

  const canSubmit =
    isConnected && isAddress(effectiveRecipient) && parsedAmount > 0n && status !== "busy";

  async function onSubmit() {
    if (!isAddress(effectiveRecipient)) return;
    setError(null);
    setStatus("busy");
    try {
      if (method === "direct") {
        await send.sendDirect(effectiveRecipient as Hex, parsedAmount);
        friendly.markUsed(); // UI-stub quota tick; paymaster enforces later
        setStatus("done");
      } else {
        await send.signCourierAuthorization(effectiveRecipient as Hex, parsedAmount);
        setStatus("idle");
      }
    } catch (e) {
      setStatus("idle");
      setError(
        e instanceof Error && e.message === "insufficient"
          ? t("insufficient")
          : tCommon("error"),
      );
    }
  }

  async function onRelay() {
    if (!send.signed) return;
    setError(null);
    setStatus("busy");
    try {
      await send.relayAuthorization(send.signed);
      send.clearSigned();
      friendly.markUsed();
      setStatus("done");
    } catch {
      setStatus("idle");
      setError(tCommon("error"));
    }
  }

  return (
    <div className="flex flex-col gap-xl">
      <NotDeployedBanner />

      <header>
        <h1 className="text-xl font-medium text-foreground">{t("title")}</h1>
        <p className="mt-xs text-sm text-muted">{t("subtitle")}</p>
      </header>

      {/* Zero-fee framing (static for M2; paymaster sponsorship makes it real) */}
      <div className="flex gap-sm">
        <span className="rounded-pill bg-success/15 px-md py-xs text-xs font-bold text-success">
          {t("zeroFee")}
        </span>
        <span className="rounded-pill bg-primary/10 px-md py-xs text-xs font-bold text-primary">
          {t("gasSponsored")}
        </span>
      </div>

      <section className="flex flex-col gap-lg rounded-lg bg-surface p-xl shadow-card">
        <div>
          <label
            htmlFor="recipient"
            className="mb-xs block text-sm font-medium text-muted"
          >
            {t("recipient")}
          </label>
          <input
            id="recipient"
            dir="ltr"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder={t("recipientPlaceholder")}
            className="w-full rounded-md border border-border bg-surface-alt px-lg py-md text-sm text-foreground outline-none placeholder:text-muted focus:border-focus"
          />
          {resolution.state === "resolving" && (
            <p className="mt-xs text-xs text-muted">{t("contactResolving")}</p>
          )}
          {resolution.state === "found" && (
            <p className="mt-xs text-xs text-accent" dir="ltr">
              ✓ {resolution.wallet.slice(0, 10)}…{resolution.wallet.slice(-6)}
            </p>
          )}
          {resolution.state === "notFound" && (
            <p className="mt-xs text-xs text-danger">{t("contactNotFound")}</p>
          )}
          {resolution.state === "unavailable" && (
            <p className="mt-xs text-xs text-muted">{t("contactUnavailable")}</p>
          )}
          {resolution.state === "limited" && (
            <p className="mt-xs text-xs text-muted">{t("contactLimited")}</p>
          )}
          {recipient && resolution.state === "idle" && !isAddress(recipient) && !looksLikeContact(recipient) && (
            <p className="mt-xs text-xs text-danger">{t("invalidRecipient")}</p>
          )}
        </div>

        <AmountField value={amount} onChange={setAmount} id="send-amount" />
        {parsedAmount > total && (
          <p className="text-xs text-danger">{t("insufficient")}</p>
        )}

        <fieldset className="flex flex-col gap-sm">
          {(
            [
              ["direct", t("methodDirect"), t("methodDirectHint")],
              ["courier", t("methodCourier"), t("methodCourierHint")],
            ] as const
          ).map(([value, label, hint]) => (
            <label
              key={value}
              className={`flex cursor-pointer items-start gap-md rounded-md border p-md ${
                method === value ? "border-primary bg-primary/5" : "border-border"
              }`}
            >
              <input
                type="radio"
                name="method"
                value={value}
                checked={method === value}
                onChange={() => setMethod(value)}
                className="mt-xs accent-primary"
              />
              <span>
                <span className="block text-sm font-medium text-foreground">
                  {label}
                </span>
                <span className="block text-xs text-muted">{hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {error && <p className="text-sm text-danger">{error}</p>}
        {status === "done" && (
          <p className="rounded-md bg-success/10 p-md text-sm text-success">
            {tCommon("submitted")}
          </p>
        )}

        <button
          type="button"
          disabled={!canSubmit}
          onClick={onSubmit}
          className="rounded-pill bg-primary py-md text-sm font-bold text-primary-foreground disabled:opacity-50"
        >
          {method === "direct" ? t("sendNow") : t("signAuthorization")}
        </button>

        {send.signed && (
          <div className="rounded-md border border-primary/30 bg-primary/5 p-md">
            <p className="text-sm text-foreground">{t("authorizationSigned")}</p>
            <p className="mt-xs break-all text-xs text-muted" dir="ltr">
              {formatIou(send.signed.authorization.amount)} →{" "}
              {send.signed.authorization.to}
            </p>
            <button
              type="button"
              disabled={status === "busy"}
              onClick={onRelay}
              className="mt-md rounded-pill border border-primary px-xl py-sm text-sm font-bold text-primary disabled:opacity-50"
            >
              {t("relayNow")}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
