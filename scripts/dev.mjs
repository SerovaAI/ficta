#!/usr/bin/env node
import { parseDevEnvArgs, prepareDevEnvironment, runWithDevEnvironment } from "./dev-env.mjs";

const { forceDoppler, forwardArgs, help } = parseDevEnvArgs(process.argv.slice(2));

if (help) {
  printHelp();
  process.exit(0);
}

const { env, doppler, envSummary } = prepareDevEnvironment({
  forceDoppler,
  disableRegistryDopplerWhenLocal: true,
});

// Child package dev scripts can skip their own Doppler/.env wrapper because this root wrapper already
// prepared the process environment before launching Turbo.
env.FICTA_DEV_ENV_READY = "1";

runWithDevEnvironment({
  label: "dev",
  command: "node",
  args: ["scripts/dev-runner.mjs", ...forwardArgs],
  env,
  doppler,
  envSummary,
});

function printHelp() {
  console.log(
    `Usage: pnpm dev [-- --doppler | --no-doppler]\n\nStarts the proxy, Gateway app, and managed local dev sidecars. It does not\nstart the public website; use pnpm web:dev for that, or pnpm dev:all for every\nworkspace dev task. By default this wrapper uses Doppler when the Doppler CLI\nis installed, otherwise it loads local .env files and starts the same dev tasks\nwithout Doppler.\n\nOptions:\n  --doppler      Force Doppler secret injection\n  --no-doppler   Force local .env mode\n`,
  );
}
