# Repo conventions (for slowcook agents)

- pnpm monorepo; REAL code in packages/contracts (Foundry), packages/sdk, services/indexer,
  apps/web. Top-level contracts/ indexer/ sdk/ src/ docs/ are EMPTY stale scaffolding —
  never emit code there.
- Solidity: Foundry, evm paris, tests in packages/contracts/test/*.t.sol (forge test).
- TS: ESM, Node >=20, vitest declared at root but NO ts tests exist yet — new ts tests
  should be colocated `*.test.ts` and run via root `pnpm test`.
- Web: Next 15 app router, tailwind v4, wagmi v2 — NOTE providers.tsx is empty; any web
  story must first wire WagmiProvider/QueryClient in layout.
- Chain: Base Sepolia (84532). Addresses are 0x0 placeholders until first deploy; keep
  the sdk (`packages/sdk/src/index.ts`) as the single source for ABIs/addresses (the web
  app's local copy in app/contracts.ts is drift-prone — prefer consolidating).
- CI (.github/workflows/ci.yml) currently can't fail (|| true) and its foundry job points
  at the EMPTY contracts/ dir — fix paths before trusting green.
See .brewing/as-built.md for the full inventory.
