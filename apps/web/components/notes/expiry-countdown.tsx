"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

/** Live "expires in Nd Nh Nm" countdown for a note batch. */
export function ExpiryCountdown({ expiry }: { expiry: number }) {
  const t = useTranslations("notes");
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(id);
  }, []);

  const left = expiry - now;
  if (left <= 0) return <span className="text-danger">{t("carve.expired")}</span>;
  const d = Math.floor(left / 86400);
  const h = Math.floor((left % 86400) / 3600);
  const m = Math.floor((left % 3600) / 60);
  return (
    <span dir="ltr">
      {t("carve.expiresIn", { time: d > 0 ? `${d}d ${h}h` : `${h}h ${m}m` })}
    </span>
  );
}
