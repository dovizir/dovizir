/**
 * Same-device tab-to-tab handoff so the QR flows are demonstrable in a plain
 * browser today: a screen that shows a QR also publishes its payload to a
 * localStorage channel; the scanning screen can "pick it up from this device".
 * Real camera scanning is the native/Capacitor seam (see QrScanInput).
 */
const KEY = "dovizir.notes.handoff";

export function publishHandoff(payload: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ payload, at: Date.now() }));
  } catch {
    /* ignore */
  }
}

export function pickupHandoff(): string | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return (JSON.parse(raw) as { payload: string }).payload ?? null;
  } catch {
    return null;
  }
}
