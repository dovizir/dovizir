import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * REFEREE alias: `@dovizir/notes` resolves to whatever module the env var
 * DOVIZIR_NOTES_IMPL points at (an arm's built package entry, e.g.
 * `.../arm-a/packages/notes/dist/index.js`). Without it, the alias falls back
 * to ./impl-missing.ts, which throws "no implementation aliased" so the whole
 * suite fails loudly instead of silently passing on nothing.
 */
const impl = process.env.DOVIZIR_NOTES_IMPL;
const target = impl
  ? isAbsolute(impl)
    ? impl
    : resolve(process.cwd(), impl)
  : resolve(here, "impl-missing.ts");

export default defineConfig({
  resolve: {
    alias: [{ find: /^@dovizir\/notes$/, replacement: target }],
  },
  test: {
    include: ["specs/**/*.spec.ts"],
    environment: "node",
  },
});
