# Dovizir REFEREE acceptance suite (Foundry)

The mechanical referee for the dual-build experiment
(`docs/experiment/PROTOCOL.md` §3). Both arms are scored by running **this
suite unmodified** against their own deployment. The frozen protocol
interfaces live in `src/interfaces/IDovizir.sol`.

## Layout

```
foundry.toml                       standalone project; libs -> ../contracts/lib
src/interfaces/IDovizir.sol        frozen protocol interfaces (referee copy)
src/interfaces/IAcceptanceDeployer.sol  the hook each arm implements (frozen)
src/TranscriptLib.sol              frozen NoteVault transcript encoding (spec)
src/AuthLib.sol                    frozen EIP-712 domain for transferWithAuthorization (spec)
src/StubDeployer.sol               compile-check stub — every call reverts "STUB"
test/AcceptanceBase.sol            abstract fixture; resolves the deployer
test/*.t.sol                       acceptance tests, one file per contract area
test/TranscriptLib.t.sol           self-tests of the referee's own frozen math
                                   (pass standalone; exercise no arm code)
test/handlers/DovizirHandler.sol   bounded-op handler for the invariant suite
test/Invariants.t.sol              invariants (a)–(d)
```

## Running

```sh
cd packages/acceptance
forge build          # must pass standalone (stub)
forge test           # every test FAILS against the stub — expected
```

## How an arm plugs in

`AcceptanceBase.setUp()` resolves the system under test with

```solidity
deployCode(vm.envOr("DOVIZIR_DEPLOYER", string("src/StubDeployer.sol:StubDeployer")))
```

so an arm:

1. writes a contract implementing `IAcceptanceDeployer` (`deploy()` returns a
   fresh, fully wired `DovizirSystem` on every call — it is invoked once per
   test), together with its implementation contracts, reachable from this
   project (e.g. drop them under `src/arm/`, or add a remapping in an
   env-supplied `FOUNDRY_REMAPPINGS` / `remappings.txt` pointing at the arm's
   package);
2. runs the suite with the env var pointing at the artifact:

```sh
DOVIZIR_DEPLOYER="src/arm/ArmDeployer.sol:ArmDeployer" forge test
```

No test file is edited. Same tests, same seeds for both arms.

Deployer requirements (also documented on `IAcceptanceDeployer`):

- `usdt`: mock ERC-20, `decimals() == 6`, **open** `mint(address,uint256)`.
- All contracts read `block.timestamp` live — the suite drives time with
  `vm.warp`.
- The suite grants permissive ERC-1155 `setApprovalForAll(pool)` /
  `setApprovalForAll(vault)` for its actors, so both custody-transfer and
  burn/mint lock styles work.

## Frozen spec additions

These were under-specified by `IDovizir.sol`; the referee pins them here.
Deviating from them fails the suite (PROTOCOL.md §5 governs genuine spec-bug
amendments).

1. **Spend transcripts** (`src/TranscriptLib.sol`, normative): invoice struct
   `(address recipient, uint256 amount, bytes32 nonce)`;
   `invoiceHash = keccak256(abi.encode(INVOICE_TYPEHASH, ...))`;
   `spendDigest = keccak256(abi.encodePacked(serial, invoiceHash))`; carver
   signs the **raw** digest (65-byte r‖s‖v, no EIP-191/712 prefix);
   `transcript = abi.encode(recipient, amount, nonce)`; merkle leaves are
   `keccak256(abi.encodePacked(serial))` with sorted-pair interior hashing
   (OpenZeppelin-compatible), odd node promoted. This deliberately may differ
   from the TS wire format — NoteVault verifies its own encoding.
2. **EIP-712 domain for `transferWithAuthorization`** (`src/AuthLib.sol`,
   normative): name `"Dovizir IOU"`, version `"1"`, `chainId`,
   `verifyingContract = IouToken`; typehash
   `TransferWithAuthorization(address from,address to,uint256 id,uint256 amount,uint256 validAfter,uint256 validBefore,bytes32 nonce)`;
   signature format `abi.encodePacked(r, s, v)`.
3. **Redemption fee rounding**: `fee = amount * 90 / 10_000` (rounds down).
4. **InsuranceFund split rounding**: for an odd-wei fee,
   `maintenanceShare += fee / 2` (round down) and
   `overseeingShare += fee - fee / 2` (gets the extra wei).
5. **Byte-identical reconcile resubmission**: canonical behavior is
   `revert("ALREADY_RECONCILED")`. The tests tolerate a state-neutral no-op;
   they never tolerate a conviction or a second payment.
6. **Double-spend handling**: a second **carver-signed** transcript for an
   already-spent serial with a *different* invoice convicts. The carver's
   **entire remaining locked value** is seized first (lockedOf → 0); the
   victim is made whole for exactly the invoice amount (carver-tranche IOU
   from seizure, USDT from `InsuranceFund.payClaim` for the shortfall). A
   conflicting transcript *not* signed by the carver must revert without
   conviction.

## Interpretations recorded (candidate spec-bug reviews)

Where `IDovizir.sol` was ambiguous, the referee had to choose. Flagged for
review under PROTOCOL.md §5:

- **`deposit()` is NOT certification-gated.** The interface comment says
  "caller = certified Sarraf", but certification *requires* a 7-day deposit
  TWAB ≥ floor — a certification-gated deposit deadlocks every later entrant
  once floor > 0. Encoded: any sarraf may deposit; only `issue()` (and
  member onboarding) require certification.
- **`evaluate()` evaluates `msg.sender`**, and the 24h rate limit is per
  sarraf. "Consecutive evaluations" = successive `evaluate()` calls (any
  spacing ≥ 24h), not calendar days.
- **`floor()` uses spot `totalDeposits`** (only the sarraf's own balance is
  time-weighted). Hysteresis exit is *strictly* below 90% of floor.
- **`redeem()` is open to any holder** (no membership requirement) — the
  interface calls the caller "holder" throughout.
- **`capOf` value is unspecified.** The suite requires `capOf(member) > 0`
  and ≥ 50,000e6 for its fixtures (`test_capOf_isNonZeroForMember`). The
  actual base-cap number is a candidate spec gap.
- **Mint/burn "pool-only" vs. vault payouts**: `reconcile` *mints* the
  recipient carver-tranche IOU while `IIouToken` says mint/burn are
  pool-only. The suite only asserts that *unprivileged* callers cannot
  mint/burn; whether the vault holds custody + transfers, or is an authorized
  minter alongside the pool, is left to the arm (invariant (a) is defined to
  hold under both).
- **`migrate` "from-tranche impaired" revert** is untestable in M1: funded-only
  issuance (invariant (b)) makes impairment unreachable through the public
  surface. Not encoded.

## Invariants (precise definitions)

Over a closed holder set H (3 members, 2 recipients) driven by
`DovizirHandler` (deposits, issuance, redemption, 1155 transfers, carves,
reconciles, byte-identical replays, expiry refunds, warps):

- **(a)** ∀ sarraf s:
  `outstandingOf(s) == Σ_{h∈H} balanceOf(h, id(s)) + Σ_{m sponsored by s} lockedOf(m)`
  (vault address excluded from the sum — locked value is counted via
  `lockedOf` exactly once).
- **(b)** ∀ sarraf s: `backingOf(s) >= outstandingOf(s)`.
- **(c)** `fund.totalReserves() == fund.overseeingShare() + fund.maintenanceShare()`.
- **(d)** no serial pays twice: ghost `timesPaid[serial] <= 1` across all
  observed payments including replay attempts, and every paid serial reports
  `isSpent`.

## Expected results against the stub

`forge build` passes. `forge test` fails every acceptance test/invariant with
`STUB` reverts — that is the demonstration that no test silently passes
vacuously. The only standalone passes are the `TranscriptLib` self-tests
(referee-internal math) and the deployer-distinctness sanity check (a genuine
property of the stub deployer itself). Arms are scored on the same suite via
`DOVIZIR_DEPLOYER`.
