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
MIT — see LICENSE.
