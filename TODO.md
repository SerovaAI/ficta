# TODO — Code Review Follow-ups

Findings from a high-effort code review of the restore-highlight / document-converter changes
(`git diff HEAD~1`: last commit + uncommitted). Ordered most-severe first.

## Correctness

- [x] **1. `pnpm dev` hard-fails when Docker is absent** — `scripts/dev-runner.mjs`
  Document-converter sidecar is managed **opt-out** (runs unless `FICTA_DOC_CONVERTER_MANAGED=false`),
  unlike presidio/openmed which are opt-in. On a fresh checkout it ran `docker build` then `docker run`;
  if Docker isn't installed/running, the failure propagated to the top-level catch → `process.exit(1)`,
  so **neither the proxy nor the web app started**.
  → **Fixed (fail soft, keep default-on).** Kept document parsing on by default (per commit "Document parsing
  on by default") but made Docker failures non-fatal in auto mode: extracted `startDocConverterContainer` and
  wrapped it — if `FICTA_DOC_CONVERTER_MANAGED=1` (explicit) a failure still throws (fatal), otherwise it logs
  a warning and continues so the proxy + web start without document parsing. Also kills a half-started
  container on health failure (it isn't in `sidecars` yet, so `stopSidecars` wouldn't reap it). The warning
  points at `pnpm sidecars` to pre-build. **`pnpm build` deliberately left Docker-free** — the image-build home
  is `pnpm sidecars` (compose `--build`, already includes the `document-converter` service). Verified end-to-end
  with docker/pnpm stubs: build-fails and Docker-absent (ENOENT) both warn + continue (exit 0); explicit `=1`
  is fatal (exit 1). The 120s timeout is the post-`docker run` health window, not the build, so no change there.

- [x] **2. Restore-highlight markers leak into the Reasoning panel** — `apps/gateway/src/components/chat/MessageParts.tsx`
  Reasoning/thinking part rendered `{content}` raw, so in trace-highlight mode expanding Reasoning showed the
  literal marker text + control chars around the PII.
  → **Fixed:** `Reasoning` now renders `stripRestoreHighlightMarkers(content)`, matching `MarkdownFallback`.
  Rule: the full markdown surface highlights; plain-text surfaces strip. Gateway typecheck clean.

- [x] **3. Whitespace-flexible matching — intended behavior, documented tradeoff (hardening applied)** — `packages/ficta/src/engine/vault.ts:978`
  The exact-literal guard was replaced with `knownValueMayAppear`/`knownValueMatches` →
  `flexibleWhitespacePattern`. This is **deliberate**: it fixes a fail-open leak where a registered
  value (e.g. `Proxima Medical Supplies CC`) is reflowed by document parsing into
  `Proxima Medical\nSupplies CC` and exact `includes()` misses it, leaking PII upstream. The pattern
  escapes every non-whitespace token (`escapeRegExp`) and flexes only the separators, so it still
  requires the exact token sequence in order — the review's "over-redact benign prose" framing was
  overstated, and there is no regex-injection bug. For a privacy tool, failing closed is the correct
  bias.
  - **Hardening applied:** the flexible separator requires at least one whitespace separator while
    permitting at most one line break
    (`(?:[^\S\r\n]+|[^\S\r\n]*(?:\r\n|\r|\n)[^\S\r\n]*)`), so single-line wrap still matches,
    concatenated tokens do not match, and a paragraph break is not bridged. Regression tests cover
    line wrap, concatenated tokens, and paragraph breaks.
  - **Known residual edge (not fixed):** short/generic two-token registered values could in theory
    over-match a coincidental token run. Not guarded in code because a length/token gate risks
    under-redaction (leaks) for legitimately short names; the registry holds distinctive entity
    names. Revisit if generic values are ever registered.
  - _Unrelated:_ plain `Northstar` (registry has `Northstar Biologics`) is not redacted — that is
    partial/prefix matching, a separate concern this change does not and should not address.

- [x] **4. Inconsistent SSE highlighting** — `packages/ficta/src/engine/vault.ts`
  In `restoreEventStream`, `opts` was threaded into the primary restore and `restoreJsonExcept` but **not**
  into `restoreExcept`. Refined during the fix: the *named* text delta uses the primary `restoreText` (already
  had `opts`), so the real gap was the **deep-sweep** path — sibling fields (e.g. `reasoning_content`) restored
  via `restoreExcept` when the stream withholds a tool token — which emitted restored values without markers.
  → **Fixed:** pass `opts` to `restoreTextExcept`, matching its siblings. Added a regression test
  (`highlights restored sibling fields on the deep-sweep path…`) using two secrets (the sibling must differ
  from the withheld token, which `restoreExcept` skips); confirmed it fails without the fix, passes with it.

- [x] **5. Trace hashing runs on every request even when auditing is off** — `packages/ficta/src/server.ts:881`
  `writeProtectionTraceAudit` ran at every terminal path regardless of `cfg.traceAudit`; its first line called
  `scope.traceRestoreDetails()`, which SHA-256-hashes and builds trace objects for every restored value. With
  traceAudit off (default), the later `writeTraceAudit` no-ops — wasted per-request CPU plus needless hashing
  of restored PII on all production traffic.
  → **Fixed:** `writeProtectionTraceAudit` now takes a `traceAudit: boolean` and early-returns at the top,
  before `traceRestoreDetails()`, so no hashing happens on the default path. `cfg.traceAudit` is threaded from
  all 8 call sites (matching how it's already passed to `redactBodyDetailed`/`redactQueryString`).
  `writeTraceAudit`'s own gate stays as defense-in-depth. Full ficta suite green (342 tests), typecheck clean.

## Cleanup / efficiency

- [x] **6. `stripRestoreHighlightMarkers` scans full history per request** — `apps/gateway/src/lib/restore-highlights.ts`
  Deep-cloned and `replaceAll`-scanned every message/part on each `POST /api/chat`, plus per render
  (`MessageBubble.tsx`) and per save (`storage/messages.ts`), even though markers only exist in
  `FICTA_TRACE_AUDIT=1` mode.
  → **Fixed:** made the strip self-gating instead of flag-gating (safer — no divergence risk of leaking
  markers if a flag falls out of sync). It now traverses once read-only (`containsRestoreHighlightMarkersDeep`,
  zero allocation) and returns the **original** object graph untouched when there are no markers; the deep
  clone (`cloneWithoutRestoreHighlightMarkers`) runs only when a marker is actually present. Call sites
  unchanged. New test asserts identity (same references) on the no-marker path. Always correct, near-free on
  normal traffic.

- [x] **7. Regex rebuilt 2–3× per value per redact pass** — `packages/ficta/src/engine/vault.ts`
  `knownValueMayAppear` compiled `flexibleWhitespacePattern(value)`, then `knownValueMatches` compiled the
  same regex again (and every leak scan recompiled too).
  → **Fixed:** split into `buildFlexibleWhitespacePattern` (the builder) + a per-value cache
  (`flexiblePatternCache`). Cached regexes are global/stateful, so `lastIndex` is reset on every lookup;
  a `FLEXIBLE_PATTERN_CACHE_LIMIT` (2048, oldest-evicted) bounds memory as detected values accumulate over
  process lifetime. Match semantics unchanged — 342 ficta tests pass.

- [x] **8. `traceValues` does two full layer scans per value** — `packages/ficta/src/engine/vault.ts`
  `surrogateFor(value)` and `provenanceForValue(value)` each looped `this.layers` independently.
  → **Fixed:** one `surrogateEntryFor` walk returns both (the layer holding the surrogate is the one whose
  provenance applies — provably equivalent). Removed the now-unused `provenanceForValue`. `surrogateFor`
  stays (still used on the redact path).

- [x] **9. `Intl.NumberFormat` allocated per cell** — `apps/gateway/src/components/settings/RedactionProofSection.tsx`
  `formatNumber` built a fresh `Intl.NumberFormat()` on every `CountCell` (5 per bucket row) each re-render/poll.
  → **Fixed:** hoisted to a module-level `numberFormatter` singleton.

- [x] **10. Gateway always sends `x-ficta-restore-highlights:1`** — `apps/gateway/src/lib/model-adapter.ts`
  Header went out on every request even though the proxy only acts on it when `FICTA_TRACE_AUDIT=1`.
  → **Resolved (design: one switch).** First gated the header behind a new gateway flag
  `FICTA_RESTORE_HIGHLIGHTS`, then reverted that: the header is the gateway's honest *static* capability (the
  UI can always render markers), and once #6 made the strip free the inert internal header costs nothing to
  send. So the header is sent unconditionally and **`FICTA_TRACE_AUDIT` (proxy) is the sole highlight
  switch** — no second gateway flag to coordinate, no "traceAudit on but no highlights" papercut. The
  proxy's own `traceAudit && header` check still protects non-gateway clients (curl, etc.) from marker bytes.
  A comment in `model-adapter.ts` records why the header is unconditional.

---

_Refuted during verification: a claimed narrowing of the `containsProtectedValue` metadata-safety guard
(`engine.ts:336`) — value sets are identical, nothing is missed._
