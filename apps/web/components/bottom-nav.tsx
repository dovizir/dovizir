"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

const items = [
  { href: "/", key: "home", icon: "⌂" },
  { href: "/deposit", key: "deposit", icon: "⤓" },
  { href: "/send", key: "send", icon: "↗" },
  { href: "/notes", key: "notes", icon: "✎" },
  { href: "/redeem", key: "redeem", icon: "⇄" },
] as const;

/** Consumer bottom navigation (design system: BottomNavigation). */
export function BottomNav() {
  const t = useTranslations("nav");
  const pathname = usePathname();

  return (
    <nav className="fixed inset-x-0 bottom-0 border-t border-border bg-background shadow-top">
      <div className="mx-auto flex max-w-md">
        {items.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`flex flex-1 flex-col items-center gap-xs py-md text-xs font-medium transition-colors duration-standard ${
                active ? "text-primary" : "text-muted"
              }`}
            >
              <span aria-hidden className="text-lg leading-none">
                {item.icon}
              </span>
              {t(item.key)}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
