/** Greedy split of an amount into fixed offline-note denominations (6dp IOU). */
const DENOMS = [10_000_000000n, 5_000_000000n, 1_000_000000n, 500_000000n, 100_000000n, 10_000000n];

export function splitDenominations(amount: bigint): bigint[] {
  const notes: bigint[] = [];
  let left = amount;
  for (const d of DENOMS) {
    while (left >= d && notes.length < 24) {
      notes.push(d);
      left -= d;
    }
  }
  if (left > 0n) notes.push(left); // remainder as a final odd note
  return notes.length ? notes : [amount];
}
