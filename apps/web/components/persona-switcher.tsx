"use client";

import { useRouter, usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

/**
 * Persona switcher — jumps between the three product surfaces so all are
 * reachable in the PoC (they live in separate route groups with no shared nav):
 *   · customer app  → /
 *   · sarraf desk   → /desk (money-changer back office)
 *   · point of sale → /pos  (seller counter)
 * A demo affordance; in production a user only ever sees their own surface.
 */
const personas = [
  { value: "customer", href: "/" },
  { value: "sarraf", href: "/desk" },
  { value: "pos", href: "/pos" },
] as const;

function personaFor(pathname: string): (typeof personas)[number]["value"] {
  if (pathname === "/desk" || pathname.startsWith("/desk/")) return "sarraf";
  if (pathname === "/pos" || pathname.startsWith("/pos/")) return "pos";
  return "customer";
}

export function PersonaSwitcher() {
  const t = useTranslations("persona");
  const router = useRouter();
  const pathname = usePathname();
  const current = personaFor(pathname);

  return (
    <label className="inline-flex items-center gap-sm">
      <span className="sr-only">{t("label")}</span>
      <select
        value={current}
        onChange={(e) => {
          const next = personas.find((p) => p.value === e.target.value);
          if (next) router.push(next.href);
        }}
        className="rounded-pill border border-border bg-surface px-md py-xs text-sm text-foreground"
        title={t("label")}
      >
        {personas.map((p) => (
          <option key={p.value} value={p.value}>
            {t(p.value)}
          </option>
        ))}
      </select>
    </label>
  );
}
