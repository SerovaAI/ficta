#!/usr/bin/env node
import { resolve } from "node:path";
import { parseDevEnvArgs, prepareDevEnvironment, rootDir, run, runWithDevEnvironment } from "./dev-env.mjs";

const gatewayDir = resolve(rootDir, "apps/gateway");
const { forceDoppler, forwardArgs, help } = parseDevEnvArgs(process.argv.slice(2));

if (help) {
  printHelp();
  process.exit(0);
}

if (process.env.FICTA_DEV_ENV_READY === "1") {
  run("pnpm", viteDevArgs(forwardArgs), { ...process.env }, gatewayDir);
} else {
  const { env, doppler, envSummary } = prepareDevEnvironment({
    forceDoppler,
    disableRegistryDopplerWhenLocal: true,
  });
  env.FICTA_DEV_ENV_READY = "1";

  runWithDevEnvironment({
    label: "gateway:dev",
    command: "pnpm",
    args: viteDevArgs(forwardArgs),
    env,
    doppler,
    envSummary,
    cwd: gatewayDir,
  });
}

function viteDevArgs(args) {
  return ["run", "dev:vite", ...args];
}

function printHelp() {
  console.log(
    `Usage: pnpm run dev [-- --doppler | --no-doppler] [vite args...]\n\nRun this from apps/gateway to start only Ficta Gateway. From the repo root,\nuse pnpm gateway:dev for the same package dev script, or pnpm dev for the full\nproxy + app stack. By default this wrapper uses Doppler when the Doppler CLI is\ninstalled, otherwise it loads local .env files and starts Vite without Doppler.\n\nOptions:\n  --doppler      Force Doppler secret injection\n  --no-doppler   Force local .env mode\n`,
  );
}
