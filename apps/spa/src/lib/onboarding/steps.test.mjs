#!/usr/bin/env node
/**
 * Onboarding step machine — which of the four designed screens a visitor sees.
 *
 * The flow exists because "Connect wallet" is banned vocabulary in this
 * product: a first-time visitor JOINS through a sarraf, CREATES a wallet with
 * a passkey ceremony, and lands on a READY screen; a returning visitor gets
 * UNLOCK. The order encodes two product rules:
 *
 *   1. A live connection wins over everything — nobody who is already signed
 *      in is ever walked back through onboarding.
 *   2. Stored key material (passkey credential OR legacy embedded key) means
 *      the wallet exists — the only honest offer is to unlock it, never to
 *      create a second one.
 *
 * Also here: the two display helpers the screens need — avatar initials that
 * survive Arabic-script names, and contact masking that never reveals the
 * middle of a phone number.
 *
 * Run: node src/lib/onboarding/steps.test.mjs
 */
import { deriveOnboardingStep, initialsOf, maskContact } from "./steps.mjs";

let pass = 0;
const failures = [];
const eq = (actual, expected, what) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass++;
  else failures.push(`${what}\n      expected ${e}\n      actual   ${a}`);
};

const SARRAF = "0x00000000000000000000000000000000000000a1";

// ------------------------------------------------------------- step derivation

eq(
  deriveOnboardingStep({ hasWallet: false, isConnected: false, joinedSarraf: null, welcomed: false }),
  "join",
  "fresh visitor with no invite: join screen (scan-your-sarraf prompt)",
);
eq(
  deriveOnboardingStep({ hasWallet: false, isConnected: false, joinedSarraf: SARRAF, welcomed: false }),
  "join",
  "fresh visitor from an invite link: join screen (sarraf card)",
);
eq(
  deriveOnboardingStep({ hasWallet: true, isConnected: false, joinedSarraf: SARRAF, welcomed: false }),
  "unlock",
  "stored wallet, not connected: unlock — never re-create",
);
eq(
  deriveOnboardingStep({ hasWallet: true, isConnected: false, joinedSarraf: null, welcomed: true }),
  "unlock",
  "stored wallet on a welcomed device still unlocks (welcomed is not a session)",
);
eq(
  deriveOnboardingStep({ hasWallet: true, isConnected: true, joinedSarraf: SARRAF, welcomed: false }),
  "ready",
  "connected but not yet welcomed: the success screen shows exactly once",
);
eq(
  deriveOnboardingStep({ hasWallet: true, isConnected: true, joinedSarraf: SARRAF, welcomed: true }),
  "done",
  "connected and welcomed: onboarding is over, go to the app",
);
eq(
  deriveOnboardingStep({ hasWallet: false, isConnected: true, joinedSarraf: null, welcomed: true }),
  "done",
  "connection wins even if storage looks empty (external state is the truth)",
);

// ---------------------------------------------------------------- initialsOf

eq(initialsOf("Sarrafi Golestan"), "SG", "two words: first letters, uppercased");
eq(initialsOf("golestan"), "G", "single word: one initial");
eq(initialsOf("  Sarrafi   Golestan  Ltd "), "SG", "extra whitespace ignored, max two initials");
eq(initialsOf("صرافی گلستان"), "صگ", "Arabic-script names keep their letters (no case)");
eq(initialsOf(""), "?", "empty name never renders an empty avatar");
eq(initialsOf("   "), "?", "whitespace-only name never renders an empty avatar");

// ---------------------------------------------------------------- maskContact

eq(maskContact("+989121234567"), "+98 912 ••• 4567", "long international number: country + prefix + last 4");
eq(maskContact("+90 532 123 45 67"), "+90 532 ••• 4567", "pre-grouped input normalizes to the same shape");
eq(maskContact("09121234567"), "091 ••• 4567", "local number: short prefix + last 4");
eq(maskContact("12345"), "••• 45", "short number: only the last 2 survive");
eq(maskContact("name@example.com"), "n•••@example.com", "email: first letter + domain survive");
eq(maskContact(""), "", "empty input stays empty");
eq(maskContact("not a contact"), "", "unparseable input masks to nothing rather than leaking");

// -------------------------------------------------------------------- report

if (failures.length) {
  console.error(`\nsteps.test: ${failures.length} failure(s), ${pass} passed\n`);
  for (const f of failures) console.error("  ✗ " + f + "\n");
  process.exit(1);
}
console.log(`steps.test: ${pass} assertions passed`);
