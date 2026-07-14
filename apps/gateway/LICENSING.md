# Licensing — ficta gateway (`apps/gateway`)

This application (the sensitive-data chat gateway) is **dual-licensed**.

Copyright (c) 2026 steflsd.

## 1. Open-source license: AGPL-3.0-only

By default this app is licensed under the **GNU Affero General Public License, version 3.0 only**
([`LICENSE`](./LICENSE)). You may use, modify, and self-host it under those terms.

The key AGPL obligation (§13): if you **run a modified version and make it available to users over a
network**, you must offer those users the corresponding source of your modified version under the
AGPL. Unmodified use, and internal self-hosting for your own organization's users, is
straightforward — the source is already available to them here.

This is deliberate. The gateway's whole trust argument is that it is **a control you run and audit,
not a processor you send data to**. AGPL keeps it source-available and self-hostable while deterring
anyone from offering a **closed, hosted fork** as a competing service.

## 2. Commercial license

If you cannot or do not want to comply with the AGPL — for example you want to offer a hosted service
based on this app without releasing your modifications, or embed it in a proprietary product — a
**commercial license is available**.

Contact: **hello@ficta.sh**.

> Note: offering a commercial license requires the licensor to hold or have consolidated copyright in
> the code (directly or via a contributor license agreement). Keep this in mind before accepting
> outside contributions to `apps/gateway`.

## Scope

This dual-license applies to **`apps/gateway` only**. The published engine + CLI package
[`packages/ficta`](../../packages/ficta) remains **MIT** — see
[`../../packages/ficta/LICENSE`](../../packages/ficta/LICENSE).
