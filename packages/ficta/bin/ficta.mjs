#!/usr/bin/env node
// Published packages run the compiled CLI from dist/.
// Source checkouts keep using tsx so locally installed shims do not require a build step; the
// `development` condition resolves workspace packages (@serovaai/ficta-engine) to their sources too.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcCli = join(root, "src", "cli.ts");
const distCli = join(root, "dist", "cli.js");

if (existsSync(srcCli)) {
  const tsxBin = process.platform === "win32" ? "tsx.cmd" : "tsx";
  const tsx = join(root, "node_modules", ".bin", tsxBin);
  const child = spawn(tsx, ["--conditions=development", srcCli, ...process.argv.slice(2)], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", (error) => {
    process.stderr.write(`ficta: ${error.message}\n`);
    process.exit(1);
  });
} else {
  await import(pathToFileURL(distCli).href);
}
