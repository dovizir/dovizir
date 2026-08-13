# Dual-build experiment protocol (round 1)

Tests slowcook's product claim: harness discipline + cheaper models vs. a
stronger model freestyle. Registered before either arm starts; amendments
after arm launch only via §5.

## 1. Task (identical for both arms)

Implement the Dovizir M1 protocol core against the frozen interfaces in
`packages/acceptance/src/interfaces/IDovizir.sol`:

- `IouToken` (ERC-1155 issuer tranches + EIP-3009-style authorizations)
- `MemberRegistry`, `ReservePool` (fully-funded issuance only), `InsuranceFund`
  (90 bps fee, 50/50 split bookkeeping), `SarrafRegistry` (TWAB floor
  min(TVL/5, $1M), 100/90 hysteresis, daily evaluate), `NoteVault` (carve /
  recipient-bound reconcile / double-spend conviction / expiry refund)
- Pure-TS `@dovizir/notes` library: note carving, spend-transcript
  construction & verification (recipient binding, one-hop), reconciliation
  state machine, cert-chain verification (root → sarraf → member, expiry).

## 2. Arms

- **Arm A**: Claude Fable 5, max effort, freestyle (own discipline, writes own
  tests), in a git worktree on branch `arm-a/m1`. No slowcook.
- **Arm B**: slowcook harness (`@slowcook-ai/cli` ≥0.28.7 + stack-solidity +
  stack-ts) driving Opus 5 (and optionally Sonnet 5 as arm B2) on rewo,
  branch `arm-b/m1`. Stories/acceptances fed from this suite.

Isolation: both start from the same baseline commit (merge of `poc/m0` +
`poc/referee`). No arm reads the other's branch until judging. Referee suite
is read-only to both arms.

## 3. Referee (mechanical)

- `packages/acceptance` Foundry tests + invariants run against EACH arm's
  deployment (arms provide a `Deployer` contract implementing
  `IAcceptanceDeployer`). Same tests, same seeds.
- `@dovizir/notes` acceptance vitest specs run against each arm's package
  via an import alias.
- Scores: acceptance pass rate; invariant violations (0 required); mutation
  score on TS lib (stack-ts mutation runner, same config); forge coverage %;
  gas snapshot (info only, not scored in round 1); defects found in
  adversarial cross-review (counted against the arm that shipped them).
- Cost: separate ANTHROPIC_API_KEY per arm; billed USD is ground truth.
  Arm A = this session's M1-attributable usage; Arm B = slowcook cost ledger
  (`specs/*.cost.jsonl`). One-time tooling (stack-solidity, this suite, M0)
  amortized separately, excluded from both arms.
- Headline metrics: $/acceptance-passed, $/mutant-killed. Caveat n=1 stays
  attached to any conclusion.

## 4. Judging

Independent agents (not the Arm-A author persona): one functional judge runs
the referee suites and compiles the scoreboard; one adversarial reviewer per
arm hunts defects with identical prompts. Author-of-arm-A does not score;
it only responds to findings (fix round).

## 5. Spec-bug rule

If both arms fail/stall on the same interface ambiguity, it is a spec bug:
fix the interface + acceptance test, note it in EXPERIMENT-LOG.md, re-brief
both arms. Unilateral difficulties are not spec bugs.

## 6. Timeline

Referee freeze → arms launch → arms close (time-boxed: 48h wall clock or
arm-declared done, whichever first) → judging → fix round → workflow decision
for M2+ recorded in EXPERIMENT-LOG.md.
