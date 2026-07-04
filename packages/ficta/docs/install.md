# ficta shim setup

The preferred runtime shape is an **ephemeral proxy per agent session**: secrets are discovered in
the current project/env, kept in memory for that session, then forgotten when the agent exits.

Install ficta globally with your package manager:

```sh
# npm
npm install -g @serovaai/ficta

# pnpm (run `pnpm setup` first if pnpm global bins are not configured)
pnpm add -g @serovaai/ficta

# bun
bun install --global @serovaai/ficta
```

Then, to avoid relying on muscle memory (`ficta claude` every time), install shell shims once:

```sh
ficta setup   # configure ~/.ficta/config.toml and optionally install shims
# or just install shims directly:
ficta install
```

From a source checkout, use `pnpm --filter @serovaai/ficta ficta setup` /
`pnpm --filter @serovaai/ficta ficta install` instead. If you want the bare `ficta` command to point
at your checkout while developing, install the package directory, not the workspace root:

```sh
pnpm add -g /path/to/ficta/packages/ficta
```

`ficta --version` will show a `+dev` suffix when running from source.

Before launching an agent, sanity-check registry loading and routing:

```sh
ficta doctor claude   # or codex / pi
```

Then restart your shell and use your normal commands:

```sh
claude
codex
pi
```

The installed files are generated from agent-integration plugins:

```txt
~/.ficta/bin/.ficta-launcher -> hidden launcher for the installed ficta CLI, using /usr/bin/env node
~/.ficta/bin/claude          -> calls the sibling launcher as: .ficta-launcher claude "$@"
~/.ficta/bin/codex           -> calls the sibling launcher as: .ficta-launcher codex "$@"
~/.ficta/bin/pi              -> calls the sibling launcher as: .ficta-launcher pi "$@"
```

ficta intentionally does **not** install `~/.ficta/bin/ficta`, so the `ficta` command remains the
global package-manager CLI. Upgrading is just rerunning your global install command, for example
`npm install -g @serovaai/ficta`, `pnpm add -g @serovaai/ficta`, or
`bun install --global @serovaai/ficta`.

Only the hidden launcher contains the installed CLI path. If the global package manager moves the
published CLI, or if a local source checkout moves, rerun the install command for that install type
and then refresh the launcher with `ficta install --force`.

## Repair moved install paths

### Published package installs

After upgrading or reinstalling the published package, refresh the generated launcher and shims:

```sh
# npm
npm install -g @serovaai/ficta
ficta install --force

# pnpm
pnpm add -g @serovaai/ficta
ficta install --force

# bun
bun install --global @serovaai/ficta
ficta install --force
```

### Local source-checkout installs

For local development, point the global `ficta` command at a durable checkout's package directory:

```sh
pnpm add -g /path/to/ficta/packages/ficta
ficta install --force
```

Do not point a global install at a disposable worktree, temporary clone, or archived Conductor
workspace. Those installs are symlinks back to the source directory; when that directory is removed,
the global `ficta` command and the agent shim launcher will break. Use a normal local checkout you
intend to keep, then rerun the two commands above whenever that checkout path changes.

If the old local checkout was already removed, the bare `ficta` command may fail before it can repair
the shims. Re-add the durable package path first, then run the CLI from pnpm's global bin directory:

```sh
pnpm add -g /path/to/ficta/packages/ficta
$(pnpm bin -g)/ficta install --force
```

For source-checkout installs, if the checkout moves, the launcher first tries to recover from a moved
checkout in the current repository tree. When it finds one, it launches through that path and prints
the repair command:

```sh
pnpm --filter @serovaai/ficta ficta install --force
```

If the launcher cannot discover the moved checkout, point at it for one run without using a global
install:

```sh
FICTA_CLI_PATH=/path/to/packages/ficta/bin/ficta.mjs claude
```

Then rerun the repair command from the moved checkout to refresh the generated launcher.

### Troubleshooting

Check which ficta CLI the agent shims will launch:

```sh
sed -n '1,8p' ~/.ficta/bin/.ficta-launcher
```

If launcher output or repair guidance still mentions an old package scope or an old checkout path,
the generated launcher itself is stale. For a published install, rerun the npm/pnpm/bun global
install and then `ficta install --force`. For a local source install, re-add the durable package path
and run `$(pnpm bin -g)/ficta install --force`, or run
`pnpm --filter @serovaai/ficta ficta install --force` from the source checkout.

For source-checkout installs, confirm the CLI reports a dev build:

```sh
ficta --version
```

If `ficta` is not on your shell `PATH` after a pnpm global install, locate the pnpm global bin
directory and run the wrapper from there:

```sh
pnpm bin -g
$(pnpm bin -g)/ficta install --force
```

`ficta install` also adds `~/.ficta/bin` to your shell startup file (`~/.zshrc`, `~/.bashrc`, or
`~/.profile`) using a managed block.

## Why shims instead of an always-on proxy?

Shims preserve the important privacy properties:

- the registry is discovered from the current working directory (`.env`, `.env.local`) and configured sources in `~/.ficta/config.toml`
- Doppler CLI secrets are loaded before the agent starts; `doppler run -- claude` / `doppler run -- pi` can also be covered by enabling process-env loading
- secrets live only for the agent session
- multiple projects do not share one long-lived vault

## Agent integrations

Agent shims are backed by built-in agent-integration plugins:

- `claude`: sets `ANTHROPIC_BASE_URL` for Claude Code.
- `codex`: injects temporary `-c model_provider=...` overrides, including ChatGPT/OAuth handling.
- `pi`: launches Pi with `PI_CODING_AGENT_DIR` set to an ephemeral agent dir that mirrors Pi's real
  auth/settings and swaps in a `models.json` overriding the base URLs of the built-in `anthropic`,
  `openai`, and `openai-codex` providers to the ficta proxy. (A `models.json` base URL is the only
  override Pi reliably honors.) User-defined providers point at their own upstreams and are not routed.

Non-model commands such as `--version`, `--help`, and Pi package-management commands (`pi install`,
`pi update`, etc.) pass through directly to the real agent without starting a proxy.

## Empty registry behavior

If no protected values load, ficta warns and launches the agent in passthrough mode by default:

```txt
⚠ no protected values loaded — launching anyway in passthrough mode
```

To get protection in that project, add/point at registry sources with `ficta setup` or by editing
`~/.ficta/config.toml`:

```toml
[registry.env_file]
enabled = true
paths = [".env", ".env.production"]

[registry.process_env]
enabled = true
mode = "secret-ish"

[registry.doppler]
enabled = true
configs = ["dev", "prod"]
```

Shell `FICTA_*` environment variables can still override these settings for one run.

If you want strict startup blocking instead, set `registry.require = true` in config, or override once:

```sh
FICTA_REQUIRE_REGISTRY=1 claude
```

With strict mode enabled, bypass once with:

```sh
claude --allow-empty
# or
FICTA_ALLOW_EMPTY=1 claude
```

## Disable or bypass

If you need the real agent without ficta once:

```sh
FICTA_DISABLE=1 claude
FICTA_DISABLE=1 codex
FICTA_DISABLE=1 pi
```

To turn installed shims off globally without uninstalling them:

```sh
ficta disable
# later:
ficta enable
```

`ficta disable` writes `~/.ficta/disabled`; shims and `ficta <agent>` bypass the proxy while that
file exists. `ficta enable` removes it.

The shim resolves the real agent executable outside `~/.ficta/bin` to avoid recursion.

## Uninstall

If you installed the published package:

```sh
ficta uninstall
```

From a source checkout:

```sh
pnpm --filter @serovaai/ficta ficta uninstall
```

This removes ficta-owned shims and the managed PATH block. It will not delete/overwrite non-ficta
files that happen to exist in `~/.ficta/bin`.

## Options

```sh
ficta install --no-shell   # write shims but do not edit shell rc
ficta install --force      # overwrite existing files in ~/.ficta/bin
ficta uninstall --no-shell # remove shims but leave shell rc unchanged
```

From a source checkout, run these through the package script, for example
`pnpm --filter @serovaai/ficta ficta install --force`.
