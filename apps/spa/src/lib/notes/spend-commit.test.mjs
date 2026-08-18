#!/usr/bin/env node
/**
 * Crash-safety of committing an offline spend.
 *
 * Spending a note writes two facts to the device: the spend transcript itself,
 * and the mark that the note's serial is now used. If the phone dies between
 * those two writes, the device can end up believing the note is still
 * spendable — and spending it again is a DOUBLE SPEND, which the chain
 * punishes by seizing the payer's collateral.
 *
 * That is the failure this guards: an honest person with a flat battery being
 * convicted as a fraudster. The bazaar is exactly where phones die mid-payment.
 *
 * Safety property, stated once:
 *   at NO point may the device hold a recorded spend while the serial is
 *   still unmarked.
 *
 * Losing the note (marked, but the spend record missing) is acceptable by
 * comparison: value is stuck, nobody is convicted, and it is recoverable.
 *
 * Run: node src/lib/notes/spend-commit.test.mjs
 */
import { commitSpend } from "./spend-commit.mjs";

let pass = 0;
const failures = [];
const ok = (cond, what) => (cond ? pass++ : failures.push(what));

/** Device state, plus a fuse that makes the Nth write throw. */
function fakeDevice({ failOnWrite = Infinity } = {}) {
  let writes = 0;
  const state = { spendRecorded: false, serialMarked: false, committed: false };
  const step = () => {
    if (++writes >= failOnWrite) throw new Error("power lost");
  };
  return {
    state,
    ops: {
      markSerialSpent: async () => {
        step();
        state.serialMarked = true;
      },
      putSpend: async () => {
        step();
        state.spendRecorded = true;
      },
      commit: async () => {
        step();
        state.committed = true;
      },
    },
  };
}

const UNSAFE = (s) => s.spendRecorded && !s.serialMarked;

// ---------------------------------------------------------- the happy path

{
  const d = fakeDevice();
  await commitSpend(d.ops, { serial: "0xaa", spend: { key: "0xaa:1" } });
  ok(d.state.spendRecorded, "happy path: the spend is recorded");
  ok(d.state.serialMarked, "happy path: the serial is marked spent");
  ok(!UNSAFE(d.state), "happy path: never lands in the convictable state");
}

// -------------------------------------- a crash at EVERY point is survivable

for (let failAt = 1; failAt <= 4; failAt++) {
  const d = fakeDevice({ failOnWrite: failAt });
  try {
    await commitSpend(d.ops, { serial: "0xaa", spend: { key: "0xaa:1" } });
  } catch {
    /* the phone died; that is the scenario */
  }
  ok(
    !UNSAFE(d.state),
    `crash at write #${failAt}: must not leave a recorded spend with an unmarked serial ` +
      `(spendRecorded=${d.state.spendRecorded} serialMarked=${d.state.serialMarked})`,
  );
}

// ------------------------------------------- the handoff must not run early

{
  const d = fakeDevice({ failOnWrite: 2 });
  let handedOff = false;
  try {
    await commitSpend(
      d.ops,
      { serial: "0xaa", spend: { key: "0xaa:1" } },
      { onCommitted: () => (handedOff = true) },
    );
  } catch {}
  ok(
    !handedOff,
    "a failed commit never hands the note to the recipient — otherwise the " +
      "recipient holds a note the payer still thinks it owns",
  );
}

{
  const d = fakeDevice();
  let handedOff = false;
  await commitSpend(
    d.ops,
    { serial: "0xaa", spend: { key: "0xaa:1" } },
    { onCommitted: () => (handedOff = true) },
  );
  ok(handedOff, "a successful commit does hand the note over");
}

if (failures.length) {
  console.error(`\nspend-commit: ${failures.length} FAILED, ${pass} passed\n`);
  for (const f of failures) console.error("  ✗ " + f);
  console.error("");
  process.exit(1);
}
console.log(`spend-commit: ${pass} assertions passed`);
