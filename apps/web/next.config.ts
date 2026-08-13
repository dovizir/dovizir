import path from "node:path";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const nextConfig: NextConfig = {
  // @dovizir/sdk ships TypeScript source; transpile it in-app.
  transpilePackages: ["@dovizir/sdk"],
  // Monorepo root (avoids Turbopack picking a stray lockfile above the repo).
  turbopack: { root: path.join(__dirname, "../..") },
};

export default withNextIntl(nextConfig);
