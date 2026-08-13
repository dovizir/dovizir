"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "dovizir.friendlyTx";
const FREE_PER_DAY = 1;

interface FriendlyTxState {
  date: string; // YYYY-MM-DD (UTC)
  used: number;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function load(): FriendlyTxState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as FriendlyTxState;
      if (parsed.date === todayUtc()) return parsed;
    }
  } catch {
    // corrupted state -> reset
  }
  return { date: todayUtc(), used: 0 };
}

/**
 * "1 free friendly tx/day" — UI stub.
 *
 * M2 tracks usage client-side (localStorage, resets daily UTC) purely to
 * drive the UI. Real enforcement lands with the ERC-4337 paymaster: the
 * sponsorship policy (per-account daily quota) is checked server-side by the
 * paymaster before it signs the sponsorship — nothing here is trusted.
 */
export function useFriendlyTx() {
  const [state, setState] = useState<FriendlyTxState>({ date: todayUtc(), used: 0 });
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setState(load());
    setHydrated(true);
  }, []);

  const markUsed = useCallback(() => {
    setState(() => {
      const next = { date: todayUtc(), used: load().used + 1 };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // storage unavailable — UI-only stub, ignore
      }
      return next;
    });
  }, []);

  const remainingToday = Math.max(0, FREE_PER_DAY - state.used);
  return { freePerDay: FREE_PER_DAY, usedToday: state.used, remainingToday, markUsed, hydrated };
}
