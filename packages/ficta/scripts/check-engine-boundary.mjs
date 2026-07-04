#!/usr/bin/env node
// Engine boundary check.
//
// The redaction engine (`src/engine/`) is a sealed module: it may import only its own files and
// Node built-ins. It must never reach into the CLI, proxy, config, logger, or agent-launch layers
// (the product side), nor pull in product npm deps (hono, pino, @clack, …). Keeping that boundary
// one-directional is what lets the engine be audited and reused (e.g. a future browser extension)
// independently of the ficta CLI/proxy — see docs/product-architecture (private notes).
//
// This is the enforcement that makes the sealed subtree non-regressing: a future edit that adds
// `import { log } from "../logger.js"` to an engine file fails here (and in CI via `check`).

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const engineDir = resolve(here, "..", "src", "engine");

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

const files = walk(engineDir);
const violations = [];

for (const file of files) {
  const source = readFileSync(file, "utf8");
  specifierRe.lastIndex = 0;
  let match = specifierRe.exec(source);
  while (match !== null) {
    const spec = match[1] ?? match[2];
    match = specifierRe.exec(source);
    if (!spec) continue;
    if (spec.startsWith("node:")) continue; // Node built-ins are allowed.
    if (spec.startsWith(".")) {
      const target = resolve(dirname(file), spec);
      const rel = relative(engineDir, target);
      if (rel === "" || rel.startsWith("..")) {
        violations.push({ file, spec, reason: "relative import escapes src/engine/" });
      }
      continue;
    }
    // A bare, non-`node:` specifier is a product/npm dependency the engine must not reach for.
    violations.push({ file, spec, reason: "non-node bare import (product/npm dependency)" });
  }
}

if (violations.length > 0) {
  console.error("✗ engine boundary violated — src/engine/ may import only itself + node: builtins:");
  for (const v of violations) {
    console.error(`  ${relative(process.cwd(), v.file)}  →  "${v.spec}"  (${v.reason})`);
  }
  process.exit(1);
}

console.log(`✓ engine boundary clean — ${files.length} files scanned, no imports escape src/engine/`);
