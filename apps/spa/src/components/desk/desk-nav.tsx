"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

const items = [
  { href: "/desk", key: "book" },
  { href: "/desk/rates", key: "rates" },
  { href: "/desk/rfq", key: "rfq" },
  { href: "/desk/orders", key: "orders" },
  { href: "/desk/disputes", key: "disputes" },
] as const;

/** Sarraf desk section nav (book / rates / RFQ inbox / orders). */
export function DeskNav() {
  const t = useTranslations("deskRamp.nav");
  const pathname = usePathname();

  return (
    <nav className="mt-xl flex flex-col gap-xs">
      {items.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-md px-md py-sm text-sm font-medium ${
              active ? "bg-primary/10 text-primary" : "text-muted hover:text-foreground"
            }`}
          >
            {t(item.key)}
          </Link>
        );
      })}
    </nav>
  );
}
