# Licensing — ficta Gateway (`apps/gateway`)

This application (the sensitive-data chat gateway) is **source-available** under the
**Business Source License 1.1** ([`LICENSE`](./LICENSE)), with a **commercial license required for
production use**.

Copyright (c) 2026 Serova OÜ (registry no. 17252303), Soo 2-3, 10414 Tallinn, Estonia.

## What you can do for free (BUSL 1.1)

- **Read and audit every line.** The gateway's whole trust argument is that it is **a control you
  run and audit, not a processor you send data to**. The source stays public; nothing about that
  changes.
- **Copy, modify, create derivative works, and redistribute** the source under the terms of the
  License.
- **All non-production use** — evaluation, development, testing, staging, and security review,
  self-hosted in your own environment.

## What requires a commercial license

**Any production use.** The `Additional Use Grant` in [`LICENSE`](./LICENSE) is `None`, so running
the gateway in production — whether internally within an organization or offered to others as a
service — requires a commercial license from Serova OÜ.

Contact: **hello@ficta.sh**.

## Change Date

Each released version of the Licensed Work converts to the **Apache License 2.0** four years after
it is published. Older versions become open source on that schedule; the current version always
requires a commercial license for production use.

## Prior versions

Versions of `apps/gateway` in the repository history **up to and including commit `aacf45d`** were
licensed under **AGPL-3.0-only** and remain available under those terms. The change to BUSL 1.1 is
not retroactive and applies from the relicensing commit onward.

## Contributions

Serova OÜ must hold consolidated copyright in `apps/gateway` for the commercial license to work.
External contributions to this directory are only accepted under a contributor license agreement
(CLA) that assigns or broadly licenses the contribution to Serova OÜ.

## Scope

This license applies to **`apps/gateway` only**. The published engine + CLI package
[`packages/ficta`](../../packages/ficta) and the shared protocol package
[`packages/protocol`](../../packages/protocol) remain **MIT** — see their respective `LICENSE`
files.
