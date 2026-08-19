# Live end-to-end protection check

This suite is the one test that proves ficta's core claim against the **real**
runtime: it launches each real agent binary (`claude`, `codex`, `pi`) through the
real ficta CLI, against the real provider using **your own auth**, makes the agent
read a sample `.env` containing a canary, and asserts ficta stripped that canary
from what it forwarded upstream.

It is **opt-in** and never runs in `pnpm test` / `pnpm check` / CI — it needs the
agent binaries, live auth, and spends real tokens.

## Run it

```sh
pnpm test:e2e          # just the live suite
pnpm check:live        # offline checks, then the live suite (local release gate)
```

Each agent **self-skips** with a printed reason when its real binary or auth is
absent, so a partial setup still produces honest output (never a false green).

## Prerequisites

- The real agent binaries installed and on `PATH` (resolved excluding the
  `~/.ficta/bin` shim; override with `FICTA_REAL_CLAUDE` / `FICTA_REAL_CODEX` /
  `FICTA_REAL_PI`).
- Provider auth for whichever agents you want to exercise:
  - **claude** — `~/.claude` (subscription) or `ANTHROPIC_API_KEY`
  - **codex** — `~/.codex/auth.json` or `OPENAI_API_KEY`
  - **pi** — uses Pi's own stored logins (`~/.pi/agent/auth.json`) and its real default
    provider from `~/.pi/agent/settings.json` (typically `openai-codex`). Override with
    `FICTA_E2E_PI_PROVIDER` / `FICTA_E2E_PI_MODEL`. Only the built-in
    `anthropic`/`openai`/`openai-codex` providers are routed through ficta.

Optional overrides:

- `FICTA_E2E_CLAUDE_MODEL`, `FICTA_E2E_CODEX_MODEL` — pin a model.
- `FICTA_E2E_ONLY=claude,codex` — run only the named agents (cheaper targeted runs).
- `FICTA_E2E_REGISTRY_OVERRIDE=<path>` — point the registry elsewhere (negative control).
- `FICTA_REAL_CLAUDE` / `FICTA_REAL_CODEX` / `FICTA_REAL_PI` — pin the real binary path.

## What each run asserts

Against ficta's values-free request metadata (`runs/run-*/req-*.meta.json`) and structured
`protection-stats.json` / restore sidecars:

1. **A real provider request contains a registered `BUILD_REF` hit** — proves the agent
   pulled the canary into model context and actually routed through ficta, without writing
   the raw value into trace files.
2. **The same request ID has a body-redaction event** with the registered env-file label,
   at least one redacted value, zero surviving values, and no fail-open forwarding.
3. **The aggregate proof remains clean** — zero survivors/blocked requests, with the
   canary counted as kept out of the model.
4. _(soft)_ **Restore evidence is cross-checked when available.** Some clients stop consuming
   after their protocol completion event, before stream-flush telemetry is written; model stdout
   is also only a soft signal because phrasing can vary.

Exact outbound-byte behavior is covered by the offline proxy integration suite in
`test/server.test.ts`, where a loopback fake provider records what `fetch()` actually receives
and the tests assert that registered values are absent and surrogate tokens are present. Keeping
that proof offline makes it deterministic while the live suite validates real-agent routing and
the linked redaction/restore evidence without weakening runtime trace privacy.

## Negative control (prove the test can fail)

The assertions only mean something if the suite actually fails when protection is
off. Confirm it on one agent with the canary **unregistered**:

```sh
FICTA_E2E_ONLY=claude FICTA_E2E_REGISTRY_OVERRIDE=/dev/null pnpm test:e2e
```

ficta now has nothing to redact, so the values-free request metadata contains no registered
`BUILD_REF` hit and no linked protection event exists. The suite **FAILS**. A green run here
would mean the assertions are vacuous; a red run confirms they depend on real protection.
