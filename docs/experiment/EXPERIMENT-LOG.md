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
