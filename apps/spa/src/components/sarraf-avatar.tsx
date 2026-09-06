"use client";

// @ts-expect-error — plain-JS step machine, tested standalone (steps.test.mjs)
import { initialsOf } from "@/lib/onboarding/steps.mjs";

/**
 * A sarraf's visual identity: their logo when the maintainer store has one,
 * otherwise initials derived from the name (Arabic-script safe). Never renders
 * from an address — callers must only pass names the indexer served through
 * the certified gate.
 */
export function SarrafAvatar({
  name,
  logo,
  size = "md",
  onBrand = false,
}: {
  name: string;
  logo?: string;
  size?: "sm" | "md";
  onBrand?: boolean;
}) {
  const box = size === "sm" ? "h-5 w-5 text-[10px]" : "h-12 w-12 text-base";
  if (logo) {
    return (
      <img
        src={logo}
        alt={name}
        className={`${box} shrink-0 rounded-full object-cover`}
      />
    );
  }
  const tone = onBrand
    ? "bg-primary-foreground/20 text-primary-foreground"
    : "bg-primary/10 text-primary";
  return (
    <span
      aria-hidden
      className={`${box} flex shrink-0 items-center justify-center rounded-full font-medium ${tone}`}
    >
      {initialsOf(name)}
    </span>
  );
}
