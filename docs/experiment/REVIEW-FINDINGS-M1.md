# M1 adversarial review findings

Independent adversarial review of arm A's referee-green M1 (78 Foundry tests +
4 invariants + 95 notes specs all pass). Reviewers hunt what the acceptance
suites miss. Author-of-arm-A does not score; independent agents do.

## CRITICAL (notes) — SPEC BUG: signature under-scopes the transcript

**Root cause is in the FROZEN spec**, not arm A's code: `notes-api.d.ts:69`
freezes the carver signature as `keccak256(serial ‖ invoiceHash)`. That leaves
`expiry`, `batchRoot`, and `proof` **unsigned**. Arm A implemented the spec
exactly (`packages/notes/src/notes.ts:79-81,97`).

Consequences (all PoC-verified against the built lib, cross-checked vs @noble):
- **False double-spend conviction of an honest carver (Critical).** The
  ReconcileTracker keys idempotency off full canonical bytes
  (`tracker.ts:37,55`) while the *signed* identity is only serial+invoiceHash.
  Replay an accepted transcript with `expiry+1` (or a trivially-valid
  single-leaf `batchRoot`/`proof`) → tracker sees "different bytes, same
  serial" → **convicts the honest carver**, victims=[innocent recipient], with
  two transcripts carrying the SAME signature. Violates the pinned rule
  ("convict on same-serial-DIFFERENT-invoice") — this convicts on
  same-serial-SAME-invoice. Keyless: any relayer can frame a carver. The 95
  specs miss it because they only ever build conflicts by mutating the
  *invoice* (signed material) and test idempotency only via byte-identical
  clones. No false-negative counterpart (a genuine 2-recipient double-spend
  always has distinct invoiceHash → always convicts) — the asymmetry is all
  false-positive, the dangerous direction for a slashing mirror.
- **Note expiry is forgeable (Medium).** `verify.ts:82` checks unsigned
  `expiry`; bump it (fresh certs) and an expired note revives to valid.
  "Expiry as revocation" is unenforceable for notes; only cert-chain expiry is
  real.

**Fix (spec + impl):** amend the frozen digest to
`keccak256(serial ‖ invoiceHash ‖ expiry ‖ batchRoot)` (proof stays unsigned —
it's verified against the now-signed batchRoot); key ReconcileTracker identity
off signed material (`serial‖invoiceHash‖signature`), not full canonical bytes.
Add specs that mutate an UNSIGNED field and assert accept-idempotent /
no-conviction. Two localized changes; design is sound afterward.

## MEDIUM (notes) — capLimit not chained
`certs.ts:66-104` never checks `memberCert.capLimit <= sarrafCert.capLimit`;
`verify.ts:101` bounds value only by memberCert.capLimit. A sarraf can mint
member certs exceeding its own root-granted cap. Add the chain check (or
document as intentional sarraf trust — but currently unpinned + unenforced).

## LOW (notes)
- **Merkle leaf/interior domain separation** (`merkle.ts:21-27`): both are
  keccak256(64B); an interior node can be presented as a leaf folding to the
  real root. Not third-party-exploitable in v0 (spend needs carver sig,
  batchRoot is carver-asserted, never a trusted anchor) — becomes real if
  batchRoot ever becomes a registered anchor. Pinned OZ-compatible; document.
- **canonicalize case-folds hex-looking free text** (`canonicalize.ts:22`):
  the byte-field lowercasing rule leaks into arbitrary strings incl. `memo`,
  so "0xABCDEF" and "0xabcdef" memos collide. Cosmetic (memo informational).

## Verified SOUND (notes) — attempted, could not break
Low-s malleability rejected end-to-end; recipient binding A→B holds
(RECIPIENT_MISMATCH); pubkey point validation on-curve; cert role/issuer
confusion + boundary expiry (now==expiry → expired) all correct; no
signature-skip path; no Date.now/Math.random in signed material; no
secret-dependent equality. The crypto PRIMITIVES are sound — the flaw is
purely signature SCOPE.

## CRITICAL (contracts) — InsuranceFund fully drainable via unbounded/replayed conviction
`NoteVault.sol:142-190` (_convict), `InsuranceFund.sol:95-117`. PoC-verified
(Foundry): the spent-serial reconcile branch has NO amount bound, NO
replay/idempotency guard. `_convict` pays `shortfall = inv.amount - comp` in
real USDT via `payClaimForSerial`, and `inv.amount` is carver-chosen.
`acceptedInvoiceHash[serial]` is set only on first presentation, never in
_convict, and there's no `convicted` flag — so ONE convicting transcript
(same serial, evil invoice, huge amount, attacker recipient, signed by the
malicious carver) can be submitted repeatedly; once lockedOf=0 each call is a
pure `payClaim(attacker, inv.amount)` capped only by fund reserves. Trace:
certify sarraf → issue+carve to malicious member → legit first spend →
3× replay of a 3000e6 conviction → attacker +9000e6, fund → 0. Self-collusion
(carver + attacker addr); carver net cost ≈ 0. Acceptance suite blind: invariant
(d)'s timesPaid increments on IOU-balance rise, but a comp=0 conviction pays
purely USDT; opReplay only replays byte-identical transcripts, never a
different-invoice conviction. **This is the same conviction path the notes
Critical hits from the crypto side — two independent reviewers converged.**

## HIGH (contracts) — `_convict` reentrancy
`NoteVault.sol:168-190`: external `iou.safeTransferFrom` to `inv.recipient`
before a replay guard exists; malicious recipient re-enters `reconcile` during
onERC1155Received → second payClaim. Fixing the anti-replay guard + CEI
ordering closes it.

## MEDIUM (contracts) — cross-tranche seizure stranding / conviction DoS
`NoteVault.sol:170,178,186,214`: `seized = _lockedOf[carver]` aggregates across
all batches, but _convict transfers only in the convicted batch's tranche while
the epoch bump zeroes effective remainder of EVERY batch. Multi-tranche carver
(carve under S1, rehome to S2, carve again) → excess/comp can exceed the single
tranche's vault balance → conviction reverts (victim never compensated, DoS);
other tranche's IOU permanently stranded (refundExpired returns 0). Suspected,
not separately PoC'd.

## LOW/INFO (contracts)
- **No permissionless decertification** (`SarrafRegistry.sol:117-147`):
  evaluate() only evaluates msg.sender → a sarraf below floor never calls it,
  stays certified. Matches frozen interpretation → spec-level. (This is the
  same gap flagged in the original design as a founder question.)
- TWAB certification sound; "free on testnet" only because MockUsdt open-mints
  (inherent to testnet; real capital ≈ 50,000× floor for a 1-block certify).
- Dust-redemption fee evasion: amount < 112 units → fee 0 (frozen round-down);
  gas-prohibitive, not practical.

## Contracts axes verified SOLID
Access control tight (onlyProtocol mint/burn, pool-only checkpoint/recordFee,
vault-only payClaim, deployer-once init; no tx.origin, no missing zero-addr);
EIP-3009 clean (live chainid domain separator — no cross-chain replay, low-s
guard, one-time nonce, signed payee so courier can't redirect); reserve
accounting invariants a/b hold (funded-only issue, migrate conserves deposits);
fund split invariant c holds; onERC1155Received reentrancy into issue/deposit
blocked by access control.

## VERDICT: NOT safe to merge as-is (both reviewers)
Two independent PoC-verified Criticals, both in the NoteVault conviction/
reconcile path, both invisible to the 78+95 acceptance suites (their
double-spend coverage is a single honest conviction). Required fixes:
1. Bind conviction compensation to the serial's ORIGINAL spent amount, not a
   fresh carver-signed number.
2. Per-serial `convicted` flag / anti-replay; CEI ordering in `_convict`.
3. Sign `expiry`+`batchRoot` into the transcript digest (SPEC change,
   notes-api.d.ts:69 + TranscriptLib.sol); key ReconcileTracker identity off
   signed material.
4. capLimit chaining in verifyCertChain.
5. Decide cross-tranche seizure semantics (Finding: contracts Medium).
Plus: grow the acceptance suites with regression tests encoding BOTH exploits
(the fixes must not perturb the existing passing tests — that invariance is
itself proof of the coverage gap).

The rest of the system is well-constructed and defends its stated axes cleanly.
This is the review structure working exactly as designed: a fund-draining bug
the frozen referee and 173 passing tests could not see, caught by adversarial
review before merge.
