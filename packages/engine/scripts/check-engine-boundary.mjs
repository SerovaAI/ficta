#!/usr/bin/env node
// Engine boundary check for @serovaai/ficta-engine.
//
// The redaction engine (this package's `src/`) is sealed: it may import only its own files and Node
// built-ins. It has no npm dependencies and must never reach into the ficta CLI/proxy (or any other
// workspace package), nor pull in product deps (hono, pino, @clack, …). Keeping that boundary
// one-directional is what lets the engine be audited and embedded in other hosts independently of
// the ficta CLI/proxy.
//
// The engine also never reads the process environment. Its settings arrive as an `EngineConfig`
// passed to each engine instance, so several engines in one process can run with different config.
// Turning env vars into that config is the host's job (ficta does it in
// `packages/ficta/src/engine-env.ts`), so no engine file is exempt from this rule.
//
// This is the enforcement that makes the sealed package non-regressing: a future edit that adds
// `import { log } from "../../ficta/src/logger.js"` or reads `process.env.FICTA_X` in an engine file
// fails here (and in CI via `check`).

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const engineDir = resolve(here, "..", "src");
// The `@serovaai/ficta-engine/sqlite` subpath: the only file that may import node:sqlite (Node >= 22.13),
// and one nothing else imports, so the main entry stays loadable on Node 20.
const sqliteEntry = join(engineDir, "sqlite.ts");

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

// Static `import … from "x"` / `export … from "x"` and dynamic `import("x")` specifiers.
const specifierRe = /(?:import|export)\b[^'"]*?\bfrom\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

// `process.env`, `process?.env`, `process["env"]`, and `const { env } = process`. Comments are
// stripped first so prose that mentions process.env does not trip it.
const envAccessRe = /\bprocess\s*(?:\??\.\s*env\b|\[\s*["'`]env["'`]\s*\])|\{[^}]*\benv\b[^}]*\}\s*=\s*process\b/;

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

const files = walk(engineDir);
const violations = [];

for (const file of files) {
  const source = readFileSync(file, "utf8");
  for (const line of stripComments(source).split("\n")) {
    if (envAccessRe.test(line)) {
      violations.push({ file, spec: line.trim(), reason: "reads process.env; take the setting from EngineConfig" });
    }
  }
  specifierRe.lastIndex = 0;
  let match = specifierRe.exec(source);
  while (match !== null) {
    const spec = match[1] ?? match[2];
    match = specifierRe.exec(source);
    if (!spec) continue;
    if (spec === "node:sqlite" && file !== sqliteEntry) {
      violations.push({ file, spec, reason: "node:sqlite is imported only by the ./sqlite subpath entry" });
      continue;
    }
    if (spec.startsWith("node:")) continue; // Node built-ins are allowed.
    if (spec.startsWith(".")) {
      const target = resolve(dirname(file), spec);
      const rel = relative(engineDir, target);
      if (rel === "" || rel.startsWith("..")) {
        violations.push({ file, spec, reason: "relative import escapes the engine package's src/" });
      } else if (target.replace(/\.js$/, ".ts") === sqliteEntry) {
        violations.push({ file, spec, reason: "the ./sqlite subpath entry must not be imported by the main engine" });
      }
      continue;
    }
    // A bare, non-`node:` specifier is a product/npm dependency the engine must not reach for.
    violations.push({ file, spec, reason: "non-node bare import (product/npm dependency)" });
  }
}

if (violations.length > 0) {
  console.error(
    "✗ engine boundary violated — the engine's src/ may import only itself + node: builtins, and never read process.env:",
  );
  for (const v of violations) {
    console.error(`  ${relative(process.cwd(), v.file)}  →  "${v.spec}"  (${v.reason})`);
  }
  process.exit(1);
}

console.log(`✓ engine boundary clean — ${files.length} files scanned, no imports escape src/, no process.env reads`);
