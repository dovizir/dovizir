# ARM B BRIEF — Dovizir M1 protocol core (slowcook harness arm)

Same task as Arm A, verbatim spec pointers (fairness requirement):
- packages/acceptance/src/interfaces/IDovizir.sol (frozen, incl. adjudication comments)
- packages/acceptance/src/TranscriptLib.sol + AuthLib.sol (frozen EVM encodings — use, do not reimplement)
- packages/acceptance/notes/notes-api.d.ts (frozen TS API, PINNED SEMANTICS header)
- packages/acceptance/README.md + notes/README.md (plug-in pattern + pinned interpretations)
- Acceptance tests ARE the acceptance criteria. Green = DOVIZIR_DEPLOYER-plugged forge test all pass; DOVIZIR_NOTES_IMPL-aliased vitest 95/95.

Deliverables: six contracts in packages/contracts/src + MockUsdt; ArmBDeployer in
packages/acceptance/src/arm/ (additive remapping allowed, ONLY referee file touchable);
pure-TS packages/notes implementing @dovizir/notes; own tests per harness discipline;
forge snapshot baseline. Branch arm-b/m1, push when green.

Rules: no edits under packages/acceptance/ (beyond above) or docs/experiment/;
suspected referee bugs are reported not fixed, implement to interface text.

Slowcook projects: packages/contracts (.brewing solidity/forge) and packages/notes
(.brewing typescript/vitest). Costs land in specs/*.cost.jsonl per project.
