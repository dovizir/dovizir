"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { INDEXER_URL } from "@/lib/indexer";

/**
 * Resolve a phone number or email to a wallet through the directory
 * (Phase 3 / G6). This is the convenience layer over transfers — and ONLY
 * that: pasting a raw 0x address never touches this hook, which is the
 * degradation rule (directory down => transfers still work).
 *
 * States are deliberately explicit rather than collapsed into null:
 *   idle          input is not a contact-shaped string
 *   resolving     lookup in flight (debounced 500ms — every keystroke would
 *                 burn the per-requester rate budget on misses, by design)
 *   found         wallet available
 *   notFound      an honest miss; the server cannot distinguish "registered
 *                 elsewhere" from "never registered", so neither do we
 *   unavailable   directory unconfigured (503) or unreachable — the UI tells
 *                 the user to paste an address instead of failing vaguely
 *   limited       rate-limited (429); pause, then try again
 */
export type ContactResolution =
  | { state: "idle" }
  | { state: "resolving" }
  | { state: "found"; wallet: string }
  | { state: "notFound" }
  | { state: "unavailable" }
  | { state: "limited" };

/** Phone-ish (+ digits, length sane) or email-ish. Anything else is not a
 *  contact and never queried — including partial 0x addresses. */
export function looksLikeContact(raw: string): boolean {
  const s = raw.trim();
  if (s.includes("@")) return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
  const digits = s.replace(/[\s\-().]/g, "");
  return /^(\+|00)\d{7,15}$/.test(digits);
}

function useDebounced(value: string, ms: number): string {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function useContactResolve(input: string): ContactResolution {
  const debounced = useDebounced(input.trim(), 500);
  const isContact = looksLikeContact(debounced);

  const q = useQuery<ContactResolution>({
    queryKey: ["directory", "resolve", debounced],
    enabled: isContact,
    staleTime: 30_000,
    retry: false,
    queryFn: async ({ signal }) => {
      const res = await fetch(
        `${INDEXER_URL}/directory/resolve?id=${encodeURIComponent(debounced)}`,
        { signal },
      );
      if (res.status === 503) return { state: "unavailable" };
      if (res.status === 429) return { state: "limited" };
      if (!res.ok) return { state: "unavailable" };
      const body = (await res.json()) as { wallet: string | null };
      return body.wallet ? { state: "found", wallet: body.wallet } : { state: "notFound" };
    },
  });

  if (!isContact) return { state: "idle" };
  // A network failure surfaces as unavailable, not as an exception the form
  // has to guess about.
  if (q.isError) return { state: "unavailable" };
  if (q.isPending || input.trim() !== debounced) return { state: "resolving" };
  return q.data ?? { state: "resolving" };
}
