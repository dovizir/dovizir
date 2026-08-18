# Dovizir

**IOU-first stablecoin protocol & wallet** — Base Sepolia testnet.

> ⚠️ Security: This is experimental, unaudited code, intended for **testnet only**.

## Packages
- `contracts/` — Solidity (Foundry). Reserve Pool, IOU, Fees, Stabilization guard.
- `indexer/` — TypeScript (viem). Computes ICM v3 (age-weighted), coverage, writes CreditOracle.
- `sdk/` — TypeScript client (ABIs, helpers).
- `apps/web/` — Next.js + wagmi demo (convert→send IOU, redeem, issuer console).

## Quick start
```bash
# contracts
cd contracts
forge install
forge test

# indexer
cd ../indexer
pnpm i
pnpm test

# web
cd ../apps/web
pnpm i
pnpm dev

# Chain
Base Sepolia (chainId 84532). Use a public RPC and faucet ETH for gas.

# Docs
See docs/ for protocol stories (US-001..US-016, US-P12) and consumer US-Cxx packs.

#License
Business Source License 1.1 — see `LICENSE`, and the Licence section below.

## Licence

Dovizir is released under the **Business Source License 1.1** (see `LICENSE`).

It is **source available, not OSI open source**. Concretely:

- You may read, audit, copy, modify, and self-host it.
- **A sarraf, merchant, or end user may run an instance for their own
  business** — holding their own funds, serving their own customers.
- You may **not** offer Dovizir, or a derivative, to third parties as a hosted,
  managed, or embedded service.
- On **2030-08-17** it converts automatically to **GPL-2.0-or-later**.

Auditability is the point: the trust model depends on anyone being able to
verify what the contracts do, and BUSL preserves that in full.
