---
"@serovaai/ficta": minor
"@serovaai/ficta-protocol": minor
---

Country-scoped Presidio registry. The shipped recognizer config (renamed
`presidio/default_recognizers.za.yaml` → `presidio/default_recognizers.yaml`) is now fully
country-tagged, and the sidecar's `FICTA_PRESIDIO_SUPPORTED_COUNTRIES` env var (default `za,us,mu`,
the SA-legal reference profile) decides at load time which country-specific recognizers run;
locale-agnostic recognizers always load. Notably, the UK NHS recognizer no longer runs on default
traffic (it false-positives on ~10% of arbitrary 10-digit numbers, e.g. ZA phone and account
numbers) — add `uk` to the country scope for UK-matter deployments. `FICTA_PII_PRESIDIO_ENTITIES`
is now a pure optional narrowing allowlist: when unset, `/analyze` requests omit the `entities`
field and the deployment's loaded registry is the detection surface. The proxy also now strips
every inbound `x-ficta-*` header before forwarding upstream, instead of enumerating known ones.
