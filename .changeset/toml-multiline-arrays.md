---
"@serovaai/ficta": minor
---

Read `~/.ficta/config.toml` with a real TOML parser. Multi-line arrays (one managed-registry path per line) no longer collapse to the path `[`, which left the registry unloaded and was then written back as `paths = ["["]`. A config file that is not valid TOML now stops `ficta` with the parse error instead of silently dropping settings, and a configured managed-registry file that does not exist is reported as a registry source error, so `registry.require = true` blocks rather than reporting ready. If strict mode now blocks a launch, check `ficta doctor` for a stale managed-registry path.
