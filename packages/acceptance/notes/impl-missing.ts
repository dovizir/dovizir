/**
 * Fallback target for the `@dovizir/notes` alias when no arm implementation
 * is provided. Throwing at module load makes every spec file fail with a
 * meaningful message instead of the suite vacuously passing/erroring.
 */
throw new Error(
  "no implementation aliased: set DOVIZIR_NOTES_IMPL to the path of an arm's built @dovizir/notes entry module, e.g. DOVIZIR_NOTES_IMPL=/abs/path/to/arm/packages/notes/dist/index.js pnpm vitest run"
);

export {};
