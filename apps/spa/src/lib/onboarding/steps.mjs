/**
 * Onboarding step machine + display helpers (pure; tested standalone).
 *
 * See steps.test.mjs for the product rules this encodes. Kept as plain JS with
 * zero imports so the test runs under bare node — the same pattern as
 * aa-config.mjs / sponsorship.mjs / gas-tank.mjs.
 */

/**
 * Which onboarding screen a visitor is entitled to see.
 *
 * Precedence, highest first:
 *   connected + welcomed  -> "done"    (nothing to onboard)
 *   connected             -> "ready"   (the one-time success screen)
 *   stored wallet         -> "unlock"  (never offer to create a second wallet)
 *   otherwise             -> "join"    (sarraf card, or scan prompt without one)
 *
 * "join" -> "create" is a LOCAL advance inside the wizard (the user accepting
 * the sarraf), deliberately not derived from storage: accepting an invite is
 * an action, not a state we can observe.
 */
export function deriveOnboardingStep({ hasWallet, isConnected, joinedSarraf, welcomed }) {
  void joinedSarraf; // presence changes what "join" RENDERS, never the step
  if (isConnected) return welcomed ? "done" : "ready";
  if (hasWallet) return "unlock";
  return "join";
}

/** Avatar initials: first letter of the first two words. Works for scripts
 *  without case (Arabic/Persian); never returns an empty string. */
export function initialsOf(name) {
  const words = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return words
    .slice(0, 2)
    .map((w) => [...w][0])
    .join("")
    .toUpperCase();
}

/**
 * Mask a contact for display, revealing edges only:
 *   phone  -> "+98 912 ••• 4567" (international) / "091 ••• 4567" (local)
 *   email  -> "n•••@example.com"
 * Unparseable input masks to "" — an over-eager mask must fail closed.
 */
export function maskContact(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";

  const at = raw.indexOf("@");
  if (at > 0) {
    const domain = raw.slice(at); // "@example.com"
    return `${[...raw][0]}•••${domain}`;
  }

  const plus = raw.startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";

  if (digits.length >= 10) {
    // "+98 912 ••• 4567" — country code (2) + carrier prefix (3) + last 4.
    const cc = digits.slice(0, 2);
    const prefix = plus ? digits.slice(2, 5) : digits.slice(0, 3);
    return plus
      ? `+${cc} ${prefix} ••• ${digits.slice(-4)}`
      : `${prefix} ••• ${digits.slice(-4)}`;
  }
  if (digits.length >= 8) {
    return `${plus ? "+" : ""}${digits.slice(0, 3)} ••• ${digits.slice(-4)}`;
  }
  // Too short to have a safe prefix: only the last 2 survive.
  return `••• ${digits.slice(-2)}`;
}
