import { createConfig, http } from "wagmi";
import { baseSepolia } from "wagmi/chains";
import { injected, walletConnect } from "wagmi/connectors";
import { getRpcUrl } from "@dovizir/sdk";

// AA-SEAM: connector strategy.
// These EOA connectors (injected / WalletConnect) are the M2 placeholder.
// The production client replaces them with an ERC-4337 smart-account client:
// a passkey (WebAuthn P-256) owner signs userOps, a bundler submits them, and
// the Pimlico paymaster sponsors gas (the "zero fee" promise). When that
// lands, swap the connectors below for the smart-account connector and leave
// everything downstream (hooks, screens) untouched — they only talk wagmi.
const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

export const wagmiConfig = createConfig({
  chains: [baseSepolia],
  connectors: [
    injected(),
    ...(walletConnectProjectId
      ? [walletConnect({ projectId: walletConnectProjectId })]
      : []),
  ],
  transports: {
    [baseSepolia.id]: http(getRpcUrl()),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
