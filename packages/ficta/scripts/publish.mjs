#!/usr/bin/env node
/** Publish the ficta npm packages, idempotently. */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const dryRun = process.argv.includes("--dry-run");
const KNOWN_FLAGS = new Set(["--dry-run"]);
const unknownArgs = process.argv.slice(2).filter((arg) => !KNOWN_FLAGS.has(arg));
if (unknownArgs.length > 0) {
  console.error("Usage: node scripts/publish.mjs [--dry-run]");
  process.exit(1);
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const packageDir = process.cwd();
const protocolDir = resolve(packageDir, "../protocol");
const protocolPkg = JSON.parse(readFileSync(resolve(protocolDir, "package.json"), "utf8"));
const name = String(pkg.name);
const version = String(pkg.version);
const protocolName = String(protocolPkg.name);
const protocolVersion = String(protocolPkg.version);
const expectedTag = process.env.RELEASE_TAG;
const distTag = npmDistTag(version);

assertPackageMetadata();
assertProtocolMetadata();
assertTagMatchesVersion(expectedTag, version);
assertChangelogHasVersion(version);
assertBuildOutputExists();

console.log(
  `Publishing ${protocolName}@${protocolVersion} and ${name}@${version} with dist-tag ${distTag}${dryRun ? " (dry run)" : ""}\n`,
);

if (dryRun) {
  validatePackage(protocolName, protocolVersion, protocolDir);
  validatePackage(name, version, packageDir);
  process.exit(0);
}

publishPackage(protocolName, protocolVersion, protocolDir, distTag);
publishPackage(name, version, packageDir, distTag);

function commandForPlatform(command) {
  return process.platform === "win32" ? `${command}.cmd` : command;
}

function run(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(commandForPlatform(command), args, {
    encoding: "utf8",
    cwd: options.cwd,
    stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit",
  });

  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(
      output
        ? `Command failed: ${command} ${args.join(" ")}\n${output}`
        : `Command failed: ${command} ${args.join(" ")}`,
    );
  }

  return result;
}

function assertPackageMetadata() {
  if (name !== "@serovaai/ficta") throw new Error(`package.json has name ${name}, expected @serovaai/ficta`);
  if (pkg.private) throw new Error("package.json private=true; refusing to publish");
  if (pkg.dependencies?.["@serovaai/ficta-protocol"] !== "workspace:^") {
    throw new Error(
      `@serovaai/ficta dependency on @serovaai/ficta-protocol must be workspace:^, got ${pkg.dependencies?.["@serovaai/ficta-protocol"]}`,
    );
  }
}

function assertProtocolMetadata() {
  if (protocolName !== "@serovaai/ficta-protocol") {
    throw new Error(`protocol package.json has name ${protocolName}, expected @serovaai/ficta-protocol`);
  }
  if (protocolPkg.private) throw new Error("protocol package.json private=true; refusing to publish");
  if (protocolVersion !== version) {
    throw new Error(`protocol package version ${protocolVersion} must match @serovaai/ficta version ${version}`);
  }
}

function assertTagMatchesVersion(tag, packageVersion) {
  if (!tag) return;
  const normalized = tag.startsWith("v") ? tag.slice(1) : tag;
  if (normalized !== packageVersion)
    throw new Error(`release tag ${tag} does not match package.json version ${packageVersion}`);
}

function assertChangelogHasVersion(packageVersion) {
  const changelog = readFileSync("CHANGELOG.md", "utf8");
  const heading = new RegExp(`^##\\s+${escapeRegExp(packageVersion)}(?:\\s+-\\s+\\d{4}-\\d{2}-\\d{2})?\\s*$`, "m");
  if (!heading.test(changelog)) throw new Error(`CHANGELOG.md has no section for ${packageVersion}`);
}

function assertBuildOutputExists() {
  if (!existsSync("dist")) throw new Error("dist does not exist. Run pnpm build before publishing.");
}

function validatePackage(packageName, packageVersion, cwd) {
  const published = isPublished(packageName, packageVersion);
  console.log(
    published
      ? `${packageName}@${packageVersion} is already published; validating package contents only.`
      : `${packageName}@${packageVersion} is not published; validating package contents before publish.`,
  );
  validatePack(cwd);
}

function publishPackage(packageName, packageVersion, cwd, tag) {
  const published = isPublished(packageName, packageVersion);
  if (published) {
    console.log(`Skipping publish for ${packageName}@${packageVersion}: already published`);
    return;
  }
  run("pnpm", ["publish", "--access", "public", "--provenance", "--ignore-scripts", "--no-git-checks", "--tag", tag], {
    cwd,
  });
}

function validatePack(cwd) {
  const result = run("pnpm", ["pack", "--dry-run", "--json"], { capture: true, cwd });
  const parsed = JSON.parse(result.stdout);
  const packed = Array.isArray(parsed) ? parsed[0] : parsed;
  const size = packed.size === undefined ? "" : `, ${packed.size} bytes packed`;
  const unpacked = packed.unpackedSize === undefined ? "" : `, ${packed.unpackedSize} bytes unpacked`;
  console.log(`  ${packed.filename}: ${packed.files.length} files${size}${unpacked}`);
}

function isPublished(packageName, packageVersion) {
  const result = spawnSync(
    commandForPlatform("npm"),
    ["view", `${packageName}@${packageVersion}`, "version", "--json"],
    {
      encoding: "utf8",
      stdio: ["inherit", "pipe", "pipe"],
    },
  );

  if (result.status === 0 && result.stdout.trim()) return true;

  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (result.status !== 0 && (output.includes("E404") || output.includes("404 Not Found"))) return false;

  throw new Error(
    output
      ? `Failed to query ${packageName}@${packageVersion}\n${output}`
      : `Failed to query ${packageName}@${packageVersion}`,
  );
}

function npmDistTag(packageVersion) {
  const prerelease = /^\d+\.\d+\.\d+-([0-9A-Za-z.-]+)$/.exec(packageVersion)?.[1];
  return prerelease ? (prerelease.split(".")[0] ?? "next") : "latest";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
