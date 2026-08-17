import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";

// Client-rendered SPA + PWA — no SSR (this is a per-user authed wallet app; SSR
// buys nothing and the offline-notes feature wants a service worker). See
// dovizir-review-loop-vite-pwa design note.
export default defineConfig(({ mode }) => {
  // @dovizir/sdk reads process.env.NEXT_PUBLIC_*; expose those from .env as a
  // literal object so `process.env.X` resolves (and unknown keys are undefined,
  // not a ReferenceError). NODE_ENV included for libs that branch on it.
  const nextEnv = loadEnv(mode, process.cwd(), ["NEXT_PUBLIC_"]);
  const processEnv = {
    NODE_ENV: mode === "production" ? "production" : "development",
    ...nextEnv,
  };

  return {
  define: {
    "process.env": JSON.stringify(processEnv),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "Dovizir",
        short_name: "Dovizir",
        description: "Everyday P2P payments, backed 1:1",
        theme_color: "#2196F3",
        background_color: "#FFFFFF",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // App shell precache; runtime cache for the indexer/RPC is added later.
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        navigateFallback: "/index.html",
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // Ported components import hooks from "next-intl"; redirect to the
      // use-intl shim so they work unchanged in the SPA.
      "next-intl": path.resolve(__dirname, "src/i18n/next-intl-shim.ts"),
      // next/link + next/navigation → react-router shims (see lib/shims).
      "next/link": path.resolve(__dirname, "src/lib/shims/next-link.tsx"),
      "next/navigation": path.resolve(__dirname, "src/lib/shims/next-navigation.ts"),
    },
  },
  server: { port: 3200, host: true },
  preview: { port: 3200, host: true },
  };
});
