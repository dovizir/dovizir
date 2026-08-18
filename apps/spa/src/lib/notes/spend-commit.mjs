/**
 * Commit an offline spend to the device, crash-safely.
 *
 * Two facts must reach storage: the spend transcript, and the mark that the
 * serial is used. A phone that dies between them can be left believing the note
 * is still spendable — and spending it again is a double spend, which the chain
 * punishes by seizing collateral. The bazaar is precisely where phones die
 * mid-payment, so an honest person with a flat battery must not be convicted as
 * a fraudster.
 *
 * ORDER IS THE GUARANTEE. Mark the serial FIRST:
 *
 *   marked, spend missing  -> the note is stuck. Value is recoverable, nobody
 *                             is convicted. Acceptable.
 *   spend recorded, unmarked -> the note looks spendable again. CONVICTABLE.
 *                             Never allowed.
 *
 * `ops` is injected so the storage layer can also wrap these in a single
 * IndexedDB transaction (see store.ts `commitSpendAtomic`) — atomicity is
 * better still, but this ordering holds even where a transaction cannot span
 * the stores, and it is what the tests pin.
 *
 * The handoff runs only after commit: publishing earlier would hand the
 * recipient a note the payer still believes it owns.
 */
export async function commitSpend(ops, input, hooks = {}) {
  await ops.markSerialSpent(input);
  await ops.putSpend(input);
  if (ops.commit) await ops.commit();
  hooks.onCommitted?.();
}
