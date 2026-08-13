/**
 * Story 001 — Arm B: pure-TypeScript `@dovizir/notes` conforming to the pinned
 * `notes-api.d.ts` contract.
 *
 * Tier-1 conformance suite. This story has no HTTP surface and no UI: the
 * *behavioural* contract is owned end-to-end by the read-only 95-spec acceptance
 * suite under `packages/acceptance/notes/**`. What this file freezes is the set of
 * structural invariants that suite cannot see:
 *
 *   - export-surface equality with the pinned `.d.ts`  (invariant 3, scenario 5)
 *   - the runtime dependency allowlist                 (invariant 2, scenario 3)
 *   - strict-typing posture / no suppressions          (invariant 5, scenario 4)
 *   - source-level determinism                         (invariant 6, scenario 7)
 *   - acceptance-suite hygiene + isolation             (invariants 8 and 9)
 *
 * Deliberately NOT asserted here:
 *   TODO(spec): scenario 1 ("vitest reports 95 passed / 0 failed / 0 skipped") is the
 *     shared suite's own result, produced by running it with `DOVIZIR_NOTES_IMPL`
 *     aliased at the Arm B package. Re-running a 95-spec suite inside a tier-1 test
 *     is neither in-process nor sub-second; CI remains the arbiter of green.
 *   TODO(spec): scenario 2 ("git diff --stat -- packages/acceptance/ is empty") is a
 *     VCS-level check. Shelling out to git here would be slow and environment
 *     dependent; CI owns it. The marker scan below is the in-process proxy.
 *   TODO(spec): scenario 6 (error type + message fidelity) is asserted by the pinned
 *     specs themselves. Reproducing it locally would require naming pinned functions
 *     and their message text, neither of which this spec carries — inventing them
 *     would contradict "implement the pinned text as written".
 *   TODO(spec): scenario 8 (file on #9, never skip or special-case a spec) is a
 *     process obligation with no in-process observable.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PACKAGE_NAME = "@dovizir/notes";
const ALLOWED_RUNTIME_DEPS: readonly string[] = ["@noble/curves", "@noble/hashes"];
const PINNED_DTS_RELATIVE = path.join("packages", "acceptance", "notes", "notes-api.d.ts");

/**
 * Escape hatch for invariant 6: a pinned signature may genuinely require a
 * capability. When it does, the capability must still be injected — annotate the
 * line so the requirement is explicit and auditable rather than ambient.
 */
const CAPABILITY_OPT_OUT = "pinned-capability:";

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
  ".turbo",
  ".next",
]);

const TS_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".mts", ".cts"];
const SPEC_EXTENSIONS: readonly string[] = [".ts", ".tsx", ".mts", ".js", ".mjs"];

interface Manifest {
  name?: string;
  main?: string;
  module?: string;
  types?: string;
  exports?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface PinnedSurface {
  /** Every exported name the pinned contract declares. */
  all: Set<string>;
  /** The subset that is type-only (interface / type / `export type { ... }`). */
  typeOnly: Set<string>;
}

interface TsConfig {
  extends?: string | string[];
  compilerOptions?: { strict?: boolean };
}

function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFile(target: string): boolean {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

/** cwd and each ancestor, stopping at (and including) the first `.git` root. */
function ancestorDirs(start: string): string[] {
  const out: string[] = [];
  let dir = path.resolve(start);
  for (;;) {
    out.push(dir);
    if (existsSync(path.join(dir, ".git"))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

function findUp(relative: string): string | null {
  for (const dir of ancestorDirs(process.cwd())) {
    const candidate = path.join(dir, relative);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function stripJsonComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

function readManifest(manifestPath: string): Manifest {
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  } catch {
    return {};
  }
}

function readTsConfig(configPath: string): TsConfig | null {
  try {
    return JSON.parse(stripJsonComments(readFileSync(configPath, "utf8"))) as TsConfig;
  } catch {
    return null;
  }
}

function listFilesRecursive(root: string, extensions: readonly string[]): string[] {
  if (!isDirectory(root)) return [];
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(abs);
        continue;
      }
      if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(abs);
    }
  }
  return out.sort();
}

let cachedPackageRoot: string | null = null;

function armBPackageRoot(): string {
  if (cachedPackageRoot !== null) return cachedPackageRoot;

  const candidates: string[] = [];
  for (const dir of ancestorDirs(process.cwd())) {
    candidates.push(dir);
    const packagesDir = path.join(dir, "packages");
    if (!isDirectory(packagesDir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(packagesDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = path.join(packagesDir, entry);
      if (isDirectory(child)) candidates.push(child);
    }
  }

  for (const candidate of candidates) {
    const manifestPath = path.join(candidate, "package.json");
    if (!isFile(manifestPath)) continue;
    if (readManifest(manifestPath).name === PACKAGE_NAME) {
      cachedPackageRoot = candidate;
      return candidate;
    }
  }

  throw new Error(
    `Could not locate the Arm B package: no package.json with name "${PACKAGE_NAME}" was ` +
      `found at or above ${process.cwd()} (nor in any sibling packages/* directory). ` +
      `Story 001 requires the implementation package to declare that exact name.`,
  );
}

function manifestEntryCandidates(manifest: Manifest): string[] {
  const out: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0) out.push(value);
  };
  push(manifest.module);
  push(manifest.main);
  const exportsField = manifest.exports;
  if (typeof exportsField === "string") {
    push(exportsField);
  } else if (exportsField !== null && typeof exportsField === "object") {
    const record = exportsField as Record<string, unknown>;
    const root = record["."] ?? exportsField;
    if (typeof root === "string") {
      push(root);
    } else if (root !== null && typeof root === "object") {
      for (const value of Object.values(root as Record<string, unknown>)) push(value);
    }
  }
  return out;
}

function resolveEntrypoint(packageRoot: string): string {
  const manifest = readManifest(path.join(packageRoot, "package.json"));
  const candidates = [
    path.join("src", "index.ts"),
    path.join("src", "index.mts"),
    path.join("src", "index.tsx"),
    ...manifestEntryCandidates(manifest),
  ];
  for (const relative of candidates) {
    const abs = path.resolve(packageRoot, relative);
    if (isFile(abs)) return abs;
  }
  throw new Error(
    `Arm B entrypoint not found under ${packageRoot}. Expected a source entrypoint at ` +
      `src/index.ts (or a "main"/"module"/"exports" target that exists on disk).`,
  );
}

async function importEntrypoint(): Promise<Record<string, unknown>> {
  const entry = resolveEntrypoint(armBPackageRoot());
  const loaded: unknown = await import(/* @vite-ignore */ pathToFileURL(entry).href);
  return loaded as Record<string, unknown>;
}

function pinnedDtsPath(): string {
  const found = findUp(PINNED_DTS_RELATIVE);
  if (found === null) {
    throw new Error(
      `Pinned contract not found: expected ${PINNED_DTS_RELATIVE} at or above ${process.cwd()}. ` +
        `Story 001 lists it as a precondition and read-only — do not create or re-pin it here; ` +
        `escalate a missing contract on issue #9.`,
    );
  }
  return found;
}

function stripTsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

function resolveRelativeDts(fromDir: string, specifier: string): string | null {
  const base = path.resolve(fromDir, specifier);
  const candidates = [
    base,
    `${base}.d.ts`,
    `${base}.ts`,
    base.replace(/\.js$/, ".d.ts"),
    path.join(base, "index.d.ts"),
  ];
  for (const candidate of candidates) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

let cachedSurface: PinnedSurface | null = null;

function pinnedSurface(): PinnedSurface {
  if (cachedSurface !== null) return cachedSurface;

  const all = new Set<string>();
  const typeOnly = new Set<string>();
  const visited = new Set<string>();
  const queue: string[] = [pinnedDtsPath()];

  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined) break;
    if (visited.has(file)) continue;
    visited.add(file);

    const source = stripTsComments(readFileSync(file, "utf8"));

    // `export { a, b as c }` / `export type { T }` / `export { type T, fn } from "..."`
    for (const match of source.matchAll(/export\s+(type\s+)?\{([^}]*)\}/g)) {
      const groupIsType = match[1] !== undefined;
      for (const raw of (match[2] ?? "").split(",")) {
        const specifier = raw.trim();
        if (specifier.length === 0) continue;
        const specifierIsType = /^type\s+/.test(specifier);
        const cleaned = specifier.replace(/^type\s+/, "");
        const parts = cleaned.split(/\s+as\s+/);
        const name = (parts[1] ?? parts[0] ?? "").trim();
        if (name.length === 0 || name === "*") continue;
        all.add(name);
        if (groupIsType || specifierIsType) typeOnly.add(name);
      }
    }

    // `export declare function foo(...)`, `export interface Bar`, `export const baz`, ...
    const declPattern =
      /export\s+(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(class|function|const|let|var|interface|type|enum|namespace)\s+\*?\s*([A-Za-z_$][\w$]*)/g;
    for (const match of source.matchAll(declPattern)) {
      const kind = match[1] ?? "";
      const name = match[2] ?? "";
      if (name.length === 0) continue;
      all.add(name);
      if (kind === "interface" || kind === "type") typeOnly.add(name);
    }

    if (/export\s+default\b/.test(source)) all.add("default");

    // `export * from "./x"` / `export * as ns from "./x"`
    const starPattern =
      /export\s+(?:type\s+)?\*\s*(?:as\s+([A-Za-z_$][\w$]*)\s+)?from\s*['"]([^'"]+)['"]/g;
    for (const match of source.matchAll(starPattern)) {
      const alias = match[1];
      const specifier = match[2] ?? "";
      if (alias !== undefined) {
        all.add(alias);
        continue;
      }
      const resolved = resolveRelativeDts(path.dirname(file), specifier);
      if (resolved === null) {
        throw new Error(
          `Cannot resolve 'export * from "${specifier}"' referenced by ${file}. The pinned ` +
            `contract must be self-contained for the export-surface check; escalate on #9.`,
        );
      }
      queue.push(resolved);
    }
  }

  cachedSurface = { all, typeOnly };
  return cachedSurface;
}

function relativeToRoot(absolute: string, root: string): string {
  return path.relative(root, absolute).split(path.sep).join("/");
}

function resolveStrictFlag(packageRoot: string): boolean | null {
  let configPath: string | null = path.join(packageRoot, "tsconfig.json");
  const seen = new Set<string>();

  while (configPath !== null && isFile(configPath) && !seen.has(configPath)) {
    seen.add(configPath);
    const config = readTsConfig(configPath);
    if (config === null) return null;
    const strict = config.compilerOptions?.strict;
    if (typeof strict === "boolean") return strict;

    const extendsField = config.extends;
    const specifiers =
      typeof extendsField === "string"
        ? [extendsField]
        : Array.isArray(extendsField)
          ? extendsField
          : [];

    let next: string | null = null;
    for (const specifier of specifiers) {
      const fromDir = path.dirname(configPath);
      const direct = specifier.startsWith(".")
        ? [path.resolve(fromDir, specifier), `${path.resolve(fromDir, specifier)}.json`]
        : [
            path.join(packageRoot, "node_modules", specifier),
            path.join(packageRoot, "node_modules", specifier, "tsconfig.json"),
            `${path.join(packageRoot, "node_modules", specifier)}.json`,
          ];
      const hit = direct.find((candidate) => isFile(candidate));
      if (hit !== undefined) {
        next = hit;
        break;
      }
    }
    configPath = next;
  }

  return null;
}

const AMBIENT_CAPABILITY_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "Date.now()", pattern: /\bDate\.now\s*\(/ },
  { label: "new Date()", pattern: /\bnew\s+Date\s*\(/ },
  { label: "Math.random()", pattern: /\bMath\.random\s*\(/ },
  { label: "crypto.getRandomValues()", pattern: /\bgetRandomValues\s*\(/ },
  { label: "performance.now()", pattern: /\bperformance\.now\s*\(/ },
  { label: "filesystem import", pattern: /['"]node:fs(?:\/promises)?['"]/ },
  { label: "network import", pattern: /['"]node:(?:https?|net|dgram|dns)['"]/ },
];

const SUPPRESSION_PATTERN = /@ts-(?:expect-error|ignore|nocheck)\b/;

const TEST_MARKER_PATTERN =
  /\b(?:it|test|describe|suite|bench)\s*\.\s*(skip|only|todo|failing)\b/;

describe("Story 001 — Arm B @dovizir/notes conformance to the pinned contract", () => {
  it("Given the Arm B entrypoint, When its exported names are compared to the pinned .d.ts export list, Then the two sets are equal", async () => {
    const surface = pinnedSurface();

    // Sanity: a parse that found nothing would make this assertion vacuous.
    expect(surface.all.size).toBeGreaterThan(0);

    // Type-only exports have no runtime footprint — their presence is a pure type
    // constraint enforced by `tsc --noEmit` against the pinned module surface, so
    // only value exports are compared here. Extras fail just as loudly as omissions.
    const expectedValueExports = [...surface.all]
      .filter((name) => !surface.typeOnly.has(name))
      .sort();

    const entrypoint = await importEntrypoint();
    const actualValueExports = Object.keys(entrypoint)
      .filter((key) => key !== "__esModule")
      .sort();

    expect(actualValueExports).toEqual(expectedValueExports);
  });

  it("Given the Arm B package.json, When its runtime dependencies are enumerated, Then every entry is @noble/curves or @noble/hashes", () => {
    const manifest = readManifest(path.join(armBPackageRoot(), "package.json"));
    const runtimeDeps = Object.keys(manifest.dependencies ?? {}).sort();
    const disallowed = runtimeDeps.filter((name) => !ALLOWED_RUNTIME_DEPS.includes(name));

    // Anything else belongs under devDependencies (invariant 2, scenario 3).
    expect(disallowed).toEqual([]);
  });

  it("Given a pinned signature that requires randomness or a timestamp, When src/ is inspected, Then no module consults an ambient clock, global RNG, filesystem, or network", () => {
    const root = armBPackageRoot();
    const violations: string[] = [];

    for (const file of listFilesRecursive(path.join(root, "src"), TS_EXTENSIONS)) {
      if (/\.(?:test|spec)\.[cm]?tsx?$/.test(file)) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (line.includes(CAPABILITY_OPT_OUT)) return;
        for (const { label, pattern } of AMBIENT_CAPABILITY_PATTERNS) {
          if (pattern.test(line)) {
            violations.push(`${relativeToRoot(file, root)}:${index + 1} — ${label}`);
          }
        }
      });
    }

    // Where a pinned signature genuinely needs the capability, take it as a parameter
    // or injected dependency and annotate the line with `pinned-capability: <reason>`
    // so two runs against the same injected source stay byte-identical.
    expect(violations).toEqual([]);
  });

  it("Given the package under strict TypeScript, When src/ is scanned, Then strict is enabled and no type-suppression comment is present", () => {
    const root = armBPackageRoot();
    const suppressions: string[] = [];

    for (const file of listFilesRecursive(path.join(root, "src"), TS_EXTENSIONS)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (SUPPRESSION_PATTERN.test(line)) {
          suppressions.push(`${relativeToRoot(file, root)}:${index + 1}`);
        }
      });
    }

    expect(suppressions).toEqual([]);

    // If this reads null the flag could not be resolved through the extends chain —
    // set "strict": true explicitly in the package tsconfig.
    expect(resolveStrictFlag(root)).toBe(true);
  });

  it("Given the shared acceptance suite, When it is scanned for test markers, Then no .skip / .only / .todo / .failing marker is present", () => {
    const acceptanceDir = path.dirname(pinnedDtsPath());
    const specFiles = listFilesRecursive(acceptanceDir, SPEC_EXTENSIONS);

    // Guard against a vacuous pass if the suite ever moves.
    expect(specFiles.length).toBeGreaterThan(0);

    const markers: string[] = [];
    for (const file of specFiles) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (TEST_MARKER_PATTERN.test(line)) {
          markers.push(`${relativeToRoot(file, acceptanceDir)}:${index + 1} — ${line.trim()}`);
        }
      });
    }

    // Arm B never games the harness: 95 of 95 must pass, none may be disabled. A
    // pre-existing marker in the pinned suite is a contract defect — escalate on #9
    // rather than editing packages/acceptance/**.
    expect(markers).toEqual([]);
  });

  it("Given the Arm B package's own unit tests, When their contents are inspected, Then none reach into packages/acceptance", () => {
    const root = armBPackageRoot();
    const offenders: string[] = [];

    for (const file of listFilesRecursive(path.join(root, "src"), TS_EXTENSIONS)) {
      if (!/\.(?:test|spec)\.[cm]?tsx?$/.test(file)) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (line.includes("packages/acceptance")) {
          offenders.push(`${relativeToRoot(file, root)}:${index + 1}`);
        }
      });
    }

    // Own tests live inside the package and carry their own fixtures (invariant 9).
    expect(offenders).toEqual([]);
  });
});
