import { createConfig, http } from "wagmi";
import { baseSepolia } from "wagmi/chains";
import { injected, walletConnect } from "wagmi/connectors";
import { getRpcUrl } from "@dovizir/sdk";
import { embeddedWallet } from "./embedded/connector";

// Connector strategy — the PoC creates a wallet FOR the user (no "Connect
// wallet"): `embeddedWallet()` is the primary connector, holding a locally
// generated key exposed to wagmi as an EIP-1193 provider. The injected /
// WalletConnect connectors remain as an escape hatch for users who DO have an
// external wallet.
//
// AA-SEAM: the production client swaps `embeddedWallet()` for an ERC-4337
// smart-account connector — a passkey (WebAuthn P-256) owner signs userOps, a
// bundler submits them, and the joined Sarraf's Pimlico paymaster sponsors gas
// (the "zero fee" promise). Everything downstream only talks wagmi, so it stays
// untouched.
const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

export const wagmiConfig = createConfig({
  chains: [baseSepolia],
  connectors: [
    embeddedWallet(),
    injected(),
    ...(walletConnectProjectId
      ? [walletConnect({ projectId: walletConnectProjectId })]
      : []),
  ],
  transports: {
    [baseSepolia.id]: http(getRpcUrl()),
  },
  ssr: false, // SPA — no server render
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
