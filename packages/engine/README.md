# @serovaai/ficta-engine

The redaction engine behind [ficta](https://github.com/SerovaAI/ficta/tree/main/packages/ficta#readme),
as a library. It finds sensitive values in text (registered secrets, secret-shaped tokens, and PII via
the built-in regex floor or an optional Presidio/OpenMed sidecar), replaces them with deterministic
surrogate tokens, and restores the real values in text that comes back.

> **Experimental (0.x).** This package is the engine the ficta CLI and proxy run on, published so
> other services can use it in-process. Its API may change in any minor release until 1.0. A smaller
> library-facing facade (batch redaction, an explicit "redaction unavailable" error, restore with
> counts) is planned; until then the entry point is `ProtectionEngine`.

## Install

```sh
npm install @serovaai/ficta-engine
```

Node.js 20 or newer (the optional `/sqlite` vault store needs 22.13 or newer). The package has no
runtime dependencies and never reads environment variables: everything is configured through the
object you pass in.

## Usage

```ts
import { ProtectionEngine } from "@serovaai/ficta-engine";

const engine = new ProtectionEngine({
  config: {
    // Required: a stable, high-entropy secret (at least 32 bytes). The same key always mints the
    // same surrogate for the same value.
    surrogate: { key: process.env.MY_SURROGATE_KEY, style: "typed" },
    pii: { enabled: true },
  },
  onWarn: (fields, message) => console.warn(message, fields),
});

const { text } = await engine.redactContentDetailed("Email alice@example.com about the invoice.");
// "Email FICTA_EMAIL_… about the invoice."

engine.restoreText(text);
// "Email alice@example.com about the invoice."
```

- **Surrogate key.** Construction throws `MissingSurrogateKeyError` without `config.surrogate.key`.
  Pass `allowEphemeralKey: true` only if surrogates never need to outlive the process: the key is
  then random per process, so tokens change on every restart.
- **Restore needs the mappings, not just the key.** A stable key keeps surrogates _consistent_: the
  same value gets the same token in every process. It does not make old tokens restorable on its
  own. Detected values (PII, secret shapes) live in the engine's in-memory vault, so a fresh engine
  with the same key cannot restore a token for a value it has not seen. Restoring after a restart
  requires the original mappings, or registered `values` reloaded into the new engine. To keep
  keyed scopes' mappings across processes and restarts, attach a
  [persistent vault](#persistent-vaults).
- **Detectors.** Without a `plugins` option the engine runs the built-in detectors
  (`defaultDetectors`: secret shapes, on by default, and PII, off unless `pii.enabled`). Pass
  `values` to protect exact registered values.
- **Content vs. headers.** `redactContentDetailed` treats a string as message content, so every
  detector runs on it, including an out-of-process NER backend. `redactTextDetailed` is the
  header/query path, where NER does not run. `redactBodyDetailed` takes a JSON request body.
- **Scopes.** `engine.beginRequest(scopeKey?)` opens a scope whose detected values are restored only
  within that scope (or, with a key, within that key's scopes).
- **Detector outages.** By default a detector that cannot run (for example an unreachable Presidio
  sidecar) is skipped and the text is redacted by the rest. Set `detection: { failClosed: true }` to
  make an outage throw `DetectorUnavailableError` instead.

## Destroying values instead of surrogating them

Some values should never come back: a one-time code, a card number, a password typed into a message.
Configure their detection categories to be _destroyed_ and the engine replaces them with a fixed
marker instead of a reversible surrogate:

```ts
const engine = new ProtectionEngine({
  config: {
    surrogate: { key: process.env.MY_SURROGATE_KEY },
    pii: { enabled: true },
    dispositions: {
      destroy: {
        categories: ["credit-card", "password-label", "secret-assignment"],
        // Optional. Default marker: [REDACTED_<CATEGORY>], e.g. [REDACTED_CREDIT_CARD].
        labels: { "password-label": "[REDACTED_SECRET]", "secret-assignment": "[REDACTED_SECRET]" },
      },
    },
  },
});

const result = await engine.redactContentDetailed("Card 4111 1111 1111 1111, password: hunter2!");
// result.text: "Card [REDACTED_CREDIT_CARD], password: [REDACTED_SECRET]"
// result.destroyed: 2; result.hits carry the category and disposition: "destroy", never the value
```

- **Categories** are the detector category names reported as `hits[].name`: lowercase and hyphenated.
  The built-in detectors emit `email`, `us-ssn` and `credit-card` (regex floor); Presidio and OpenMed
  entity types converted the same way (`PHONE_NUMBER` → `phone-number`, `PERSON` → `person`); and the
  secret-shape categories (`secret-assignment`, `password-label`, `secret-json-value`, `secret-header`,
  `opaque-secret`, `credential-url`, `jwt`, `private-key`, and the vendor key names such as
  `github-token`). Category names in the config are matched case-insensitively, with `_` read as `-`.
- **Labels** must be a bracketed marker of 1–64 letters, digits or `_ . : -` (`[REDACTED_CARD]`) and
  can never be a `FICTA_` token. Several categories may share a label. Invalid config throws
  `InvalidEngineConfigError` at construction.
- **Irreversible.** A destroyed value is never stored: not in the vault, the scope metadata, or a
  keyed scope. `restoreText` and the streaming restores leave markers as they are, and they are
  not counted as unrestored surrogates. Because nothing is retained, a keyed scope re-runs detection
  on any re-sent content that held a destroyed value instead of skipping it as already swept.
- **Deterministic and idempotent.** The same input gives the same output, and redacting the output
  again changes nothing: detector findings that overlap an existing marker are clipped off it.
  Surrogate tokens from another pass are left untouched.
- **Registered values win.** An exact registered value (or one passed to
  `scope.registerProtectedValues`) keeps its surrogate and the fail-closed leak check, even when a
  detector also reports it in a destroy category. Destroy applies to detector findings only.
- **Several categories, one value.** When one value is reported under a destroy category and a
  surrogate category, it is destroyed, whichever detector reported it first. Partly overlapping
  findings resolve exactly as they do for surrogates (registry first, then confidence, then span
  length); whatever part a destroy finding wins is destroyed. Destroying an ID category is enough
  for a Luhn-valid 13-digit ID that a card detector also matched; there is no need to destroy
  `credit-card` as well (see [Category priority](#category-priority)).

## Category priority

Detectors can disagree about what a value is. A South African ID number is 13 digits ending in a
Luhn check digit, so the regex floor's `credit-card` pattern (and Presidio's card recogniser) accept
it too. To make the more specific reading win, list categories highest first:

```ts
const engine = new ProtectionEngine({
  config: {
    pii: { enabled: true, backends: ["presidio"] },
    detection: { entityPriority: ["za-id-number", "credit-card"] },
  },
});
// "ID <valid 13-digit ID>" → "ID FICTA_ID_…" (typed style), reported as za-id-number
```

- Applies when one value is reported under several categories, whichever detector, backend or
  response order produced them. A value only one detector reports keeps that detector's category, so
  a card-shaped number that is not a valid ID (an impossible date, say) stays `credit-card`.
- A destroy category still beats a surrogate one; the list orders the rest. Unlisted categories rank
  after listed ones and fall back to confidence, then a configured backend over the regex floor.
- Names follow the destroy-category rules (case-insensitive, `_` read as `-`); a malformed name
  throws `InvalidEngineConfigError`. The default is empty: no category outranks another.
- The engine ships no country rules of its own. The reference Presidio sidecar already drops the
  `CREDIT_CARD` result when `ZA_ID_NUMBER` validated exactly the same span, so with it the ID wins
  even without a priority list; the list makes the outcome independent of which detectors run.

What destroy does **not** change: it is about what happens to a value _once found_. Detection stays
best-effort, so a value no detector reports passes through unchanged. Destroyed values are not part
of the fail-closed exact-match promise, which covers registered values only.

## Persistent vaults

By default every mapping lives in memory and dies with the process. Pass a `VaultStore` as `vault`
and each keyed scope (`engine.beginRequest(scopeKey)`) persists its value↔token mappings, encrypted,
so that another process with the same surrogate key and scope key can restore its tokens, and a
restart loses nothing. The motivating case is a batch job and a long-running service sharing one
vault on one machine: the job pseudonymises, the service restores.

The package ships one store, on Node's built-in SQLite, as a separate entry point:

```ts
import { ProtectionEngine } from "@serovaai/ficta-engine";
import { openSqliteVaultStore } from "@serovaai/ficta-engine/sqlite";

const vault = openSqliteVaultStore("/var/lib/my-service/ficta-vault.db", {
  // 32 random bytes: 64 hex characters, base64, or a Uint8Array. NOT the surrogate key.
  encryptionKey: process.env.MY_VAULT_KEY,
});
const engine = new ProtectionEngine({ config: { surrogate: { key: process.env.MY_SURROGATE_KEY } }, vault });

// Process A: pseudonymise. Redaction saves new mappings before it returns.
const { text } = await engine.beginRequest("org:thread-1").redactContentDetailed(input);

// Process B (same keys, same file): restore A's tokens.
const scope = engine.beginRequest("org:thread-1");
await scope.prepareRestore(text); // loads the scope, then fetches any token not yet in memory
scope.restoreText(text);

// Shutdown.
await engine.flushVault();
await vault.close();
```

- **What is persisted.** For each keyed scope: the detected and registry-derived mappings (value,
  token, the category it was minted under, matching flags, detection labels) and entity-family
  tokens with their entity id, so the per-scope entity-tag collision check survives a restart.
  Values destroyed by a [destroy disposition](#destroying-values-instead-of-surrogating-them) are
  never stored. Unkeyed scopes, registered `values`, and values passed to `registerProtectedValues`
  are not persisted (the first are per-request; the others are re-supplied by the caller). The
  per-scope "already swept" leaf hashes are not persisted either, so a new process re-runs detection
  once on content it has not seen.
- **Sync and async.** Redaction is already async: a keyed scope loads its stored mappings on first
  use, and every redaction appends its new mappings before returning. If the store fails, redaction
  throws `VaultStoreError` rather than hand back tokens no other process could restore. The restore
  methods stay synchronous and work on memory, so in a process that has not redacted for that scope,
  call `await scope.hydrate()` or `await scope.prepareRestore(text)` first. `prepareRestore` also
  fetches tokens another process minted after this one loaded. Restores record each token's last
  use in the background; `engine.flushVault()` waits for those writes. Without a `vault` nothing
  changes: `hydrate` and `prepareRestore` are no-ops.
- **Same keys required.** A store needs a configured surrogate key (`MissingSurrogateKeyError`
  otherwise). Stored tokens that the current key and style would not mint again (the key or style
  changed) stay restorable but are never used to redact new text, and a warning is reported.
- **Encryption.** Values, and everything derived from them, are encrypted with AES-256-GCM under a
  key derived from `encryptionKey`, with a random 12-byte IV per entry. Each ciphertext is bound to
  its scope key, layer, token, and format version as additional authenticated data, so a row moved
  or copied elsewhere fails to decrypt. Tokens, scope keys, timestamps, and the layer are stored in
  clear: tokens are what already leaves the machine, and the store looks rows up by them. A keyed
  HMAC of each value (under a second derived key, never the surrogate key) lets `forget(value)` find
  rows without storing the value. Opening a vault with the wrong key throws `VaultKeyMismatchError`;
  a malformed key throws `InvalidVaultKeyError`.
- **Key handling.** Protect the encryption key like the surrogate key: anyone with the vault file
  and the encryption key can read every stored value. Keep the two keys separate, out of the
  repository, and out of the vault file's directory. Losing the encryption key makes the vault
  unreadable; changing the surrogate key makes stored tokens restore-only.
- **Retention.** The store is add-only. `prune({ notUsedSince })` deletes entries whose tokens have
  not been emitted or restored since a date, and `forget(value, { scope? })` deletes every entry for
  one exact value. Both act on the file; an engine that already holds the mapping in memory keeps it
  until that scope is evicted or the process restarts. A pruned or forgotten token passes through
  restore unchanged.
- **Other backends.** `VaultStore` is a small async interface (`load`, `lookup`, `append`, `touch`,
  `prune`, `forget`, `close`) in domain terms. `VaultCipher` from the main entry gives any backend the
  same sealing as the SQLite store.

### SQLite store

`@serovaai/ficta-engine/sqlite` needs Node.js 22.13 or newer (`node:sqlite` without a flag); Node 24
LTS is recommended. Node releases before 24.15 / 25.7 (where `node:sqlite` became a release
candidate) print an experimental-feature warning for it. The main
`@serovaai/ficta-engine` entry never imports it, so it still loads on Node 20. There is no native
module and no npm dependency.

- Every connection uses WAL journaling, `foreign_keys=ON`, and a `busy_timeout` (default 5000 ms,
  `busyTimeoutMs` to change). Readers never block; writes are short `BEGIN IMMEDIATE` transactions
  that wait their turn, so several processes can share one file at modest write rates.
- Keep the file on a local disk. WAL needs shared memory between processes, which network
  filesystems (NFS, SMB) do not reliably provide.
- Back up with the SQLite backup API (`sqlite3 vault.db ".backup copy.db"`), or copy the `-wal` and
  `-shm` files together with the database while no process is writing. Copying the main file alone
  can lose recent writes.
- The schema is versioned with `PRAGMA user_version`; a file from a newer engine is refused with
  `VaultSchemaError`.

## Security model

What the engine does and does not protect against is described in ficta's
[threat model](https://github.com/SerovaAI/ficta/blob/main/packages/ficta/docs/threat-model.md).

## License

MIT
