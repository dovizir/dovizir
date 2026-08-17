"use client";

/**
 * Airplane-mode context for the demo. When ON, every network path in the
 * offline-notes flows is refused (`assertOnline` throws, indexer/chain calls
 * are gated) — proving the offline steps (carve display, spend, verify) work
 * with zero connectivity. Purely a demo affordance; the offline lib itself
 * never touches the network.
 */
import { createContext, useCallback, useContext, useEffect, useState } from "react";

interface AirplaneCtx {
  airplane: boolean;
  setAirplane: (v: boolean) => void;
  toggle: () => void;
  hydrated: boolean;
}

const Ctx = createContext<AirplaneCtx>({
  airplane: false,
  setAirplane: () => {},
  toggle: () => {},
  hydrated: false,
});

const KEY = "dovizir.notes.airplane";

export function AirplaneProvider({ children }: { children: React.ReactNode }) {
  const [airplane, setAirplaneState] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      setAirplaneState(localStorage.getItem(KEY) === "1");
    } catch {
      /* ignore */
    }
    setHydrated(true);
  }, []);

  const setAirplane = useCallback((v: boolean) => {
    setAirplaneState(v);
    try {
      localStorage.setItem(KEY, v ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, []);

  const toggle = useCallback(() => setAirplane(!airplane), [airplane, setAirplane]);

  return (
    <Ctx.Provider value={{ airplane, setAirplane, toggle, hydrated }}>{children}</Ctx.Provider>
  );
}

export function useAirplane(): AirplaneCtx {
  return useContext(Ctx);
}

export class OfflineError extends Error {
  constructor() {
    super("OFFLINE");
    this.name = "OfflineError";
  }
}
