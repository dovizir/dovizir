"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  carveBatch,
  createInvoice,
  spendNote,
  verifyTranscript,
  type Hex,
  type NoteBatch,
  type VerifyResult,
} from "@dovizir/notes";
import { formatIou } from "@dovizir/sdk";
import { NotDeployedBanner } from "@/components/not-deployed-banner";
import { useAirplane } from "@/lib/notes/airplane";
import { solRootAndProof } from "@/lib/notes/bridge";
import {
  carveOnChain,
  iouBalance,
  isCarverReady,
  isLocalChain,
  reconcileOnChain,
  readVaultState,
  usdtBalance,
} from "@/lib/notes/chain";
import {
  CARVER,
  CERTS,
  ROOT_PUBLIC_KEY,
  SELLER1,
  SELLER2,
  shortHex,
} from "@/lib/notes/personas";

// Demo amounts (proven in scripts/offline-notes-e2e.mjs): carve 15,000 (a
// 10,000 + a 5,000 note); the 10,000 note is paid honestly to seller1, then
// double-spent to seller2. At conviction only 5,000 remains locked → seller2 is
// made whole from 5,000 seized collateral + 5,000 insurance USDT.
const NOTE = 10_000_000000n;
const REMAINDER = 5_000_000000n;

interface Ctx {
  expiry: number;
  batch: NoteBatch;
  onchainRoot: Hex;
  proof0: Hex[];
  serial: Hex;
  nonce1: Hex;
  nonce2: Hex;
  v1?: VerifyResult;
  v2?: VerifyResult;
  reservesBefore?: bigint;
  seller2UsdtBefore?: bigint;
}

type Line = { label: string; value: string; tone?: "ok" | "bad" | "muted" };
interface StepResult {
  lines: Line[];
  convict?: { carver: Hex; victim: Hex; seized: bigint; insurance: bigint; reservesBefore: bigint; reservesAfter: bigint };
}

export default function DemoPage() {
  const t = useTranslations("notes");
  const { airplane, setAirplane } = useAirplane();
  const ctx = useRef<Ctx | null>(null);
  const [current, setCurrent] = useState(0);
  const [results, setResults] = useState<Record<number, StepResult>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState<boolean | null>(null);

  useEffect(() => {
    if (!isLocalChain()) {
      setReady(false);
      return;
    }
    isCarverReady()
      .then((r) => setReady(r.ready))
      .catch(() => setReady(false));
  }, []);

  function reset() {
    ctx.current = null;
    setCurrent(0);
    setResults({});
    setError(null);
    setAirplane(false);
  }

  const steps: { title: string; run: () => Promise<StepResult> }[] = [
    {
      // 1. Online: turn IOU into offline cash.
      title: t("demo.s1"),
      run: async () => {
        const expiry = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
        const salt = ("0x" + crypto.getRandomValues(new Uint8Array(32)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "")) as Hex;
        const batch = carveBatch({
          carver: CARVER.offline,
          trancheId: `0x${BigInt(0).toString(16)}` as Hex,
          denominations: [NOTE, REMAINDER],
          expiry,
          batchSalt: salt,
        });
        const serials = batch.notes.map((n) => n.serial);
        const { root, proof } = solRootAndProof(serials, 0);
        await carveOnChain(root, NOTE + REMAINDER, expiry);
        const v = await readVaultState(root);
        ctx.current = {
          expiry,
          batch,
          onchainRoot: root,
          proof0: proof,
          serial: serials[0]!,
          nonce1: `0x${"11".repeat(32)}` as Hex,
          nonce2: `0x${"22".repeat(32)}` as Hex,
        };
        return {
          lines: [
            { label: t("demo.carved"), value: `${formatIou(NOTE + REMAINDER)} IOU` },
            { label: t("demo.locked"), value: `${formatIou(v.locked)} IOU`, tone: "muted" },
            { label: t("demo.serial"), value: shortHex(serials[0]!, 10, 6), tone: "muted" },
          ],
        };
      },
    },
    {
      // 2. Go offline.
      title: t("demo.s2"),
      run: async () => {
        setAirplane(true);
        return { lines: [{ label: t("demo.airplane"), value: t("airplane.on"), tone: "muted" }] };
      },
    },
    {
      // 3. Buyer pays seller1 by QR — pure offline.
      title: t("demo.s3"),
      run: async () => {
        const c = ctx.current!;
        const invoice = createInvoice({ recipient: SELLER1.offline, amount: NOTE, nonce: c.nonce1, memo: "coffee" });
        const tx = spendNote({ batch: c.batch, noteIndex: 0, invoice, carver: CARVER.offline });
        // seller verifies offline
        const v = verifyTranscript({
          transcript: tx,
          memberCert: CERTS.memberCert,
          sarrafCert: CERTS.sarrafCert,
          rootPublicKey: ROOT_PUBLIC_KEY,
          now: Math.floor(Date.now() / 1000),
          expectedRecipient: SELLER1.offline.publicKey,
        });
        c.v1 = v;
        return {
          lines: [
            { label: t("demo.paid"), value: `${formatIou(NOTE)} IOU → seller1` },
            { label: t("demo.offlineVerify"), value: v.valid ? t("receive.accepted") : (v.reason ?? "?"), tone: v.valid ? "ok" : "bad" },
            { label: t("demo.network"), value: t("demo.none"), tone: "muted" },
          ],
        };
      },
    },
    {
      // 4. Back online.
      title: t("demo.s4"),
      run: async () => {
        setAirplane(false);
        return { lines: [{ label: t("demo.airplane"), value: t("airplane.off"), tone: "muted" }] };
      },
    },
    {
      // 5. Reconcile seller1 — settles on-chain.
      title: t("demo.s5"),
      run: async () => {
        const c = ctx.current!;
        const res = await reconcileOnChain({
          root: c.onchainRoot,
          serial: c.serial,
          proof: c.proof0,
          recipient: SELLER1.address,
          amount: NOTE,
          nonce: c.nonce1,
          expiry: c.expiry,
        });
        const bal = await iouBalance(SELLER1.address);
        return {
          lines: [
            { label: t("demo.settled"), value: res.outcome, tone: "ok" },
            { label: t("demo.seller1Iou"), value: `${formatIou(bal)} IOU`, tone: "ok" },
            { label: t("demo.tx"), value: shortHex(res.hash, 10, 6), tone: "muted" },
          ],
        };
      },
    },
    {
      // 6. Double-spend the SAME note to seller2 — offline.
      title: t("demo.s6"),
      run: async () => {
        const c = ctx.current!;
        setAirplane(true);
        c.reservesBefore = (await readVaultState()).reserves;
        c.seller2UsdtBefore = await usdtBalance(SELLER2.address);
        setAirplane(false);
        const invoice = createInvoice({ recipient: SELLER2.offline, amount: NOTE, nonce: c.nonce2, memo: "same note!" });
        const tx = spendNote({ batch: c.batch, noteIndex: 0, invoice, carver: CARVER.offline });
        const v = verifyTranscript({
          transcript: tx,
          memberCert: CERTS.memberCert,
          sarrafCert: CERTS.sarrafCert,
          rootPublicKey: ROOT_PUBLIC_KEY,
          now: Math.floor(Date.now() / 1000),
          expectedRecipient: SELLER2.offline.publicKey,
        });
        c.v2 = v;
        return {
          lines: [
            { label: t("demo.doubleSpent"), value: `${formatIou(NOTE)} IOU → seller2`, tone: "bad" },
            { label: t("demo.sameSerial"), value: shortHex(c.serial, 10, 6), tone: "bad" },
            { label: t("demo.offlineVerify"), value: v.valid ? t("receive.accepted") : (v.reason ?? "?"), tone: v.valid ? "ok" : "bad" },
          ],
        };
      },
    },
    {
      // 7. Reconcile seller2 — the chain catches the double-spend.
      title: t("demo.s7"),
      run: async () => {
        const c = ctx.current!;
        const res = await reconcileOnChain({
          root: c.onchainRoot,
          serial: c.serial,
          proof: c.proof0,
          recipient: SELLER2.address,
          amount: NOTE,
          nonce: c.nonce2,
          expiry: c.expiry,
        });
        if (res.outcome !== "convicted") {
          return { lines: [{ label: t("demo.settled"), value: res.outcome, tone: "bad" }] };
        }
        const [seizedIou, usdtAfter, vault] = await Promise.all([
          iouBalance(SELLER2.address),
          usdtBalance(SELLER2.address),
          readVaultState(),
        ]);
        const insurance = usdtAfter - (c.seller2UsdtBefore ?? 0n);
        return {
          lines: [],
          convict: {
            carver: res.carver,
            victim: res.victim,
            seized: seizedIou,
            insurance,
            reservesBefore: c.reservesBefore ?? 0n,
            reservesAfter: vault.reserves,
          },
        };
      },
    },
  ];

  async function runNext() {
    if (busy || current >= steps.length) return;
    setBusy(true);
    setError(null);
    try {
      const r = await steps[current]!.run();
      setResults((p) => ({ ...p, [current]: r }));
      setCurrent((c) => c + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "error");
    } finally {
      setBusy(false);
    }
  }

  const finished = current >= steps.length;

  return (
    <div className="flex flex-col gap-xl">
      <NotDeployedBanner />
      <header>
        <h1 className="text-xl font-medium text-foreground">{t("demo.title")}</h1>
        <p className="mt-xs text-sm text-muted">{t("demo.subtitle")}</p>
      </header>

      {ready === false && (
        <div className="rounded-md border border-warning/40 bg-warning/10 p-lg text-sm">
          <p className="font-medium text-foreground">{t("demo.notReady")}</p>
          <p className="mt-xs text-muted">{t("demo.notReadyHint")}</p>
        </div>
      )}

      <div
        className={`flex items-center gap-sm rounded-md border p-md text-sm ${
          airplane ? "border-warning/50 bg-warning/10" : "border-border bg-surface-alt"
        }`}
      >
        <span aria-hidden className="text-lg">
          {airplane ? "✈️" : "📶"}
        </span>
        <span className="font-medium text-foreground">
          {airplane ? t("airplane.on") : t("airplane.off")}
        </span>
      </div>

      <ol className="flex flex-col gap-md">
        {steps.map((s, i) => {
          const state = i < current ? "done" : i === current ? "active" : "todo";
          const res = results[i];
          return (
            <li
              key={i}
              className={`rounded-lg border p-lg ${
                state === "active"
                  ? "border-primary bg-primary/5 shadow-card"
                  : state === "done"
                    ? "border-border bg-surface"
                    : "border-border bg-surface-alt opacity-60"
              }`}
            >
              <div className="flex items-center gap-md">
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-pill text-xs font-bold ${
                    state === "done"
                      ? "bg-success text-white"
                      : state === "active"
                        ? "bg-primary text-primary-foreground"
                        : "bg-border text-muted"
                  }`}
                >
                  {state === "done" ? "✓" : i + 1}
                </span>
                <span className="text-sm font-medium text-foreground">{s.title}</span>
              </div>

              {res && (
                <div className="mt-md flex flex-col gap-xs ps-[36px]">
                  {res.lines.map((l, j) => (
                    <div key={j} className="flex items-center justify-between text-xs">
                      <span className="text-muted">{l.label}</span>
                      <span
                        className={`font-medium ${
                          l.tone === "ok"
                            ? "text-success"
                            : l.tone === "bad"
                              ? "text-danger"
                              : "text-foreground"
                        }`}
                        dir="ltr"
                      >
                        {l.value}
                      </span>
                    </div>
                  ))}
                  {res.convict && <ConvictionCard c={res.convict} />}
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {error && <p className="break-all text-sm text-danger">{error}</p>}

      <div className="flex gap-md">
        {!finished && (
          <button
            type="button"
            disabled={busy || ready === false}
            onClick={runNext}
            className="flex-1 rounded-pill bg-primary py-md text-sm font-bold text-primary-foreground disabled:opacity-50"
          >
            {busy ? t("demo.running") : current === 0 ? t("demo.start") : t("demo.next")}
          </button>
        )}
        {(finished || current > 0) && (
          <button
            type="button"
            onClick={reset}
            disabled={busy}
            className="rounded-pill border border-primary px-xl py-md text-sm font-bold text-primary disabled:opacity-50"
          >
            {t("demo.reset")}
          </button>
        )}
      </div>
    </div>
  );
}

function ConvictionCard({
  c,
}: {
  c: NonNullable<StepResult["convict"]>;
}) {
  const t = useTranslations("notes");
  return (
    <div className="mt-md rounded-lg border border-danger/40 bg-danger/5 p-lg">
      <p className="text-base font-bold text-danger">⚖️ {t("demo.convicted")}</p>
      <div className="mt-md flex flex-col gap-sm text-xs">
        <Row label={t("demo.cheater")} value={shortHex(c.carver, 10, 6)} tone="bad" />
        <Row label={t("demo.victim")} value={shortHex(c.victim, 10, 6)} tone="ok" />
        <div className="my-sm border-t border-border" />
        <p className="text-sm font-medium text-foreground">{t("demo.madeWhole")}</p>
        <Row label={t("demo.fromSeized")} value={`${formatIou(c.seized)} IOU`} tone="ok" />
        <Row label={t("demo.fromInsurance")} value={`${formatIou(c.insurance)} USDT`} tone="ok" />
        <div className="my-sm border-t border-border" />
        <Row
          label={t("demo.insuranceReserves")}
          value={`${formatIou(c.reservesBefore)} → ${formatIou(c.reservesAfter)} USDT`}
          tone="muted"
        />
      </div>
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone: "ok" | "bad" | "muted" }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted">{label}</span>
      <span
        className={`font-bold ${tone === "ok" ? "text-success" : tone === "bad" ? "text-danger" : "text-foreground"}`}
        dir="ltr"
      >
        {value}
      </span>
    </div>
  );
}
