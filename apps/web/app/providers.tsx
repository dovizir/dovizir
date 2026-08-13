"use client";

import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { wagmiConfig } from "@/lib/wagmi";

// The next-intl provider lives in app/layout.tsx (it needs server-side
// locale/messages); this file wires the client-side providers.
// AA-SEAM: when the ERC-4337 passkey smart-account client lands, it is
// initialized here (alongside the wagmi config in lib/wagmi.ts) so the rest
// of the tree keeps consuming plain wagmi hooks.
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 10_000 } },
      }),
  );

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
