import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// deploy/install.sh pins the minimum Node it installs; pnpm refuses to install when the root
// `engines.node` is not satisfied, so a drift between the two breaks a fresh reference deployment.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const engines = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).engines.node;
const install = readFileSync(join(root, "deploy", "install.sh"), "utf8");

test("install.sh NODE_MIN matches the root engines.node minimum", () => {
  const min = /^\^(\d+\.\d+\.\d+)$/.exec(engines)?.[1];
  assert.ok(min, `expected engines.node of the form ^X.Y.Z, got ${engines}`);
  assert.match(install, new RegExp(`^NODE_MIN="${min.replaceAll(".", "\\.")}"$`, "m"));
});
