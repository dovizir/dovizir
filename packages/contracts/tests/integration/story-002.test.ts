/**
 * Tier-1 source-contract tests for story-002 —
 * "Arm B: implement the six frozen IDovizir contracts + ArmBDeployer so the
 *  shared forge acceptance suite passes unchanged".
 *
 * This story has no HTTP handler and no UI. Its contract surface is Solidity
 * source + Foundry config under a frozen acceptance package. Tier-1 therefore
 * runs in-process against the repository itself: it parses the frozen
 * interface file, the Arm B source tree, and the acceptance package's git
 * baseline, and asserts the structural + naming + scoping invariants the spec
 * declares.
 *
 * TODO(spec): the EVM-runtime half of scenarios 1, 3, 4, 5, 6 and 7 (actual
 * `forge test` execution, real revert data, real byte equality) is owned by the
 * FROZEN suite in `packages/acceptance/` and cannot run in-process under a 1s
 * tier-1 budget. Each scenario below asserts the strongest statically-checkable
 * proxy for its runtime claim and says so in its title.
 *
 * TODO(spec): the spec does not name the on-disk path of the Arm B source tree
 * (proposals.infra says only "an additive remapping ... pointing at the Arm B
 * source tree"). This file discovers it from the remapping targets in
 * `packages/acceptance/foundry.toml`, falling back to a repo scan.
 *
 * TODO(spec): the deployer's exact entrypoint name and the exact value format
 * of `DOVIZIR_DEPLOYER` live in the FROZEN `packages/acceptance/README.md`; the
 * spec deliberately does not restate them. Assertions here are shape-level.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

// ---------------------------------------------------------------------------
// Repo layout
// ---------------------------------------------------------------------------

const ACCEPTANCE_REL = join("packages", "acceptance");

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 16; i += 1) {
    if (existsSync(join(dir, ACCEPTANCE_REL))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `story-002: could not locate a repo root containing ${ACCEPTANCE_REL}/ starting from ${process.cwd()}`,
  );
}

const REPO = findRepoRoot();
const ACCEPTANCE = join(REPO, ACCEPTANCE_REL);
const IDOVIZIR_PATH = join(ACCEPTANCE, "src", "interfaces", "IDovizir.sol");
const TRANSCRIPT_LIB_PATH = join(ACCEPTANCE, "src", "TranscriptLib.sol");
const AUTH_LIB_PATH = join(ACCEPTANCE, "src", "AuthLib.sol");
const README_PATH = join(ACCEPTANCE, "README.md");
const FOUNDRY_TOML_PATH = join(ACCEPTANCE, "foundry.toml");
const ARM_DIR = join(ACCEPTANCE, "src", "arm");
const DEPLOYER_PATH = join(ARM_DIR, "ArmBDeployer.sol");
const DEPLOYER_REL = relative(REPO, DEPLOYER_PATH).split(sep).join("/");
const FOUNDRY_TOML_REL = relative(REPO, FOUNDRY_TOML_PATH).split(sep).join("/");

const EXPECTED_INTERFACE_COUNT = 6;

const SKIP_DIRS = new Set([
  "node_modules",
  "out",
  "cache",
  "lib",
  "broadcast",
  "artifacts",
  "dist",
  "coverage",
  "target",
  "tests",
]);

// ---------------------------------------------------------------------------
// Tiny Solidity source reader / parser (declaration-level only)
// ---------------------------------------------------------------------------

function readIfExists(p: string): string | null {
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

function walkSol(root: string, acc: string[] = []): string[] {
  if (!existsSync(root)) return acc;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const p = join(root, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkSol(p, acc);
    } else if (entry.isFile() && entry.name.endsWith(".sol")) {
      acc.push(p);
    }
  }
  return acc;
}

type BlockKind = "contract" | "abstract" | "interface" | "library";

interface SolBlock {
  kind: BlockKind;
  name: string;
  bases: string[];
  body: string;
  file: string;
}

const BLOCK_RE =
  /\b(abstract\s+contract|contract|interface|library)\s+([A-Za-z_$][\w$]*)\s*(?:is\s+([^{]+))?\{/g;

function parseBlocks(src: string, file: string): SolBlock[] {
  const clean = stripComments(src);
  const out: SolBlock[] = [];
  const re = new RegExp(BLOCK_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    const openIdx = re.lastIndex - 1;
    let depth = 0;
    let i = openIdx;
    for (; i < clean.length; i += 1) {
      const ch = clean[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const keyword = m[1].replace(/\s+/g, " ");
    const kind: BlockKind =
      keyword === "abstract contract"
        ? "abstract"
        : keyword === "contract"
          ? "contract"
          : keyword === "interface"
            ? "interface"
            : "library";
    out.push({
      kind,
      name: m[2],
      bases: (m[3] ?? "")
        .split(",")
        .map((s) => s.trim().replace(/\(.*$/, "").trim())
        .filter(Boolean),
      body: clean.slice(openIdx + 1, Math.max(openIdx + 1, i)),
      file,
    });
  }
  return out;
}

function matchAllNames(src: string, re: RegExp): string[] {
  return [...src.matchAll(re)].map((m) => m[1]);
}

const FUNCTION_RE = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;
const EVENT_RE = /\bevent\s+([A-Za-z_$][\w$]*)\s*\(/g;
const ERROR_RE = /\berror\s+([A-Za-z_$][\w$]*)\s*\(/g;
const EMIT_RE = /\bemit\s+([A-Za-z_$][\w$]*)\s*\(/g;
const REVERT_RE = /\brevert\s+([A-Za-z_$][\w$]*)\s*\(/g;
const PUBLIC_VAR_RE =
  /\bpublic\b(?!\s*(?:view|pure|payable|virtual|override|returns|\{))\s+(?:constant\s+|immutable\s+)?([A-Za-z_$][\w$]*)\s*(?:=|;)/g;

function topLevelStatements(body: string): string[] {
  const stmts: string[] = [];
  let depth = 0;
  let buf = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "{") {
      depth += 1;
      buf += ch;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      buf += ch;
      if (depth <= 0) {
        depth = 0;
        buf = "";
      }
      continue;
    }
    if (depth === 0 && ch === ";") {
      const stmt = buf.trim();
      buf = "";
      if (stmt) stmts.push(stmt);
      continue;
    }
    buf += ch;
  }
  return stmts;
}

const NON_STATE_PREFIX =
  /^(function|modifier|event|error|struct|enum|using|constructor|receive|fallback|import|pragma|type)\b/;

function stateVariableDeclarations(body: string): string[] {
  return topLevelStatements(body).filter((s) => !NON_STATE_PREFIX.test(s));
}

function pragmaLines(src: string): string[] {
  return [...stripComments(src).matchAll(/pragma\s+solidity\s+([^;]+);/g)].map((m) =>
    m[1].replace(/\s+/g, " ").trim(),
  );
}

function wordRefRe(name: string): RegExp {
  // Matches `Foo` but not `IFoo`, `FooBar`, `MyFoo`.
  return new RegExp(`(?<![A-Za-z0-9_$])${name}(?![A-Za-z0-9_$])`);
}

// ---------------------------------------------------------------------------
// git baseline helpers (graceful when history is unavailable)
// ---------------------------------------------------------------------------

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: REPO,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

let mergeBaseCache: string | null | undefined;

function mergeBase(): string | null {
  if (mergeBaseCache !== undefined) return mergeBaseCache;
  const candidates = [
    process.env.SLOWCOOK_BASE_REF,
    "origin/main",
    "main",
    "origin/master",
    "master",
  ].filter((r): r is string => Boolean(r));
  for (const ref of candidates) {
    const out = git(["merge-base", "HEAD", ref]);
    const sha = out?.trim();
    if (sha) {
      mergeBaseCache = sha;
      return sha;
    }
  }
  mergeBaseCache = null;
  return null;
}

function baselineFile(relPath: string): string | null {
  const mb = mergeBase();
  if (!mb) return null;
  return git(["show", `${mb}:${relPath}`]);
}

function changedUnderAcceptance(): string[] | null {
  const mb = mergeBase();
  if (!mb) return null;
  const diff = git(["diff", "--name-only", mb, "--", ACCEPTANCE_REL]);
  if (diff === null) return null;
  const untracked =
    git(["ls-files", "--others", "--exclude-standard", "--", ACCEPTANCE_REL]) ?? "";
  const all = `${diff}\n${untracked}`
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(all)];
}

// ---------------------------------------------------------------------------
// World: the parsed view of the frozen suite + the Arm B tree
// ---------------------------------------------------------------------------

interface World {
  idovizirRaw: string | null;
  interfaces: SolBlock[];
  declaredEvents: string[];
  declaredErrors: string[];
  transcriptLibRaw: string | null;
  authLibRaw: string | null;
  readmeRaw: string | null;
  foundryTomlRaw: string | null;
  armRoots: string[];
  armFiles: string[];
  armSources: Array<{ file: string; raw: string; clean: string }>;
  armBlocks: SolBlock[];
  deployerRaw: string | null;
  deployerBlock: SolBlock | null;
  acceptanceSolFiles: string[];
  blockByName: Map<string, SolBlock>;
}

function parseRemappingTargets(toml: string): string[] {
  const targets: string[] = [];
  for (const m of toml.matchAll(/["']([^"'=\n]+)=([^"'\n]+)["']/g)) {
    targets.push(m[2].trim());
  }
  return targets;
}

function discoverArmRoots(toml: string | null): string[] {
  const roots: string[] = [];
  if (toml) {
    for (const target of parseRemappingTargets(toml)) {
      const abs = resolve(ACCEPTANCE, target);
      if (abs === ACCEPTANCE || abs.startsWith(ACCEPTANCE + sep)) continue;
      if (abs.split(sep).some((seg) => SKIP_DIRS.has(seg))) continue;
      if (!existsSync(abs)) continue;
      let isDir = false;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) continue;
      if (walkSol(abs).length === 0) continue;
      roots.push(abs);
    }
  }
  if (roots.length > 0) return [...new Set(roots)];
  // Fallback: every .sol in the repo that is not part of the acceptance package.
  const scanned = walkSol(REPO).filter(
    (p) => !p.startsWith(ACCEPTANCE + sep) && p !== ACCEPTANCE,
  );
  return scanned.length > 0 ? [REPO] : [];
}

let worldCache: World | null = null;

function world(): World {
  if (worldCache) return worldCache;

  const idovizirRaw = readIfExists(IDOVIZIR_PATH);
  const idovizirClean = idovizirRaw ? stripComments(idovizirRaw) : "";
  const idovizirBlocks = idovizirRaw ? parseBlocks(idovizirRaw, IDOVIZIR_PATH) : [];
  const interfaces = idovizirBlocks.filter((b) => b.kind === "interface");

  const foundryTomlRaw = readIfExists(FOUNDRY_TOML_PATH);
  const armRoots = discoverArmRoots(foundryTomlRaw);

  const armFileSet = new Set<string>();
  for (const root of armRoots) {
    for (const f of walkSol(root)) {
      if (f.startsWith(ACCEPTANCE + sep)) continue;
      armFileSet.add(f);
    }
  }
  if (existsSync(DEPLOYER_PATH)) armFileSet.add(DEPLOYER_PATH);
  const armFiles = [...armFileSet].sort();

  const armSources = armFiles.map((file) => {
    const raw = readFileSync(file, "utf8");
    return { file, raw, clean: stripComments(raw) };
  });
  const armBlocks = armSources.flatMap((s) => parseBlocks(s.raw, s.file));

  const deployerRaw = readIfExists(DEPLOYER_PATH);
  const deployerBlock =
    (deployerRaw ? parseBlocks(deployerRaw, DEPLOYER_PATH) : []).find(
      (b) => b.name === "ArmBDeployer",
    ) ?? null;

  const blockByName = new Map<string, SolBlock>();
  for (const b of [...idovizirBlocks, ...armBlocks]) {
    if (!blockByName.has(b.name)) blockByName.set(b.name, b);
  }

  worldCache = {
    idovizirRaw,
    interfaces,
    declaredEvents: [...new Set(matchAllNames(idovizirClean, EVENT_RE))],
    declaredErrors: [...new Set(matchAllNames(idovizirClean, ERROR_RE))],
    transcriptLibRaw: readIfExists(TRANSCRIPT_LIB_PATH),
    authLibRaw: readIfExists(AUTH_LIB_PATH),
    readmeRaw: readIfExists(README_PATH),
    foundryTomlRaw,
    armRoots,
    armFiles,
    armSources,
    armBlocks,
    deployerRaw,
    deployerBlock,
    acceptanceSolFiles: walkSol(ACCEPTANCE),
    blockByName,
  };
  return worldCache;
}

function transitiveBases(name: string, seen: Set<string> = new Set()): Set<string> {
  const out = new Set<string>();
  const b = world().blockByName.get(name);
  if (!b) return out;
  for (const base of b.bases) {
    if (seen.has(base)) continue;
    seen.add(base);
    out.add(base);
    for (const t of transitiveBases(base, seen)) out.add(t);
  }
  return out;
}

function concreteImplementorsOf(ifaceName: string): SolBlock[] {
  return world().armBlocks.filter(
    (b) =>
      b.kind === "contract" &&
      b.name !== "ArmBDeployer" &&
      (b.bases.includes(ifaceName) || transitiveBases(b.name).has(ifaceName)),
  );
}

/** Function names callable on a contract: own + arm-tree bases + public getters. */
function callableNames(contractName: string, seen: Set<string> = new Set()): Set<string> {
  const out = new Set<string>();
  if (seen.has(contractName)) return out;
  seen.add(contractName);
  const b = world().blockByName.get(contractName);
  if (!b || b.kind === "interface") return out;
  for (const n of matchAllNames(b.body, FUNCTION_RE)) out.add(n);
  for (const n of matchAllNames(b.body, PUBLIC_VAR_RE)) out.add(n);
  for (const base of b.bases) {
    for (const n of callableNames(base, seen)) out.add(n);
  }
  return out;
}

function interfaceFunctionNames(iface: SolBlock): string[] {
  return [...new Set(matchAllNames(iface.body, FUNCTION_RE))];
}

function expectedConcreteNameFor(ifaceName: string): string {
  return ifaceName.replace(/^I/, "");
}

function armSourceText(includeDeployer: boolean): string {
  return world()
    .armSources.filter((s) => includeDeployer || s.file !== DEPLOYER_PATH)
    .map((s) => s.clean)
    .join("\n");
}

// ---------------------------------------------------------------------------

describe("story-002 — Arm B against the frozen Dovizir acceptance suite", () => {
  describe("preconditions (frozen surfaces are present)", () => {
    it("the frozen interface, libraries, README and foundry.toml all exist under packages/acceptance/", () => {
      const w = world();
      expect(w.idovizirRaw, `missing ${IDOVIZIR_PATH}`).not.toBeNull();
      expect(w.transcriptLibRaw, `missing ${TRANSCRIPT_LIB_PATH}`).not.toBeNull();
      expect(w.authLibRaw, `missing ${AUTH_LIB_PATH}`).not.toBeNull();
      expect(w.readmeRaw, `missing ${README_PATH}`).not.toBeNull();
      expect(w.foundryTomlRaw, `missing ${FOUNDRY_TOML_PATH}`).not.toBeNull();
    });
  });

  describe("acceptance scenarios", () => {
    it("Given branch arm-b/m1 with all six contracts and ArmBDeployer implemented, When DOVIZIR_DEPLOYER selects Arm B and forge test runs the suite with zero suite edits, Then the run is wired to succeed (static preconditions for exit 0)", () => {
      const w = world();

      // The plug-in file exists at the documented location.
      expect(w.deployerRaw, `missing ${DEPLOYER_PATH}`).not.toBeNull();
      expect(w.deployerBlock, "ArmBDeployer contract not declared").not.toBeNull();

      // The DOVIZIR_DEPLOYER indirection is the documented selection mechanism.
      expect(w.readmeRaw ?? "").toContain("DOVIZIR_DEPLOYER");

      // foundry.toml carries an additive remapping resolving outside the
      // acceptance package, i.e. at the Arm B source tree.
      expect(w.armRoots.length, "no Arm B source root resolvable").toBeGreaterThan(0);
      expect(w.armFiles.length, "no Arm B .sol sources found").toBeGreaterThan(0);

      // Every frozen interface has a concrete Arm B implementor, so the suite
      // can at minimum construct and cast every address it is handed.
      for (const iface of w.interfaces) {
        expect(
          concreteImplementorsOf(iface.name).length,
          `no concrete Arm B contract declares \`is ${iface.name}\``,
        ).toBe(1);
      }
    });

    it("Given the story is complete, When git diff is taken over packages/acceptance/ against the pre-story state, Then the only changes are appended remapping lines in foundry.toml and the added file src/arm/ArmBDeployer.sol", () => {
      const changed = changedUnderAcceptance();

      if (changed !== null) {
        const unexpected = changed.filter(
          (p) => p !== FOUNDRY_TOML_REL && p !== DEPLOYER_REL,
        );
        expect(
          unexpected,
          `packages/acceptance/ changed outside the two permitted paths: ${unexpected.join(", ")}`,
        ).toEqual([]);
        return;
      }

      // No git history available — assert the structural equivalent: the arm
      // plug-in is the ONLY Arm-B-aware artifact inside the acceptance package.
      const w = world();
      const armDirEntries = existsSync(ARM_DIR)
        ? readdirSync(ARM_DIR).filter((n) => !n.startsWith("."))
        : [];
      expect(armDirEntries).toEqual(["ArmBDeployer.sol"]);

      const leaking = w.acceptanceSolFiles.filter(
        (f) => f !== DEPLOYER_PATH && /arm[-_ ]?b/i.test(readFileSync(f, "utf8")),
      );
      expect(
        leaking.map((f) => relative(REPO, f)),
        "frozen acceptance sources must not reference Arm B",
      ).toEqual([]);
    });

    it("Given a test process that calls the Arm B deployer twice, When both invocations complete, Then the two returned address sets are disjoint (deployer holds no cross-invocation state and constructs fresh instances)", () => {
      const w = world();
      expect(w.deployerBlock, "ArmBDeployer contract not declared").not.toBeNull();
      const block = w.deployerBlock as SolBlock;

      // Fresh instances per invocation: each of the six concrete contracts is
      // constructed with `new` inside the deployer.
      for (const iface of w.interfaces) {
        const impls = concreteImplementorsOf(iface.name);
        const name = impls[0]?.name ?? expectedConcreteNameFor(iface.name);
        expect(
          new RegExp(`\\bnew\\s+${name}\\s*[({]`).test(block.body),
          `ArmBDeployer must construct a fresh ${name} per invocation (\`new ${name}(...)\`)`,
        ).toBe(true);
      }

      // No cross-invocation state: every state variable is constant/immutable.
      const mutable = stateVariableDeclarations(block.body).filter(
        (s) => !/\b(constant|immutable)\b/.test(s),
      );
      expect(
        mutable,
        `ArmBDeployer must hold no mutable storage; found: ${mutable.join(" | ")}`,
      ).toEqual([]);
    });

    it("Given each address returned by the Arm B deployer, When the suite casts it to its declared interface and calls each function, Then every declared function is implemented (no selector-not-found)", () => {
      const w = world();
      const missing: string[] = [];
      for (const iface of w.interfaces) {
        const impls = concreteImplementorsOf(iface.name);
        expect(
          impls.length,
          `expected exactly one concrete implementor of ${iface.name}, found ${impls.length}`,
        ).toBe(1);
        const impl = impls[0];
        const callable = callableNames(impl.name);
        for (const fn of interfaceFunctionNames(iface)) {
          if (!callable.has(fn)) missing.push(`${impl.name}.${fn} (from ${iface.name})`);
        }
      }
      expect(missing, `unimplemented interface functions: ${missing.join(", ")}`).toEqual(
        [],
      );
    });

    it("Given a caller holding none of the required roles, When an access-gated external function is called, Then it reverts with the exact custom error declared in IDovizir.sol (never a bare string revert)", () => {
      const w = world();
      expect(
        w.declaredErrors.length,
        "IDovizir.sol declares no custom errors to enforce",
      ).toBeGreaterThan(0);

      const armText = armSourceText(true);
      const reverted = new Set(matchAllNames(armText, REVERT_RE));
      const unused = w.declaredErrors.filter((e) => !reverted.has(e));
      expect(
        unused,
        `custom errors declared in IDovizir.sol but never reverted by Arm B: ${unused.join(", ")}`,
      ).toEqual([]);

      // Unauthorized paths must never surface as a bare require/revert string.
      const stringReverts = w.armSources.filter(
        (s) => /\brevert\s*\(\s*["']/.test(s.clean) || /\brequire\s*\([^;]*,\s*["']/.test(s.clean),
      );
      expect(
        stringReverts.map((s) => relative(REPO, s.file)),
        "Arm B must use interface-declared custom errors, not string reverts",
      ).toEqual([]);
    });

    it("Given identical inputs, When Arm B produces transcript bytes and TranscriptLib is invoked directly, Then the bytes are identical (Arm B calls TranscriptLib and never reimplements it)", () => {
      const w = world();
      const armText = armSourceText(false);

      expect(
        /\bTranscriptLib\s*\./.test(armText),
        "Arm B must obtain transcript bytes by calling TranscriptLib",
      ).toBe(true);

      const redeclared = w.armBlocks.filter((b) => b.name === "TranscriptLib");
      expect(
        redeclared.map((b) => relative(REPO, b.file)),
        "Arm B must not declare its own TranscriptLib",
      ).toEqual([]);

      const libFns = new Set(matchAllNames(stripComments(w.transcriptLibRaw ?? ""), FUNCTION_RE));
      const copies = w.armBlocks
        .filter((b) => b.kind === "library")
        .flatMap((b) =>
          matchAllNames(b.body, FUNCTION_RE)
            .filter((fn) => libFns.has(fn))
            .map((fn) => `${b.name}.${fn}`),
        );
      expect(
        copies,
        `Arm B libraries reimplement TranscriptLib functions: ${copies.join(", ")}`,
      ).toEqual([]);
    });

    it("Given identical inputs, When Arm B produces an auth payload/digest and AuthLib is invoked directly, Then the results are identical (Arm B calls AuthLib and never reimplements it)", () => {
      const w = world();
      const armText = armSourceText(false);

      expect(
        /\bAuthLib\s*\./.test(armText),
        "Arm B must obtain auth bytes/digests by calling AuthLib",
      ).toBe(true);

      const redeclared = w.armBlocks.filter((b) => b.name === "AuthLib");
      expect(
        redeclared.map((b) => relative(REPO, b.file)),
        "Arm B must not declare its own AuthLib",
      ).toEqual([]);

      const libFns = new Set(matchAllNames(stripComments(w.authLibRaw ?? ""), FUNCTION_RE));
      const copies = w.armBlocks
        .filter((b) => b.kind === "library")
        .flatMap((b) =>
          matchAllNames(b.body, FUNCTION_RE)
            .filter((fn) => libFns.has(fn))
            .map((fn) => `${b.name}.${fn}`),
        );
      expect(
        copies,
        `Arm B libraries reimplement AuthLib functions: ${copies.join(", ")}`,
      ).toEqual([]);
    });

    it("Given the implementer believes a frozen-suite assertion is wrong, When they act on that belief, Then the suite files remain byte-identical and the implementation follows the interface text", () => {
      const frozen = [IDOVIZIR_PATH, TRANSCRIPT_LIB_PATH, AUTH_LIB_PATH, README_PATH];
      const testDir = join(ACCEPTANCE, "test");
      const frozenAll = [...frozen, ...walkSol(testDir)];

      const drifted: string[] = [];
      let baselineAvailable = false;
      for (const p of frozenAll) {
        const rel = relative(REPO, p).split(sep).join("/");
        const base = baselineFile(rel);
        if (base === null) continue;
        baselineAvailable = true;
        if (base !== readFileSync(p, "utf8")) drifted.push(rel);
      }

      if (baselineAvailable) {
        expect(drifted, `frozen files were modified: ${drifted.join(", ")}`).toEqual([]);
        return;
      }

      // No git history: assert the frozen files at least still exist, are
      // non-empty, and carry no Arm-B-specific edits.
      for (const p of frozenAll) {
        const src = readIfExists(p);
        expect(src, `frozen file missing: ${relative(REPO, p)}`).not.toBeNull();
        expect((src ?? "").length).toBeGreaterThan(0);
        expect(
          /arm[-_ ]?b/i.test(src ?? "") && p !== README_PATH,
          `frozen file ${relative(REPO, p)} references Arm B`,
        ).toBe(false);
      }
    });
  });

  describe("invariants", () => {
    it("exactly six concrete contracts exist, one per IDovizir interface, each declaring `is I<Name>`", () => {
      const w = world();
      expect(w.interfaces.map((i) => i.name).length).toBe(EXPECTED_INTERFACE_COUNT);

      const implementors = new Map<string, string>();
      for (const iface of w.interfaces) {
        const impls = concreteImplementorsOf(iface.name);
        expect(
          impls.length,
          `${iface.name} must have exactly one concrete Arm B implementor, found ${impls.length}`,
        ).toBe(1);
        implementors.set(iface.name, impls[0].name);
        expect(
          impls[0].bases.includes(iface.name),
          `${impls[0].name} must declare \`is ${iface.name}\` directly`,
        ).toBe(true);
      }

      expect(new Set(implementors.values()).size).toBe(EXPECTED_INTERFACE_COUNT);
    });

    it("concrete contract names drop the leading `I` unless IDovizir.sol's adjudication comments name them otherwise", () => {
      const w = world();
      const comments = (w.idovizirRaw ?? "")
        .match(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g)
        ?.join("\n") ?? "";

      for (const iface of w.interfaces) {
        const impls = concreteImplementorsOf(iface.name);
        expect(impls.length, `no implementor for ${iface.name}`).toBe(1);
        const actual = impls[0].name;
        const conventional = expectedConcreteNameFor(iface.name);
        const namedByComment = wordRefRe(actual).test(comments);
        expect(
          actual === conventional || namedByComment,
          `${iface.name} implementor is named ${actual}; expected ${conventional} unless an adjudication comment names it otherwise`,
        ).toBe(true);
      }
    });

    it("changes to packages/acceptance/foundry.toml are strictly additive", () => {
      const w = world();
      const current = w.foundryTomlRaw ?? "";
      const base = baselineFile(FOUNDRY_TOML_REL);

      if (base !== null) {
        const currentLines = current.split("\n").map((l) => l.trimEnd());
        let cursor = 0;
        const dropped: string[] = [];
        for (const raw of base.split("\n")) {
          const line = raw.trimEnd();
          if (line.trim() === "") continue;
          const idx = currentLines.indexOf(line, cursor);
          if (idx === -1) dropped.push(line);
          else cursor = idx + 1;
        }
        expect(
          dropped,
          `pre-existing foundry.toml lines were removed or reordered: ${dropped.join(" | ")}`,
        ).toEqual([]);
        return;
      }

      // No baseline: assert the additive artifact itself is present — a
      // remapping target that resolves to the Arm B source tree.
      expect(current).toMatch(/remappings/);
      expect(w.armRoots.length, "no remapping resolves to an Arm B source tree").toBeGreaterThan(0);
    });

    it("ArmBDeployer conforms to the deployer plug-in shape and exposes all six deployed addresses to the caller", () => {
      const w = world();
      expect(w.deployerBlock, "ArmBDeployer contract not declared").not.toBeNull();
      const block = w.deployerBlock as SolBlock;

      const fns = matchAllNames(block.body, FUNCTION_RE);
      expect(fns.length, "ArmBDeployer declares no functions").toBeGreaterThan(0);

      // Addresses must be handed back — either as a returned tuple/struct of
      // addresses/interfaces, or via public getters.
      const exposesAddresses =
        /\breturns\s*\(/.test(block.body) || matchAllNames(block.body, PUBLIC_VAR_RE).length > 0;
      expect(
        exposesAddresses,
        "ArmBDeployer must expose the deployed addresses to the caller",
      ).toBe(true);

      // Per invocation it deploys all six.
      for (const iface of w.interfaces) {
        const impls = concreteImplementorsOf(iface.name);
        const name = impls[0]?.name ?? expectedConcreteNameFor(iface.name);
        expect(
          new RegExp(`\\bnew\\s+${name}\\s*[({]`).test(block.body),
          `ArmBDeployer must deploy ${name}`,
        ).toBe(true);
      }
    });

    it("ArmBDeployer performs deployment and wiring only — it declares no domain behaviour the suite could exercise as one of the six", () => {
      const w = world();
      expect(w.deployerBlock, "ArmBDeployer contract not declared").not.toBeNull();
      const block = w.deployerBlock as SolBlock;

      const ifaceNames = new Set(w.interfaces.map((i) => i.name));
      const inherited = [...block.bases, ...transitiveBases(block.name)];
      const domainBases = inherited.filter((b) => ifaceNames.has(b));
      expect(
        domainBases,
        `ArmBDeployer must not implement domain interfaces: ${domainBases.join(", ")}`,
      ).toEqual([]);

      const domainFns = new Set(w.interfaces.flatMap((i) => interfaceFunctionNames(i)));
      const overlap = matchAllNames(block.body, FUNCTION_RE).filter((fn) => domainFns.has(fn));
      expect(
        overlap,
        `ArmBDeployer declares domain functions: ${overlap.join(", ")}`,
      ).toEqual([]);
    });

    it("Arm B emits exactly the events declared in IDovizir.sol and introduces no additional events", () => {
      const w = world();
      const declared = new Set(w.declaredEvents);
      const armText = armSourceText(true);

      const armDeclared = [...new Set(matchAllNames(armText, EVENT_RE))].filter(
        (e) => !declared.has(e),
      );
      expect(
        armDeclared,
        `Arm B declares events not present in IDovizir.sol: ${armDeclared.join(", ")}`,
      ).toEqual([]);

      const emitted = [...new Set(matchAllNames(armText, EMIT_RE))].filter(
        (e) => !declared.has(e),
      );
      expect(
        emitted,
        `Arm B emits events not declared in IDovizir.sol: ${emitted.join(", ")}`,
      ).toEqual([]);
    });

    it("Arm B sources declare a Solidity pragma identical to the frozen interface's, so suite and arm compile under one forge invocation", () => {
      const w = world();
      const suitePragmas = pragmaLines(w.idovizirRaw ?? "");
      expect(suitePragmas.length, "IDovizir.sol declares no pragma").toBeGreaterThan(0);
      const expected = suitePragmas[0];

      const offenders: string[] = [];
      for (const s of w.armSources) {
        const p = pragmaLines(s.raw);
        if (p.length === 0 || p[0] !== expected) {
          offenders.push(`${relative(REPO, s.file)} -> ${p[0] ?? "<none>"}`);
        }
      }
      expect(
        offenders,
        `Arm B pragma must be \`pragma solidity ${expected};\` — offenders: ${offenders.join(", ")}`,
      ).toEqual([]);
    });

    it("the suite stays arm-agnostic — no acceptance source references Arm B except through the DOVIZIR_DEPLOYER indirection", () => {
      const w = world();
      const armNames = new Set<string>(["ArmBDeployer"]);
      for (const iface of w.interfaces) {
        for (const impl of concreteImplementorsOf(iface.name)) armNames.add(impl.name);
      }

      const violations: string[] = [];
      for (const file of w.acceptanceSolFiles) {
        if (file === DEPLOYER_PATH) continue;
        const src = stripComments(readFileSync(file, "utf8"));
        for (const name of armNames) {
          if (wordRefRe(name).test(src)) {
            violations.push(`${relative(REPO, file)} references ${name}`);
          }
        }
      }
      expect(
        violations,
        `the frozen suite must not name Arm B contracts: ${violations.join("; ")}`,
      ).toEqual([]);
    });
  });
});
