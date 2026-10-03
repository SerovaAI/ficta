import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

// Exercises the sourced helpers deploy/install.sh uses to create and preflight the reference
// deployment's surrogate key. Runs as the current user, which stands in for the `ficta` service user.
const helpers = join(dirname(fileURLToPath(import.meta.url)), "..", "deploy", "surrogate-key.sh");
const owner = userInfo().username;
const group = spawnSync("id", ["-gn"], { encoding: "utf8" }).stdout.trim();
const posix = process.platform !== "win32";

let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "ficta-deploy-key-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

function run(fn, file, user = owner) {
  const script = `. "$1"; ${fn} "$2" "$3" "$4"`;
  return spawnSync("bash", ["-c", script, "bash", helpers, file, user, group], { encoding: "utf8" });
}

function fresh(name) {
  const sub = join(dir, name);
  mkdirSync(sub);
  return join(sub, "surrogate.key");
}

test("creates a 64-hex key, mode 0600, without printing it", { skip: !posix }, () => {
  const file = fresh("create");
  const r = run("surrogate_key_ensure", file);
  assert.equal(r.status, 0, r.stderr);
  const key = readFileSync(file, "utf8").trim();
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(!r.stdout.includes(key) && !r.stderr.includes(key), "key must never be printed");
  assert.equal(run("surrogate_key_check", file).status, 0);
});

test("is idempotent: never regenerates or overwrites an existing key", { skip: !posix }, () => {
  const file = fresh("idempotent");
  assert.equal(run("surrogate_key_ensure", file).status, 0);
  const first = readFileSync(file, "utf8");
  assert.equal(run("surrogate_key_ensure", file).status, 0);
  assert.equal(readFileSync(file, "utf8"), first);
});

test("keeps an existing key's content but tightens its mode", { skip: !posix }, () => {
  const file = fresh("tighten");
  assert.equal(run("surrogate_key_ensure", file).status, 0);
  const first = readFileSync(file, "utf8");
  chmodSync(file, 0o644);
  assert.notEqual(run("surrogate_key_check", file).status, 0);
  assert.equal(run("surrogate_key_ensure", file).status, 0);
  assert.equal(readFileSync(file, "utf8"), first);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("refuses to follow a symlink", { skip: !posix }, () => {
  const file = fresh("symlink");
  const target = join(dirname(file), "elsewhere");
  writeFileSync(target, "", { mode: 0o600 });
  symlinkSync(target, file);
  assert.notEqual(run("surrogate_key_ensure", file).status, 0);
  assert.equal(readFileSync(target, "utf8"), "");
  assert.match(run("surrogate_key_check", file).stderr, /not a regular file/);
});

test("preflight reports a missing, badly-permissioned, or malformed key", { skip: !posix }, () => {
  const file = fresh("check");
  assert.match(run("surrogate_key_check", file).stderr, /is missing/);

  writeFileSync(file, "not-a-key\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  assert.match(run("surrogate_key_check", file).stderr, /exactly 64 hex characters/);

  assert.equal(run("surrogate_key_ensure", file).status, 0); // existing file: content left alone
  assert.equal(readFileSync(file, "utf8"), "not-a-key\n");

  rmSync(file);
  assert.equal(run("surrogate_key_ensure", file).status, 0);
  chmodSync(file, 0o640);
  assert.match(run("surrogate_key_check", file).stderr, /accessible by group\/others/);
});

test("preflight reports a key not owned by the service user", { skip: !posix || owner === "root" }, () => {
  const file = fresh("owner");
  assert.equal(run("surrogate_key_ensure", file).status, 0);
  assert.match(run("surrogate_key_check", file, "root").stderr, /not owned by root/);
});
