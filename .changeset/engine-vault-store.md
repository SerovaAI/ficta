---
"@serovaai/ficta-engine": minor
---

Engine: persistent, encrypted vault for keyed scopes. Pass a `VaultStore` as `vault` and keyed scopes persist their value↔token mappings, so another process with the same surrogate and scope key can restore them and restarts lose nothing; values are encrypted with AES-256-GCM under a separate caller-supplied key, bound to their scope and token. New `@serovaai/ficta-engine/sqlite` entry (`openSqliteVaultStore`, Node >= 22.13) on built-in `node:sqlite` with WAL and a busy timeout, plus `prune` by last use and `forget(value)`. Scopes gain `hydrate()` and `prepareRestore(text)`; destroyed values are never stored. The main entry still loads on Node 20. Threat model updated: the CLI keeps mappings in memory; an embedding with a vault store writes encrypted mappings to disk.
