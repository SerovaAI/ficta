# Development Rules

## Changelog

Releases are managed by [Changesets](https://github.com/changesets/changesets). The per-package `CHANGELOG.md` files are **generated** — never hand-edit them.

For any meaningful change to a **published** package (`@serovaai/ficta` or `@serovaai/ficta-protocol`), add a changeset before finishing:

```
pnpm changeset
```

Pick the affected package(s) and bump type (patch/minor/major), write a one-line summary, and commit the generated `.changeset/*.md` file with your change. A meaningful change is anything users or maintainers would expect to see in release notes, including:

- new features, commands, integrations, or supported flows;
- bug fixes;
- changed CLI behavior, config, defaults, public APIs, docs, or security/threat-model claims;
- removals or deprecations; and
- release, packaging, install, or upgrade behavior changes.

Rules:

- `@serovaai/ficta` and `@serovaai/ficta-protocol` are a **fixed pair** — they always release together at the same version, so a changeset selecting either one bumps both.
- The apps (`@serovaai/ficta-gateway`, `@serovaai/ficta-web`) are private and not published; they need no changeset.
- Skip changesets for purely internal refactors, test-only changes, formatting, or agent-instruction-only changes that do not affect shipped behavior.
- When unsure whether a change is meaningful, add a short changeset.
- Releasing is automated: on merge to `main`, CI opens a "Version Packages" PR; merging that PR publishes to npm. Never bump versions or edit changelogs by hand.

## Private notes

The top-level `notes/` folder is gitignored (`.gitignore`) and never committed to the public repo.

- Any documentation or notes that should stay out of the public repo — competitive analysis, GTM/positioning, pricing, red-team findings, unreleased-strategy docs, internal teardowns — belong in `notes/`, not in `packages/ficta/docs/` (which is public and published).
- Everything under `packages/ficta/docs/` is public. Before writing internal-only content there, put it in `notes/` instead.
- Public docs must not link into `notes/` (the link would dangle for anyone reading the published repo). Inline the needed substance instead. Private docs in `notes/` may freely link to public docs via relative paths (e.g. `../packages/ficta/README.md`).
- Follow the same kebab-case `.md` convention as the public docs.
- Moving a file into `notes/` only makes it private going forward — it stays in prior git history. If a doc was already committed publicly, privatizing it does not scrub the history.
