#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SIGNAL_EXIT_CODES = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

const DEFAULT_PRESIDIO_URL = "http://127.0.0.1:5002";
const DEFAULT_PRESIDIO_IMAGE = "ghcr.io/data-privacy-stack/presidio-analyzer:latest";
const DEFAULT_PRESIDIO_CONFIG = resolve(rootDir, "packages/ficta/presidio/default_recognizers.za.yaml");
const CONTAINER_CONFIG_PATH = "/app/ficta-presidio-recognizers.yaml";
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;

const DEFAULT_DOC_CONVERTER_URL = "http://127.0.0.1:5003";
const DEFAULT_DOC_CONVERTER_IMAGE = "ficta-doc-converter:dev";
const DEFAULT_DOC_CONVERTER_CONTEXT = resolve(rootDir, "apps/gateway/sidecars/document-converter");
const DEFAULT_DOC_CONVERTER_STARTUP_TIMEOUT_MS = 120_000;

const DEFAULT_OPENMED_URL = "http://127.0.0.1:5004";
// Upstream's published multi-arch service image; override FICTA_PII_OPENMED_IMAGE for a pinned tag
// or a locally built (patched) image.
const DEFAULT_OPENMED_IMAGE = "ghcr.io/maziyarpanahi/openmed:latest";
// The OpenMed REST service's own default PII model — preloaded so a cold container is ready before
// the first request instead of eating the recognizer's per-request budget.
const DEFAULT_OPENMED_MODEL = "OpenMed/OpenMed-PII-SuperClinical-Small-44M-v1";
const DEFAULT_OPENMED_HF_CACHE_VOLUME = "openmed-hf-cache";
// First start on a machine pulls the image and downloads the model; a warm start is healthy in ~15s.
const DEFAULT_OPENMED_STARTUP_TIMEOUT_MS = 300_000;

const HEALTH_POLL_MS = 500;
const STOP_TIMEOUT_MS = 5_000;

const env = { ...process.env };
const forwardArgs = process.argv.slice(2);
const sidecars = [];

try {
  const docConverter = await maybeStartDocConverter(env);
  if (docConverter) sidecars.push(docConverter);
  const presidio = await maybeStartPresidio(env);
  if (presidio) sidecars.push(presidio);
  const openmed = await maybeStartOpenmed(env);
  if (openmed) sidecars.push(openmed);
  run("pnpm", ["dev:all", ...forwardArgs], env, sidecars);
} catch (err) {
  await stopSidecars(sidecars);
  console.error(`[dev] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

async function maybeStartPresidio(env) {
  if (!shouldManage(env, "presidio", env.FICTA_PII_PRESIDIO_MANAGED)) return undefined;

  const url = stripTrailingSlash(env.FICTA_PII_PRESIDIO_URL?.trim() || DEFAULT_PRESIDIO_URL);
  env.FICTA_PII_PRESIDIO_URL = url;

  const parsed = parseManagedSidecarUrl(url, "Presidio", "FICTA_PII_PRESIDIO_URL");
  if (!parsed.ok) {
    if (isExplicitlyEnabled(env.FICTA_PII_PRESIDIO_MANAGED)) {
      throw new Error(parsed.reason);
    }
    console.log(`[dev] not managing Presidio sidecar: ${parsed.reason}`);
    return undefined;
  }

  if (await healthOk(url, 750)) {
    console.log(`[dev] using existing Presidio analyzer at ${url}`);
    return undefined;
  }

  const configPath = resolve(rootDir, env.FICTA_PII_PRESIDIO_CONFIG_FILE ?? DEFAULT_PRESIDIO_CONFIG);
  if (!existsSync(configPath)) {
    throw new Error(`Presidio registry config not found: ${configPath}`);
  }

  const image = env.FICTA_PII_PRESIDIO_IMAGE?.trim() || DEFAULT_PRESIDIO_IMAGE;
  const containerName = env.FICTA_PII_PRESIDIO_CONTAINER_NAME?.trim() || `ficta-presidio-${process.pid}`;
  const startupTimeoutMs = readPositiveInt(env.FICTA_PII_PRESIDIO_STARTUP_TIMEOUT_MS, DEFAULT_STARTUP_TIMEOUT_MS);

  console.log(`[dev] starting Presidio analyzer sidecar at ${url}`);
  console.log(`[dev] Presidio registry: ${configPath}`);

  const child = spawn(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      containerName,
      "-p",
      `127.0.0.1:${parsed.port}:3000`,
      "-v",
      `${configPath}:${CONTAINER_CONFIG_PATH}:ro`,
      "-e",
      `RECOGNIZER_REGISTRY_CONF_FILE=${CONTAINER_CONFIG_PATH}`,
      image,
    ],
    {
      cwd: rootDir,
      env,
      stdio: "inherit",
    },
  );

  await waitForSidecarHealth(child, url, startupTimeoutMs, "Presidio analyzer");
  console.log(`[dev] Presidio analyzer is healthy at ${url}`);
  return { name: "presidio", child };
}

async function maybeStartOpenmed(env) {
  if (!shouldManage(env, "openmed", env.FICTA_PII_OPENMED_MANAGED)) return undefined;

  const url = stripTrailingSlash(env.FICTA_PII_OPENMED_URL?.trim() || DEFAULT_OPENMED_URL);
  env.FICTA_PII_OPENMED_URL = url;

  const parsed = parseManagedSidecarUrl(url, "OpenMed", "FICTA_PII_OPENMED_URL");
  if (!parsed.ok) {
    if (isExplicitlyEnabled(env.FICTA_PII_OPENMED_MANAGED)) {
      throw new Error(parsed.reason);
    }
    console.log(`[dev] not managing OpenMed sidecar: ${parsed.reason}`);
    return undefined;
  }

  if (await healthOk(url, 750)) {
    console.log(`[dev] using existing OpenMed service at ${url}`);
    return undefined;
  }

  const image = env.FICTA_PII_OPENMED_IMAGE?.trim() || DEFAULT_OPENMED_IMAGE;
  const containerName = env.FICTA_PII_OPENMED_CONTAINER_NAME?.trim() || `ficta-openmed-${process.pid}`;
  const model = env.FICTA_PII_OPENMED_MODEL?.trim() || DEFAULT_OPENMED_MODEL;
  const cacheVolume = env.FICTA_PII_OPENMED_HF_CACHE_VOLUME?.trim() || DEFAULT_OPENMED_HF_CACHE_VOLUME;
  const startupTimeoutMs = readPositiveInt(
    env.FICTA_PII_OPENMED_STARTUP_TIMEOUT_MS,
    DEFAULT_OPENMED_STARTUP_TIMEOUT_MS,
  );

  console.log(`[dev] starting OpenMed service sidecar at ${url} (first start pulls the image and model; be patient)`);

  const child = spawn(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      containerName,
      "-p",
      `127.0.0.1:${parsed.port}:8080`,
      "-e",
      `OPENMED_SERVICE_PRELOAD_MODELS=${model}`,
      // The CPU image's torch/transformers combination rejects SDPA attention for the DeBERTa-based
      // PII models; without eager the preload (and every lazy load) fails.
      "-e",
      "OPENMED_TORCH_ATTENTION_BACKEND=eager",
      "-e",
      "OPENMED_SERVICE_KEEP_ALIVE=10m",
      "-v",
      `${cacheVolume}:/root/.cache/huggingface`,
      image,
    ],
    {
      cwd: rootDir,
      env,
      stdio: "inherit",
    },
  );

  await waitForSidecarHealth(child, url, startupTimeoutMs, "OpenMed service");
  console.log(`[dev] OpenMed service is healthy at ${url}`);
  return { name: "openmed", child };
}

async function maybeStartDocConverter(env) {
  const explicit = parseBoolean(env.FICTA_DOC_CONVERTER_MANAGED);
  if (explicit === false) return undefined;

  const url = stripTrailingSlash(env.FICTA_DOC_CONVERTER_URL?.trim() || DEFAULT_DOC_CONVERTER_URL);
  env.FICTA_DOC_CONVERTER_URL = url;

  const parsed = parseManagedSidecarUrl(url, "document converter", "FICTA_DOC_CONVERTER_URL");
  if (!parsed.ok) {
    if (explicit === true) {
      throw new Error(parsed.reason);
    }
    console.log(`[dev] not managing document converter sidecar: ${parsed.reason}`);
    return undefined;
  }

  if (await healthOk(url, 750)) {
    console.log(`[dev] using existing document converter at ${url}`);
    return undefined;
  }

  const imageOverride = env.FICTA_DOC_CONVERTER_IMAGE?.trim();
  const image = imageOverride || DEFAULT_DOC_CONVERTER_IMAGE;
  const containerName = env.FICTA_DOC_CONVERTER_CONTAINER_NAME?.trim() || `ficta-doc-converter-${process.pid}`;
  const backend = env.FICTA_DOC_CONVERTER_BACKEND?.trim().toLowerCase() || "markitdown";
  const startupTimeoutMs = readPositiveInt(
    env.FICTA_DOC_CONVERTER_STARTUP_TIMEOUT_MS,
    DEFAULT_DOC_CONVERTER_STARTUP_TIMEOUT_MS,
  );

  if (!imageOverride) {
    console.log(`[dev] building document converter sidecar image ${image}`);
    await runChecked("docker", ["build", "-t", image, DEFAULT_DOC_CONVERTER_CONTEXT], env);
  }

  console.log(`[dev] starting document converter sidecar at ${url}`);

  const child = spawn(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      containerName,
      "-p",
      `127.0.0.1:${parsed.port}:5003`,
      "-e",
      `CONVERTER_BACKEND=${backend}`,
      image,
    ],
    {
      cwd: rootDir,
      env,
      stdio: "inherit",
    },
  );

  await waitForSidecarHealth(child, url, startupTimeoutMs, "document converter");
  console.log(`[dev] document converter is healthy at ${url}`);
  return { name: "document converter", child };
}

/**
 * Manage a sidecar when its FICTA_PII_<NAME>_MANAGED flag is explicitly set, else automatically
 * when the backend is selected — via FICTA_PII_BACKENDS or the legacy single FICTA_PII_BACKEND.
 */
function shouldManage(env, backend, managedFlag) {
  const explicit = parseBoolean(managedFlag);
  if (explicit !== undefined) return explicit;
  return selectedBackends(env).includes(backend);
}

/** Mirror of selectedBackendNames() in packages/ficta/src/engine/plugins/pii/registry.ts. */
function selectedBackends(env) {
  const raw = env.FICTA_PII_BACKENDS?.trim() || env.FICTA_PII_BACKEND?.trim() || "";
  return raw
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
}

function parseManagedSidecarUrl(url, label, envName) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: `invalid ${envName}: ${url}` };
  }

  if (parsed.protocol !== "http:") {
    return { ok: false, reason: `managed ${label} sidecar requires an http:// loopback URL, got ${url}` };
  }
  if (!isLoopbackHost(parsed.hostname)) {
    return { ok: false, reason: `managed ${label} sidecar only binds loopback URLs, got ${url}` };
  }

  const port = parsed.port ? Number(parsed.port) : 80;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ok: false, reason: `invalid ${label} sidecar port in ${url}` };
  }
  return { ok: true, port };
}

/** Race container health against docker spawn failure / early container exit. */
async function waitForSidecarHealth(child, url, timeoutMs, label) {
  let exit;
  child.once("exit", (code, signal) => {
    exit = { code, signal };
  });

  const errorPromise = new Promise((_, reject) => {
    child.once("error", (error) => reject(new Error(`failed to start docker: ${error.message}`)));
  });

  await Promise.race([waitForHealth(url, timeoutMs, () => exit, label), errorPromise]);
}

function runChecked(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env,
      stdio: "inherit",
    });

    child.once("error", (error) => reject(new Error(`failed to start ${command}: ${error.message}`)));
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = signal ? `signal ${signal}` : `exit code ${code ?? 0}`;
      reject(new Error(`${command} ${args[0] ?? ""} failed (${detail})`.trim()));
    });
  });
}

async function waitForHealth(url, timeoutMs, exited, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exit = exited();
    if (exit) {
      const detail = exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code ?? 0}`;
      throw new Error(`${label} sidecar stopped before becoming healthy (${detail})`);
    }

    if (await healthOk(url, Math.min(1_000, Math.max(250, deadline - Date.now())))) return;
    await sleep(HEALTH_POLL_MS);
  }

  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label} at ${url}/health`);
}

async function healthOk(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function run(command, args, env, sidecars) {
  const child = spawn(command, args, {
    cwd: rootDir,
    env,
    stdio: "inherit",
  });

  const forwardSignal = (signal) => {
    if (!child.killed) child.kill(signal);
    for (const sidecar of sidecars) {
      if (!isChildDone(sidecar.child) && !sidecar.child.killed) sidecar.child.kill(signal);
    }
  };

  for (const signal of Object.keys(SIGNAL_EXIT_CODES)) process.on(signal, forwardSignal);

  child.on("error", async (error) => {
    for (const signal of Object.keys(SIGNAL_EXIT_CODES)) process.off(signal, forwardSignal);
    await stopSidecars(sidecars);
    console.error(`[dev] failed to start ${command}: ${error.message}`);
    process.exit(1);
  });

  child.on("exit", async (code, signal) => {
    for (const signalName of Object.keys(SIGNAL_EXIT_CODES)) process.off(signalName, forwardSignal);
    await stopSidecars(sidecars);
    if (signal) process.exit(SIGNAL_EXIT_CODES[signal] ?? 1);
    process.exit(code ?? 0);
  });
}

async function stopSidecars(sidecars) {
  for (const sidecar of [...sidecars].reverse()) {
    if (isChildDone(sidecar.child)) continue;
    console.log(`[dev] stopping ${sidecar.name} sidecar`);
    sidecar.child.kill("SIGTERM");
    const stopped = await waitForExit(sidecar.child, STOP_TIMEOUT_MS);
    if (!stopped && !isChildDone(sidecar.child)) sidecar.child.kill("SIGKILL");
  }
}

function waitForExit(child, timeoutMs) {
  if (isChildDone(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

function isChildDone(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function isLoopbackHost(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const octets = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!octets) return false;
  const parts = octets.slice(1).map(Number);
  return parts.every((part) => part <= 255) && parts[0] === 127;
}

function parseBoolean(value) {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function isExplicitlyEnabled(value) {
  return parseBoolean(value) === true;
}

function readPositiveInt(raw, fallback) {
  const n = Number(raw ?? fallback);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function stripTrailingSlash(url) {
  return url.replace(/\/+$/, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
