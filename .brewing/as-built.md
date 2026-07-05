# Dovizir — as-built inventory (brownfield intake, 2026-07-05)

> Extracted from code only (branch main @ 8de4419). Every claim cites its source.
> Doc-sourced intent lives separately (dash knowledge claims); this file is
> code-as-truth. Regenerate when main moves meaningfully.

## What exists
pnpm monorepo (`pnpm-workspace.yaml`): apps/* services/* packages/*. Node >=20.
- **packages/contracts** — Foundry. 3 contracts + 2 test files (7 tests):
  - `ReservePool.sol` — signed `mapping(address=>int256) reserveBalance` per "member" (:12);
    `deposit` (UNPERMISSIONED — anyone credits any member, :21-24), `issueIou`/`redeem`
    payable w/ exact-match flat wei fee forwarded to treasury (:26-44). No token is minted:
    "MVP: you'll mint a proper IOU ERC20 later" (:33); redemption "simulate[s] off-chain
    stablecoin transfer" (:43).
  - `Fees.sol` — owner-settable treasury/issuanceFee/redemptionFee (:5-23).
  - `CreditOracle.sol` — updater-gated `creditRateBps` per member, clamped ≤2500 bps (:8-33);
    doc comment defers on-chain "issuance headroom" enforcement to "later" (:5-6).
- **services/indexer** — Fastify :4000; `GET /health`, `GET /member/:addr` (live
  reserveBalance read). NO indexing loop, NO CreditOracle writes, NO persistence.
  `icm.ts` = placeholder ("placeholder shape—wire real inputs later", :4); `ageWeight`
  defined but UNUSED by `creditRateBps`.
- **packages/sdk** — hand-written ABIs + all-zero addresses ("TODO: Deploy and update",
  src/index.ts:119-121). No helpers despite README.
- **apps/web** — Next 15/React 19/wagmi. ONE page, one "Issue IOU to me" button with
  hardcoded invalid member `"0xMemberAddressHere"` (page.tsx:19) and client-side
  hardcoded fee (:20). `providers.tsx` is EMPTY and layout.tsx is default scaffold —
  wagmi hooks have NO provider; the button cannot work. Web duplicates the ABI instead
  of importing the sdk (app/contracts.ts).

## Structural traps
- Top-level `contracts/ indexer/ sdk/ src/ docs/` are ALL EMPTY — stale scaffolding.
  README quick-start AND `.github/workflows/ci.yml:31` (foundry job) point at the empty
  `contracts/` → CI builds nothing. The ts CI job suffixes every step `|| true` → cannot fail.
- Root `dev:web` filters `@dovizir/web` but the package is named `web` → filter matches nothing.
- Zero vitest files repo-wide; root/CI `test` steps are no-ops. Only Foundry tests are real.

## README vs code (claims the docs/agents must NOT trust)
"Stabilization guard" — does not exist. "coverage" — does not exist. Indexer "writes
CreditOracle" — write path absent. Web "convert→send IOU, redeem, issuer console" —
absent. `docs/` stories US-001..US-016/US-P12/US-Cxx — absent (only US-008 survives as a
comment, CreditOracle.sol:5). Nothing is deployed (all 0x0, no deploy scripts).

## Founder questions (intake queue)
1. Delete or fill the empty top-level dirs? (CI+README point at them.)
2. Anything deployed out-of-repo, or genuinely pre-deploy?
3. Semantics of NEGATIVE reserveBalance; who authorizes "members"; is unpermissioned
   deposit() intentional?
4. Where does the real IOU token / stablecoin settlement leg live (design)?
5. Real ICM v3 inputs + formula (US-008); where are the protocol story docs?
6. Who holds the CreditOracle updater key; cadence of rate pushes?
7. Was a working wagmi providers setup lost, or never built?
8. Consolidate web onto @dovizir/sdk?
9. mainnet intent? (SECURItY.md — filename typo — says testnet-only, unaudited.)
