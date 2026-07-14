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

## Private material

Everything tracked in `SerovaAI/ficta` is public and must be suitable for publication. This includes
source, tests, fixtures, pull-request context, and all documentation under `packages/ficta/docs/`,
which is also included in the published npm package.

- Competitive analysis, GTM/positioning, pricing, red-team findings, internal specifications,
  unreleased strategy, and internal teardowns belong in the private `SerovaAI/ficta-internal`
  repository, not anywhere tracked in this repository.
- If you do not have access to `SerovaAI/ficta-internal`, do not add private material here or create a
  local canonical substitute. Stop and ask a maintainer for access or for the material to be placed
  there.
- Public product documentation must not link to private-repository resources because those links are
  unavailable to public readers. Internal documentation may link back to public Ficta docs using
  stable GitHub URLs.
- The gitignored top-level `notes/` path is only an accidental-spill and temporary local-scratch
  safeguard. It is not a canonical documentation location; move anything worth retaining to
  `SerovaAI/ficta-internal` promptly.
- Moving or deleting content only makes it private going forward. Material already committed to this
  repository remains in public Git history unless the history is separately rewritten.
