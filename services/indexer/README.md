# @dovizir/indexer

Off-chain indexer for the Dovizir M1 protocol. It syncs the deployed contract
events into SQLite, derives per-Sarraf and per-member state, and serves it over
a small Fastify REST API that the Sarraf desk (`apps/web`) reads.

It is read-only: it never signs or sends a transaction. Everything it exposes is
derived from on-chain events, cross-checked against the contracts' own view
functions (`backingOf`, `outstandingOf`, `twabOf`, `isCertified`).

## Run it

The indexer discovers RPC + addresses from the deployment env file that
`Deploy.s.sol` writes, or from explicit env vars (env wins).

```bash
# 1. spin up a chain + deploy + generate real events
anvil &
cd packages/contracts
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 \
  --unlocked --sender 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266 --broadcast
RPC_URL=http://127.0.0.1:8545 ./script/demo-loop.sh   # deposit → issue → send → redeem

# 2. run the indexer against it
cd ../../services/indexer
RPC_URL=http://127.0.0.1:8545 \
DEPLOYMENTS_DIR=../../packages/contracts/deployments \
pnpm start          # API on :4000, background sync loop
# or: pnpm sync     # one-shot sync to head, no server (handy for CI/proofs)
```

### Configuration (env)

| var               | default                     | meaning                                             |
| ----------------- | --------------------------- | --------------------------------------------------- |
| `RPC_URL`         | `http://127.0.0.1:8545`     | JSON-RPC endpoint                                   |
| `CHAIN_ID`        | read from RPC               | selects `deployments/<id>.env`                      |
| `DEPLOYMENTS_DIR` | `<repo>/deployments`        | where the `<chainId>.env` address file lives        |
| `*_ADDRESS`       | from the env file           | override any contract address (e.g. `RESERVE_POOL_ADDRESS`) |
| `START_BLOCK`     | `0`                         | first block to index                               |
| `REORG_DEPTH`     | `12`                        | blocks re-scanned every poll (shallow-reorg safety) |
| `POLL_INTERVAL_MS`| `2000`                      | sync poll cadence                                  |
| `PAGE_SIZE`       | `5000`                      | `getLogs` window                                   |
| `DB_PATH`         | `services/indexer/indexer.db` | SQLite file                                       |
| `PORT`            | `4000`                      | API port                                           |

## Sync model

- `getLogs` per contract for the SDK's event ABIs, decoded and written to the
  `events` table keyed by `(tx_hash, log_index)` — re-syncs are **idempotent**.
- A `meta.lastBlock` cursor tracks progress. Each poll rewinds the cursor by
  `REORG_DEPTH`, deletes that tail, and re-reads it, so a shallow reorg
  self-heals without a full resync.
- Block timestamps are resolved and cached per block (needed for the TWAB).

## Derived state

All derivation lives in `src/derive.ts` as **pure functions** over the decoded
event list — no chain, no DB — which is exactly what the Vitest suite exercises
with synthetic fixtures (`pnpm test`, no live chain required).

- **Coverage** — `backing = Σ Deposited − Σ Redeemed`,
  `outstanding = Σ Issued − Σ Redeemed` (per tranche, migrations aware);
  `coverage = backing / outstanding`.
- **TWAB** — trailing-7d time-weighted average backing, integral-matched to
  `SarrafRegistry` (a constant balance held across the window returns exactly
  that balance). The reference clock is the later of wall-clock and the latest
  block time, so a time-warped dev chain reads the same TWAB the contract does.
- **Certification bands** — the 100/90 hysteresis: `certified` at
  `twab ≥ floor`, `at-risk` in `[0.9·floor, floor)`, `below-floor` under that.
  `floor = min(totalDeposits/5, 1_000_000e6)`. The authoritative on-chain
  `Certified`/`Decertified` status is served alongside as `certifiedOnChain`.
- **Yardstick P&L** (act-2 data) — per-sarraf deposit/issue/redemption volume,
  fees generated, the 50/50 fund split, and a spread proxy (effective bps).
- **Members** — membership + sponsor from the registry events, IOU balances
  netted from `TransferSingle`, and per-member tx history.

### Computed `creditRateBps` — advisory / DORMANT

The indexer computes a coverage-based credit-headroom number per sarraf:

```
free = backing − outstanding
creditRateBps = clamp( free / backing · 10000 , 0 , 2000 )   # ≤ 20%
```

**Nothing on-chain reads or enforces this.** It is the "wired but dormant" hook
for act-3 credit issuance. Per the M3 scoping decision, this task deliberately
does **not** add an on-chain `CreditOracle` contract — adding protocol surface
for dormant act-3 credit issuance would need its own security review. The oracle
*write* lands with act-3 proper; until then the rate is served over the API as
advisory only (`creditRateAdvisory: true`) so downstream UIs can be built
against its shape without any protocol change.

## Offline-notes pending-serials feed

For notes spent offline before on-chain settlement, an online seller can check a
note's serial before accepting it:

- `POST /serials { serial, payload }` — record a spend transcript as `pending`.
- `GET /serials/pending` — the open feed.
- `GET /serials/:serial` — `pending` | `spent` | `unknown`.
- When the matching `NoteReconciled` / `DoubleSpendConvicted` event is indexed,
  the serial flips to `spent` with its `outcome` (`reconciled` | `convicted`).

## API

| method | path                 | returns                                                    |
| ------ | -------------------- | ---------------------------------------------------------- |
| GET    | `/health`            | liveness, chainId, last synced block, event count          |
| GET    | `/stats`             | network totals (backing, outstanding, fees, counts, floor) |
| GET    | `/snapshot`          | desk payload: stats + every sarraf's book                  |
| GET    | `/sarraf/:addr`      | coverage, cert (on-chain + band), TWAB, members, credit, P&L |
| GET    | `/sarraf/:addr/pnl`  | act-2 yardstick P&L only                                   |
| GET    | `/member/:addr`      | balances, sponsor, tx history                              |
| GET    | `/serials/pending`   | pending offline-note serials                               |
| GET    | `/serials/:serial`   | serial status                                              |
| POST   | `/serials`           | submit a spend transcript                                  |

All amounts are 6-decimal integer strings (mock USDT / IOU), matching the SDK.

## Tests

```bash
pnpm test        # Vitest — pure derivation logic on synthetic fixtures
```

The fixtures reproduce `demo-loop.sh` at scale, so the suite pins the same
numbers the live loop produces: coverage `999600e6 / 600e6`, redeem fee
`3.60 mUSDT` split `1.80 / 1.80`, `creditRateBps` clamped to `2000`.
No live chain is needed. (An e2e-against-anvil check is done manually via
`pnpm sync` + the endpoints above; it is not part of the unit suite.)
