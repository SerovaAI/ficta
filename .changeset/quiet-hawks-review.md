---
"@serovaai/ficta": patch
---

Secret-shape detector and engine fixes from a core-engine review:

- An unquoted `KEY=value` line or credential URL that ended a request-body leaf was missed whenever another leaf followed it: the value patterns ran across the engine's leaf boundary and the straddling candidate was then rejected. The value classes now stop at the boundary.
- `host:port/@path` URLs (Vite's `/@vite/client`, `/@fs/…`, scoped-package paths) were registered as high-confidence credential URLs; userinfo may no longer contain `/`.
- The placeholder filter (`example`, `your`, `xxx`, …) no longer suppresses a PEM private key whose base64 body contains such a substring, or a credential URL whose _hostname_ does; for credential URLs it inspects only the password.
- Google OAuth access tokens (`ya29.…`) are now a recognised shape.
- The opaque-value entropy bar scales with length below 40 characters, so genuinely random 32-char tokens are no longer rejected about a third of the time.
- Detection is linear on large identifier or base64url blobs (bounded key/scheme runs, anchored JWT start); a 100 KB run previously took seconds.
- Under fail-closed detection (`FICTA_FAIL_CLOSED_DETECTION` or a detector's own `fail_closed`), any detector exception now blocks the request, not only a signalled backend outage; under fail-open the skipped detector is logged and reported as `skippedDetectors` on the redaction details.
- Keyed-scope requests carrying thousands of detected values (a lockfile's worth of hashes) are several times faster: merged value order and expansion patterns are cached, hit-label safety checks are memoised, and the shell-path check no longer rescans the whole leaf per match.
- Cached metadata safety checks preserve the separate name, source, and plugin fallback labels when those fields contain the same protected text.
