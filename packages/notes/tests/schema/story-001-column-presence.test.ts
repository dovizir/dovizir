// slowcook 0.12.10 column-presence assertion — story-001
//
// Auto-emitted by testgen on every spec — scans the whole repo for
// .from('t').select('c1, c2, ...') calls and asserts every column
// referenced exists in supabase/migrations/ (CREATE TABLE body or
// ALTER TABLE ADD COLUMN). Closes slowcook#7 — catches code-ahead-
// of-schema bugs like rewo PR #74's author_id reference (no migration).

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

describe("story-001 column presence (code → schema)", () => {
  it("every literal .from(t).select(...) column reference exists in supabase/migrations/", () => {
    const migrationsDir = "supabase/migrations";
    const sql = existsSync(migrationsDir)
      ? readdirSync(migrationsDir)
          .filter((f) => f.endsWith(".sql"))
          .sort()
          .map((f) => readFileSync(join(migrationsDir, f), "utf8"))
          .join("\n")
      : "";

    function escapeRe(s: string): string {
      return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    function isColumnInSchema(table: string, column: string): boolean {
      const t = escapeRe(table);
      const c = escapeRe(column);
      // 1. CREATE TABLE table ( ... column ... )
      const createRe = new RegExp(
        `create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?[\"\`]?(?:public\\.)?${t}[\"\`]?\\s*\\(([\\s\\S]*?)\\)\\s*;`,
        "i"
      );
      const m = sql.match(createRe);
      if (m) {
        // Look for column at the start of a line/segment within the body.
        const colRe = new RegExp(
          `(?:^|,|\\n)\\s*[\"\`]?${c}[\"\`]?\\s+`,
          "i"
        );
        if (colRe.test(m[1])) return true;
      }
      // 2. ALTER TABLE — multi-column form supported (0.12.11 fix):
      //   alter table foo add column a int, add column b text;
      // First find every `alter table <t> ... ;` statement, then
      // check whether the add-column clause for our column appears
      // anywhere in the statement body.
      const alterStmtRe = new RegExp(
        `alter\\s+table\\s+(?:only\\s+)?[\"\`]?(?:public\\.)?${t}[\"\`]?\\s+([\\s\\S]*?);`,
        "gi"
      );
      const addRe = new RegExp(
        `add\\s+column\\s+(?:if\\s+not\\s+exists\\s+)?[\"\`]?${c}\\b`,
        "i"
      );
      let stmt;
      while ((stmt = alterStmtRe.exec(sql)) !== null) {
        if (addRe.test(stmt[1])) return true;
      }
      return false;
    }

    function parseSelectColumns(colsStr: string): string[] {
      // Split on top-level commas (paren-aware so relation subselects
      // like `member:profiles!member_id(id, name)` aren't shredded).
      const cols: string[] = [];
      let depth = 0;
      let buf = "";
      for (const ch of colsStr) {
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        if (ch === "," && depth === 0) {
          if (buf.trim()) cols.push(buf.trim());
          buf = "";
        } else {
          buf += ch;
        }
      }
      if (buf.trim()) cols.push(buf.trim());
      return cols;
    }

    function isPlainColumn(col: string): boolean {
      // Skip relation sub-selects (contain ':') and aggregates (contain '(').
      return !col.includes(":") && !col.includes("(");
    }

    function bareColumnName(col: string): string {
      // Strip aliases like "old_name as new_name" (Supabase rare) and
      // any trailing modifiers. Take the first identifier.
      const match = col.trim().match(/^[\"\`]?([A-Za-z_][A-Za-z0-9_]*)[\"\`]?/);
      return match ? match[1] : col.trim();
    }

    function walkSrc(dir: string, out: string[]): void {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walkSrc(full, out);
        } else if (/\.(tsx?|jsx?)$/.test(full)) {
          out.push(full);
        }
      }
    }

    const srcFiles: string[] = [];
    walkSrc("src", srcFiles);

    // Match .from("table").select("cols") — both quoted forms.
    // Backticks accepted; if the inner text contains ${} we skip
    // (computed). Whitespace-flexible.
    const callRe = /\.from\(\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\)\s*\.select\(\s*[`"']([^`"']+)["'`]/g;

    const missing: string[] = [];
    const knownTables = new Set<string>();
    // Pre-pass: any table with a CREATE TABLE in migrations is "known."
    // Tables we don't recognize (views, RPC results) are skipped to
    // avoid false positives.
    const tableDeclRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?["`]?(?:public\.)?([A-Za-z_][A-Za-z0-9_]*)["`]?/gi;
    let tm: RegExpExecArray | null;
    while ((tm = tableDeclRe.exec(sql)) !== null) {
      knownTables.add(tm[1].toLowerCase());
    }

    for (const file of srcFiles) {
      const src = readFileSync(file, "utf8");
      let m: RegExpExecArray | null;
      callRe.lastIndex = 0;
      while ((m = callRe.exec(src)) !== null) {
        const table = m[1];
        if (!knownTables.has(table.toLowerCase())) continue;
        const colsStr = m[2];
        if (colsStr.trim() === "*") continue;
        if (colsStr.includes("${")) continue; // computed — skip
        const cols = parseSelectColumns(colsStr).filter(isPlainColumn).map(bareColumnName);
        for (const col of cols) {
          if (!col) continue;
          if (!isColumnInSchema(table, col)) {
            missing.push(`${file}: ${table}.${col}`);
          }
        }
      }
    }

    expect(
      missing,
      `Selected columns with no matching CREATE/ALTER TABLE in supabase/migrations/:\n  ` +
        missing.join("\n  ")
    ).toEqual([]);
  });
});
