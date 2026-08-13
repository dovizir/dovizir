# Experiment log

## 2026-08-13 — Referee construction & freeze

- Notes acceptance suite: 95 specs / 10 files, verified 95/95 against a
  throwaway reference implementation (discarded), 3-mutant teeth check killed
  3/3. Goldens generated from independent crypto (noble) only.
- Foundry acceptance suite: 74 tests + 4 invariants; builds standalone;
  everything protocol-facing fails "STUB" against the stub deployer as
  designed. TranscriptLib/AuthLib are frozen spec (EVM-side encoding).
- Pre-freeze spec bugs found by referee construction (adjudicated into the
  frozen interfaces/API before any arm launched — not §5 events):
  1. notes VALUE_MISMATCH unreachable as glossed → redefined vs invoice.amount.
  2. IReservePool.deposit cert-gating deadlocked bootstrap → deposit open,
     issue() cert-gated.
  3. Vault must mint on reconcile → mint/burn = pool AND vault.
  4. Pinned: merkle sorted-pair keccak; 64B compact low-s sigs; expiry
     boundary now < expiry; canonicalize edge cases; tracker identity =
     canonical bytes; capOf >= 50k e6 in acceptance env; seizure excess →
     fund 50/50 (unasserted round 1).
- Known unasserted edges (round 1): reconcile-after-expiry, carve-with-past-
  expiry, refundExpired caller, payClaim under-reserve, migrate impairment
  (unreachable in funded-only M1), evaluate() spot-floor vs TWAB-floor.

**REFEREE FROZEN** at this commit. Amendments henceforth only via §5
(both-arms-stall spec-bug rule).

## Arms

- Arm A (Fable 5 freestyle): launched from baseline in isolated worktree,
  branch arm-a/m1. Cost tracked via subagent token usage.
- Arm B (slowcook + Opus 5 on rewo): toolchain staged at
  /root/slowcook-experiment (slowcook 0.28.7 + stack-solidity built from
  source). BLOCKED on dedicated ANTHROPIC_API_KEY — launches when provided.

## 2026-08-13 — Arm A closed (verified)

- Branch arm-a/m1 @ 1f1aa46, 5 clean commits. Referee: Foundry 78/78,
  notes 95/95 — BOTH re-run and confirmed independently by the orchestrator.
  Arm reports first-run green after implementation. Own suites: 61 Foundry
  (4 solvency invariants) + 61 vitest; own-tests-only coverage 96.5% lines.
  Gas baselines committed (reconcile 285k, conviction 415k, migrate 666k).
- Cost (build-agent tokens): 277,392. Orchestration overhead logged
  separately at judging.
- Design notes for judges: vault escrow-custody (no mint path used),
  O(1) cross-batch seizure via per-carver epochs, checkpointed exact TWAB,
  ownerless post-init wiring, low-s guard on 3009 sigs.
- §5 CANDIDATE (arm-raised): adjudication comment "seizure excess → fund
  50/50" conflicts with frozen test asserting totalReserves() unchanged on
  covered seizure. Arm satisfied the test; excess held as parallel seized-IOU
  buckets. Judges to rule; candidate referee erratum for round 2.
- Third-conflicting-transcript behavior (re-conviction can re-draw insurance)
  flagged by the arm itself for adversarial review.

Arm B: staged on rewo, STILL BLOCKED on ANTHROPIC_API_KEY. Judging deferred
until arm B closes per PROTOCOL §6.

## 2026-08-13 — Arm B: harness-blocked at brew; round 1 paused for adjudication

Arm B pipeline: refine ✓ (2 stories, PM Q&A), testgen ✓ (manifests; PR-step
+ vitest-only-for-solidity issues), manifest ✓ (with operator rewrite), brew
✗ — driver (claude-opus-5) never reached a first edit on either story:
fresh-context iterations re-pay full orientation each turn and end with
empty final text. Slowcook fixes produced en route (setUp-collapse expansion
2f742c9, read-only stall cap 26cbce8, + 13-finding handover doc). Operator
interventions: 8. Arm B spend: ~$0.08 refine (subscription) + $0 brew
(never edited).

INTERIM (not final) reading, n=1: the harness's assumptions (webapp-shaped
prompts, per-turn edit expectation, TS-first tooling) currently bound arm B
more tightly than the model's capability does. Formal judging per PROTOCOL
§4 requires arm B to close; options recorded in session log. Arm A's
referee-green implementation remains unmerged pending adjudication.
