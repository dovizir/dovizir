"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import { useDovizirWallet } from "@/lib/embedded/use-wallet";
import { JoinCapture } from "@/components/join-capture";
import { indexer } from "@/lib/indexer";
// @ts-expect-error — plain-JS module, tested standalone (steps.test.mjs)
import { deriveOnboardingStep } from "@/lib/onboarding/steps.mjs";
import { getWelcomed, setWelcomed, hasStoredWallet } from "@/lib/onboarding/state";

/**
 * Onboarding — the four screens from the Figma "Onboarding" section:
 * join-your-sarraf, passkey create, wallet-ready, and welcome-back unlock.
 * Which one shows is decided by the tested step machine; "join" -> "create"
 * is the only local advance (accepting the invite is an action, not a state).
 */

type LocalStep = "join" | "create" | "ready" | "unlock" | "done";

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/* Small inline icons (same glyphs as the Figma frames). */
function Icon({ d, className }: { d: string | string[]; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {(Array.isArray(d) ? d : [d]).map((p) => (
        <path key={p} d={p} />
      ))}
    </svg>
  );
}

const GIFT = [
  "M3 9a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z",
  "M12 8v13",
  "M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7",
  "M7.5 8a2.5 2.5 0 0 1 0-5C9.5 3 11 5 12 8c1-3 2.5-5 4.5-5a2.5 2.5 0 0 1 0 5",
];
const TAG = [
  "M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z",
  "M7.5 7.5h.01",
];
const SHIELD = [
  "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1 1 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z",
];
const FINGERPRINT = [
  "M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4",
  "M14 13.12c0 2.38 0 6.38-1 8.88",
  "M17.29 21.02c.12-.6.43-2.3.5-3.02",
  "M2 12a10 10 0 0 1 18-6",
  "M2 16h.01",
  "M21.8 16c.2-2 .131-5.354 0-6",
  "M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2",
  "M8.65 22c.21-.66.45-1.32.57-2",
  "M9 6.8a6 6 0 0 1 9 5.2v2",
];
const CHECK = ["m5 12.5 4.5 4.5L19 7.5"];

function Bullet({ icon, children, tone }: { icon: string[]; children: ReactNode; tone?: "success" }) {
  return (
    <li className="flex items-center gap-md">
      <Icon d={icon} className={`h-5 w-5 shrink-0 ${tone === "success" ? "text-success" : "text-primary"}`} />
      <span className="text-sm text-foreground">{children}</span>
    </li>
  );
}

function Hero({ icon, tone }: { icon: string[]; tone: "primary" | "success" }) {
  return (
    <div
      className={`mx-auto flex h-24 w-24 items-center justify-center rounded-full ${
        tone === "success" ? "bg-success/10" : "bg-primary/10"
      }`}
    >
      <Icon d={icon} className={`h-12 w-12 ${tone === "success" ? "text-success" : "text-primary"}`} />
    </div>
  );
}

function PrimaryButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="w-full rounded-pill bg-primary px-lg py-md text-sm font-medium text-primary-foreground shadow-sm disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export default function WelcomePage() {
  const t = useTranslations("onboarding");
  const tCommon = useTranslations("common");
  const navigate = useNavigate();
  const { address, isReady, isPending, create, reset, joinedSarraf: storedSarraf } = useDovizirWallet();

  // JoinCapture persists ?sarraf= in an after-render effect, so on the very
  // first render the stored value is stale — read the URL directly as well.
  const [urlSarraf] = useState(() => {
    const param = new URLSearchParams(window.location.search).get("sarraf");
    return param && /^0x[0-9a-fA-F]{40}$/.test(param) ? param : null;
  });
  const joinedSarraf = storedSarraf ?? urlSarraf;

  // The derived entry step, plus the single local advance (join -> create).
  const [accepted, setAccepted] = useState(false);
  const [failed, setFailed] = useState(false);
  const derived: LocalStep = deriveOnboardingStep({
    hasWallet: hasStoredWallet(),
    isConnected: isReady,
    joinedSarraf,
    welcomed: getWelcomed(),
  });
  const step: LocalStep = derived === "join" && accepted ? "create" : derived;

  // Done means there is nothing to show here.
  useEffect(() => {
    if (step === "done") navigate("/", { replace: true });
  }, [step, navigate]);

  // Certification is shown from indexer truth, never asserted blindly.
  const sarrafInfo = useQuery({
    queryKey: ["onboarding-sarraf", joinedSarraf],
    queryFn: () => indexer.sarraf(joinedSarraf as string),
    enabled: step === "join" && !!joinedSarraf,
    retry: false,
  });

  const begin = useMemo(
    () => async () => {
      setFailed(false);
      try {
        await create();
      } catch {
        setFailed(true);
      }
    },
    [create],
  );

  return (
    <div className="min-h-dvh bg-background">
      <JoinCapture />
      <header className="mx-auto flex max-w-[28rem] items-center px-lg py-md">
        <span className="flex items-center gap-xs font-heading text-base font-extrabold text-primary">
          <img src="/logo.svg" alt="" width="24" height="24" className="block" />
          {tCommon("appName")}
        </span>
      </header>

      <main className="mx-auto flex max-w-[28rem] flex-col gap-xl px-lg py-xl">
        {step === "join" && (
          <>
            <div className="flex flex-col gap-sm">
              <h1 className="font-heading text-2xl font-extrabold text-primary">{t("join.title")}</h1>
              <p className="text-sm text-muted">{t("join.subtitle")}</p>
            </div>

            {joinedSarraf ? (
              <div className="flex items-center gap-md rounded-lg border border-border bg-surface p-lg shadow-sm">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-base font-medium text-primary">
                  S
                </div>
                <div className="min-w-0">
                  <p className="text-base font-medium text-foreground" dir="ltr">
                    {shortAddress(joinedSarraf)}
                  </p>
                  <div className="mt-xs flex flex-wrap items-center gap-sm">
                    {sarrafInfo.data?.certBand === "certified" && (
                      <span className="rounded-pill bg-success/10 px-md py-xs text-xs font-medium text-success">
                        {t("join.certified")}
                      </span>
                    )}
                    {typeof sarrafInfo.data?.memberCount === "number" && (
                      <span className="text-xs text-muted">
                        {t("join.members", { count: sarrafInfo.data.memberCount })}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border bg-surface p-lg">
                <p className="text-sm font-medium text-foreground">{t("join.noSarrafTitle")}</p>
                <p className="mt-xs text-sm text-muted">{t("join.noSarrafHint")}</p>
              </div>
            )}

            <ul className="flex flex-col gap-md">
              <Bullet icon={GIFT}>{t("join.benefitDaily")}</Bullet>
              <Bullet icon={TAG}>{t("join.benefitPurchases")}</Bullet>
              <Bullet icon={SHIELD}>{t("join.benefitPrivacy")}</Bullet>
            </ul>

            <PrimaryButton onClick={() => setAccepted(true)}>
              {joinedSarraf ? t("join.cta") : t("join.ctaNoSarraf")}
            </PrimaryButton>
          </>
        )}

        {step === "create" && (
          <>
            <Hero icon={FINGERPRINT} tone="primary" />
            <div className="flex flex-col gap-sm text-center">
              <h1 className="font-heading text-2xl font-extrabold text-primary">{t("create.title")}</h1>
              <p className="text-sm text-muted">{t("create.subtitle")}</p>
            </div>

            <ul className="flex flex-col gap-md">
              <Bullet icon={CHECK} tone="success">{t("create.pointDevice")}</Bullet>
              <Bullet icon={CHECK} tone="success">{t("create.pointNothing")}</Bullet>
              <Bullet icon={CHECK} tone="success">{t("create.pointFree")}</Bullet>
            </ul>

            {failed && <p className="text-sm text-danger">{t("create.failed")}</p>}
            <PrimaryButton onClick={begin} disabled={isPending}>
              {isPending ? t("create.creating") : t("create.cta")}
            </PrimaryButton>
          </>
        )}

        {step === "ready" && (
          <>
            <Hero icon={CHECK} tone="success" />
            <div className="flex flex-col gap-sm text-center">
              <h1 className="font-heading text-2xl font-extrabold text-success">{t("ready.title")}</h1>
              <p className="text-sm text-muted">
                {joinedSarraf ? t("ready.subtitleWithSarraf") : t("ready.subtitle")}
              </p>
              {address && (
                <p className="text-xs text-muted" dir="ltr">
                  {shortAddress(address)}
                </p>
              )}
            </div>

            <div className="flex items-center gap-md rounded-lg border border-border bg-surface p-lg shadow-sm">
              <Icon d={GIFT} className="h-6 w-6 shrink-0 text-primary" />
              <div>
                <p className="text-sm font-medium text-foreground">{t("ready.giftTitle")}</p>
                <p className="text-xs text-muted">{t("ready.giftBody")}</p>
              </div>
            </div>

            <PrimaryButton
              onClick={() => {
                setWelcomed();
                navigate("/", { replace: true });
              }}
            >
              {t("ready.cta")}
            </PrimaryButton>
          </>
        )}

        {step === "unlock" && (
          <>
            <Hero icon={FINGERPRINT} tone="primary" />
            <div className="flex flex-col gap-sm text-center">
              <h1 className="font-heading text-2xl font-extrabold text-primary">{t("unlock.title")}</h1>
              <p className="text-sm text-muted">{t("unlock.subtitle")}</p>
            </div>

            {failed && <p className="text-sm text-danger">{t("create.failed")}</p>}
            <PrimaryButton onClick={begin} disabled={isPending}>
              {isPending ? t("unlock.unlocking") : t("unlock.cta")}
            </PrimaryButton>

            <button
              type="button"
              onClick={async () => {
                await reset();
                setAccepted(false);
              }}
              className="text-center text-sm font-medium text-danger"
            >
              {t("unlock.switchAccount")}
            </button>
            <p className="text-center text-xs text-muted">{t("unlock.switchWarning")}</p>
          </>
        )}
      </main>
    </div>
  );
}
