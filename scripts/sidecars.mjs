#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const presidioFile = resolve(root, "packages/ficta/presidio/Dockerfile");
const converterFile = resolve(root, "apps/gateway/sidecars/document-converter/Dockerfile");
const composeFile = resolve(root, "docker-compose.sidecars.yml");
const devFile = resolve(root, "scripts/dev-runner.mjs");
const docsFile = resolve(root, "packages/ficta/docs/plugins.md");
const compose = ["compose", "-f", "docker-compose.sidecars.yml"];

function docker(args, { allowMissing = false, inherit = false, environment = {} } = {}) {
  const result = spawnSync("docker", args, {
    cwd: root,
    env: { ...process.env, ...environment },
    encoding: "utf8",
    stdio: inherit ? "inherit" : "pipe",
    timeout: inherit ? undefined : 60_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (allowMissing && /No such image/i.test(result.stderr ?? "")) return undefined;
    throw new Error(`docker ${args.join(" ")} failed: ${result.stderr?.trim() || result.status}`);
  }
  return result.stdout?.trim();
}

export function parseArgs(args) {
  const filtered = args.filter((arg) => arg !== "--");
  const [action, ...flags] = filtered;
  if (
    !["check", "update"].includes(action) ||
    flags.some(
      (flag) =>
        flag !== "--openmed" &&
        !(action === "check" && flag === "--advisory") &&
        !(action === "update" && flag === "--force"),
    )
  ) {
    throw new Error("Usage: pnpm sidecars:check [--openmed] [--advisory] | pnpm sidecars:update [--openmed] [--force]");
  }
  return {
    action,
    openmed: flags.includes("--openmed"),
    advisory: flags.includes("--advisory"),
    force: flags.includes("--force"),
  };
}

export function remoteDigest(output) {
  const digest = output.match(/^Digest:\s+(sha256:[a-f0-9]{64})\s*$/m)?.[1];
  if (!digest) throw new Error("Registry response did not contain an image digest");
  return digest;
}

export function releaseTag(release) {
  if (release.draft || release.prerelease || !/^v?\d+\.\d+\.\d+$/.test(release.tag_name ?? "")) {
    throw new Error("Upstream did not return a stable version tag");
  }
  return release.tag_name;
}

async function latestRelease(repository) {
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Release lookup for ${repository} failed: HTTP ${response.status}`);
  return releaseTag(await response.json());
}

const fingerprintLabel = "ai.serova.ficta.sidecar-inputs";
const baseDigestLabel = "ai.serova.ficta.sidecar-base-digest";

export function sourceFingerprint(context, base, build, replacements = []) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ base, build }));
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "__pycache__" || entry.name.endsWith(".pyc")) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else {
        let content = readFileSync(path);
        if (entry.name === "Dockerfile") {
          let source = content.toString("utf8");
          for (const [before, after] of replacements) source = source.replace(before, after);
          content = Buffer.from(source);
        }
        hash.update(JSON.stringify([relative(context, path), content.length]));
        hash.update(content);
      }
    }
  }
  visit(context);
  return hash.digest("hex");
}

export async function runSidecars(
  { action, openmed, force = false },
  {
    run = docker,
    release = latestRelease,
    fingerprint = sourceFingerprint,
    read = (path) => readFileSync(path, "utf8"),
    write = (path, content) => writeFileSync(path, content),
    log = console.log,
  } = {},
) {
  const presidioSource = read(presidioFile);
  const pinned = presidioSource.match(/^ARG PRESIDIO_ANALYZER_IMAGE=(\S+)$/m)?.[1];
  if (!pinned?.includes("@sha256:")) throw new Error("Expected a digest-pinned Presidio base image");
  const repository = pinned.split("@")[0].replace(/:[^/:]+$/, "");
  const presidioTag = releaseTag({ tag_name: await release("data-privacy-stack/presidio") });
  const pythonImage = read(converterFile).match(/^FROM (\S+)$/m)?.[1];
  if (!pythonImage) throw new Error("Cannot determine document converter base image");
  const profiles = ["--profile", "gateway", "--profile", "engine"];
  if (openmed) profiles.push("--profile", "openmed");
  const targets = [
    { name: "Presidio base", image: `${repository}:${presidioTag}`, current: pinned.split("@")[1] },
    { name: "Document converter base", image: pythonImage, builtImage: "ficta-doc-converter:dev" },
  ];
  let openmedDefault;
  let openmedSource;
  let updateOpenmedDefault = false;
  if (openmed) {
    openmedSource = read(composeFile);
    openmedDefault = openmedSource.match(/\$\{OPENMED_IMAGE:-(.*?)\}/)?.[1];
    if (!openmedDefault) throw new Error("Cannot determine the default OpenMed image");
    // Compose resolves OPENMED_IMAGE and .env exactly as it will for the update.
    const config = JSON.parse(run([...compose, ...profiles, "config", "--format", "json"]));
    const configured = config.services.openmed.image;
    updateOpenmedDefault = configured === openmedDefault;
    const tag = updateOpenmedDefault ? releaseTag({ tag_name: await release("maziyarpanahi/openmed") }) : undefined;
    targets.push({
      name: "OpenMed",
      image: tag ? `ghcr.io/maziyarpanahi/openmed:${tag}` : configured,
      current: configured.split("@")[1],
    });
  }

  // Resolve every registry reference before changing files or containers.
  for (const target of targets) {
    target.latest = remoteDigest(run(["buildx", "imagetools", "inspect", target.image]));
    if (target.builtImage) {
      const built = run(["image", "inspect", target.builtImage, "--format", "{{json .Config.Labels}}"], {
        allowMissing: true,
      });
      if (built) target.current = JSON.parse(built)?.[baseDigestLabel];
    }
    if (target.current) {
      target.currentDigests = [target.current];
    } else {
      const local = run(["image", "inspect", target.image, "--format", "{{json .RepoDigests}}"], {
        allowMissing: true,
      });
      target.currentDigests = local ? (JSON.parse(local) ?? []).map((ref) => ref.split("@")[1]) : [];
    }
    const status = target.currentDigests.includes(target.latest)
      ? "up to date"
      : target.currentDigests.length
        ? "update available"
        : "not cached locally";
    log(`${target.name}: ${status}\n  ${target.image}\n  upstream ${target.latest}`);
    if (status === "update available") log(`  Run pnpm sidecars:update${openmed ? " --openmed" : ""}`);
  }
  log(
    "Checks compare image digests, not running-container versions. Python packages, Pandoc, optional GLiNER/torch, and model revisions are not checked.",
  );
  if (action === "check") return;

  const nextPin = `${targets[0].image}@${targets[0].latest}`;
  const openmedPin = openmed ? `${targets[2].image.split("@")[0]}@${targets[2].latest}` : undefined;
  const config = JSON.parse(run([...compose, ...profiles, "config", "--format", "json"]));
  const buildTargets = [
    { service: "presidio-analyzer", base: nextPin, replacements: [[pinned, nextPin]] },
    { service: "document-converter", base: `${pythonImage}@${targets[1].latest}`, replacements: [] },
  ];
  for (const target of buildTargets) {
    const service = config.services[target.service];
    const expected = fingerprint(service.build.context, target.base, service.build, target.replacements);
    const local = run(["image", "inspect", service.image, "--format", "{{json .Config.Labels}}"], {
      allowMissing: true,
    });
    if (!force && local && JSON.parse(local)?.[fingerprintLabel] === expected) {
      log(`${target.service}: unchanged; skipping build`);
      continue;
    }
    log(`${target.service}: ${force ? "forced rebuild" : "image missing or inputs changed; building"}`);
    run(
      [
        ...compose,
        ...profiles,
        "build",
        "--pull",
        ...(force ? ["--no-cache"] : []),
        "--build-arg",
        `PRESIDIO_ANALYZER_IMAGE=${nextPin}`,
        "--build-arg",
        `FICTA_SIDECAR_FINGERPRINT=${expected}`,
        "--build-arg",
        `FICTA_SIDECAR_BASE_DIGEST=${target.base.split("@")[1]}`,
        target.service,
      ],
      { inherit: true },
    );
  }
  if (openmed) {
    const local = run(["image", "inspect", openmedPin, "--format", "{{.Id}}"], { allowMissing: true });
    if (force || !local) run(["pull", openmedPin], { inherit: true });
    else log("openmed: image already present; skipping pull");
  }
  if (updateOpenmedDefault && openmedPin !== openmedDefault) {
    write(composeFile, openmedSource.replace(openmedDefault, openmedPin));
    for (const path of [devFile, docsFile]) {
      write(path, read(path).replaceAll(openmedDefault, openmedPin));
    }
    log("Updated the default OpenMed version tag and digest in Compose, dev, and documentation.");
  }
  // Record the successfully built Presidio base for subsequent normal builds.
  if (nextPin !== pinned) {
    write(
      presidioFile,
      presidioSource.replace(`ARG PRESIDIO_ANALYZER_IMAGE=${pinned}`, `ARG PRESIDIO_ANALYZER_IMAGE=${nextPin}`),
    );
    log("Updated Presidio's Dockerfile pin; review and commit it with a changeset.");
  }
  run(
    [
      ...compose,
      ...profiles,
      "up",
      "-d",
      "--no-build",
      ...(force ? ["--force-recreate"] : []),
      "--wait",
      "document-converter",
      "presidio-analyzer",
      ...(openmed ? ["openmed"] : []),
    ],
    { inherit: true, environment: openmed ? { OPENMED_IMAGE: openmedPin } : {} },
  );
  log("Sidecars healthy. Unchanged containers are reused; use --force for an uncached rebuild and restart.");
}

export async function runCli(args, dependencies, warn = console.warn) {
  // Invalid arguments must still fail; advisory mode applies only to the read-only check.
  const options = parseArgs(args);
  try {
    await runSidecars(options, dependencies);
  } catch (error) {
    if (!options.advisory) throw error;
    warn(`[sidecars] Warning: version check incomplete: ${error.message}. Continuing checks.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runCli(process.argv.slice(2));
  } catch (error) {
    console.error(`[sidecars] ${error.message}`);
    process.exitCode = 1;
  }
}
