---
"@serovaai/ficta": minor
---

Defend the local proxy against web pages. The proxy now refuses a request whose `Host` header is not an IP literal, a loopback name, or a name in the new `FICTA_ALLOWED_HOSTS`, which blocks DNS rebinding. Its `/__ficta/*` control routes also refuse any request carrying browser provenance (`Origin`, or a cross-site `Sec-Fetch-Site`). Before this, a page could rewrite `config.toml` through `PATCH /__ficta/config` on the standalone proxy (for example setting `fail_closed = false`), toggle trace capture, or trigger a registry reload. If you reach the proxy by a DNS name other than `localhost`, add it to `FICTA_ALLOWED_HOSTS`.
