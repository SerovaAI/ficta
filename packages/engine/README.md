# @serovaai/ficta-engine

The redaction engine behind [ficta](https://github.com/SerovaAI/ficta/tree/main/packages/ficta#readme),
as a library. It finds sensitive values in text (registered secrets, secret-shaped tokens, and PII via
the built-in regex floor or an optional Presidio/OpenMed sidecar), replaces them with deterministic
surrogate tokens, and restores the real values in text that comes back.

> **Experimental (0.x).** This package is the engine the ficta CLI and proxy run on, published so
> other services can use it in-process. Both of its APIs, the `createEngine` facade and the
> lower-level `ProtectionEngine`, may change in any minor release until 1.0.

## Install

```sh
npm install @serovaai/ficta-engine
```

Node.js 20 or newer (the optional `/sqlite` vault store needs 22.13 or newer). The package has no
runtime dependencies and never reads environment variables: everything is configured through the
object you pass in.

## Usage

`createEngine` is the entry point for in-process callers: named profiles, batch calls, keyed scopes
for reversible pseudonymisation, and one typed error whenever redaction cannot complete.

```ts
import { createEngine, RedactionUnavailableError } from "@serovaai/ficta-engine";
import { openSqliteVaultStore } from "@serovaai/ficta-engine/sqlite";

const engine = await createEngine({
  // Required: a stable, high-entropy secret (at least 32 bytes). The same key always mints the
  // same token for the same value, in every profile and every process.
  surrogateKey: process.env.MY_SURROGATE_KEY,
  surrogateStyle: "typed",
  vault: openSqliteVaultStore("/var/lib/my-service/ficta-vault.db", { encryptionKey: process.env.MY_VAULT_KEY }),
  presidio: { url: "http://127.0.0.1:5002" }, // optional
  detection: { entityPriority: ["za-id-number", "credit-card"] },
  profiles: {
    // One-way: these values are replaced by markers and can never be restored.
    rules: {
      entities: ["CREDIT_CARD", "ZA_ID_NUMBER", "US_BANK_NUMBER"],
      destroy: {
        categories: ["credit-card", "za-id-number", "us-bank-number", "password-label"],
        labels: { "password-label": "[REDACTED_SECRET]" },
      },
    },
    // Reversible: these values get tokens that restore within the same scope key.
    pseudonymise: { entities: ["PERSON", "ORGANIZATION", "EMAIL_ADDRESS"], secretShapes: false },
  },
  onWarn: (fields, message) => console.warn(message, fields),
});

try {
  const pass1 = await engine.redactMany(texts, "rules"); // stateless
  const scope = engine.scope("owner");
  const pass2 = await scope.pseudonymiseMany(pass1.texts, "pseudonymise"); // saved to the vault
  const preview = engine.truncate(pass2.texts[0], 400, { boundary: "word", ellipsis: "…" });
  // later, possibly in another process with the same keys and vault file:
  const { text, restoredCount, unknownCount } = await scope.restore(reply, { unknownToken: "[unknown]" });
} catch (err) {
  if (err instanceof RedactionUnavailableError) {
    // err.reason: "unreachable" | "timeout" | "http_error" | "bad_response" | "detector_error"
    //           | "store_error" | "internal_error"; err.detector and err.item when known.
    // Nothing from the failed call is usable: skip the work and report it.
  }
  throw err;
} finally {
  await engine.close(); // waits for background vault writes, then closes the vault store
}
```

- **Profiles.** Each profile chooses its detectors and dispositions: `pii` (default on: the regex
  floor, plus Presidio or OpenMed when configured), `entities` (an allowlist of entity types, sent
  to Presidio and applied to every PII backend's findings, the regex floor included, whose `email`
  counts as `EMAIL_ADDRESS`), `secretShapes` (default on), and `destroy` (see
  [Destroying values](#destroying-values-instead-of-surrogating-them)). All profiles share one
  surrogate key, token style and vault, so a value gets the same token whichever profile minted it.
  Malformed settings throw `InvalidEngineConfigError` from `createEngine`; naming a profile it was
  not given throws `UnknownProfileError`.
- **Always fail-closed.** There is no fail-open switch. If a detector cannot run (a sidecar is
  unreachable, times out, answers with an error or a malformed response, or a detector throws), or
  the vault store fails, the call throws `RedactionUnavailableError` and returns nothing. Batches are
  all or nothing: if any item fails, no text from the call is returned. Error messages carry the
  reason, the detector and the item index, never a value or any input text; `cause` keeps the
  underlying error. Fail-closed is about _availability_: it does not make detection complete (see
  below).
- **Batches.** `redactMany` and `pseudonymiseMany` redact one item at a time, with one detector
  call per item, so context in one text (a keyword near a number, say) never affects another.
- **`redactMany` is stateless.** Each item runs in a fresh scope and nothing is kept or written to
  the vault afterwards, so any tokens it emits cannot be restored. Use it for one-way passes, and not
  as the first of two passes when you need to restore roster names (see [Roster](#roster)).
- **Keyed scopes.** `engine.scope(key)` gives reversible pseudonymisation: each redaction saves its
  new mappings to the vault before returning, and a value found once stays redacted in that scope's
  later texts. `scope.restore` fetches tokens other processes minted, then restores; unknown tokens
  (pruned, forgotten, mangled or invented) are counted and, with `unknownToken`, replaced. See
  [Unknown tokens](#unknown-tokens). In a failed `pseudonymiseMany`, mappings for the items before
  the failing one may already be saved; their tokens were never returned.
- **Without a vault** mappings live in the engine's memory only (shared by its profiles) and are
  lost on `close()` or exit. With one, see [Persistent vaults](#persistent-vaults).
- **Paths.** Unlike the proxy's default, values inside path-like tokens are redacted too.
- **Truncation.** `engine.truncate(text, max, { boundary: "word", ellipsis })` never cuts a token or
  a destroy marker in half (see `truncateRedactedText`).
- **What it does not promise.** Detection is best-effort: a value no detector reports passes
  through unchanged, whichever profile runs. Destroy changes what happens to a value _once found_;
  it does not make finding it more likely.

### Roster

Detected names are never linked to each other: "Anna Berg" and "Anna" in the same text get unrelated
tokens, because deciding that they are the same person is guesswork that would also merge two
different Annas. Linked tokens come only from entities the application _registers_. Pass a roster of
known people and organisations to `createEngine`:

```ts
const engine = await createEngine({
  surrogateKey,
  profiles,
  roster: [
    { id: "c-1042", type: "person", canonical: "Anna Berg", forms: ["Anna", "anna.berg@example.com"] },
    { id: "o-7", type: "organization", canonical: "Northstar Biologics", forms: ["Northstar"] },
  ],
  // or a source: roster: { load: async () => myDirectory.rosterEntries() },
});

const { text } = await engine.scope("owner").pseudonymise("Anna Berg wrote; Anna replied.", "pseudonymise");
// "FICTA_PERSON_<E>_<S1> wrote; FICTA_PERSON_<E>_<S2> replied." — one entity tag, one surface tag each
engine.rosterFingerprint; // compare across processes to check they loaded the same roster
```

**The boundary.** The engine owns the mechanism; the application owns the data.

- _The engine_ validates entries, matches every canonical name and form exactly before detection, in
  every profile, derives linked tokens, runs the fail-closed leak check over them, and exposes a
  fingerprint. It never knows where entries come from.
- _The application_ owns where entries come from (a directory, contacts, attendee lists), how they are
  stored and refreshed, how duplicates are merged, and keeping every process on the same roster
  (compare `rosterFingerprint`). The roster is sensitive: it stays with the application. The engine
  holds it in memory only and never writes it to the vault store.

**Matching.**

- `canonical` is matched case-insensitively (exact-case when it contains a digit) and
  whitespace-flexibly anywhere in the text; `forms` (short names, nicknames, email addresses) are matched the same way but only at
  word boundaries, so a form `Anna` leaves "Annabel" alone. Forms are trimmed and deduplicated, and a
  form equal to the canonical name is dropped. Canonical names and forms need at least 2 characters.
- Roster matches are registered values: they keep their surrogate even in a profile that destroys
  the detector category they would fall under, and if one survives redaction the call throws
  `RedactionUnavailableError("internal_error")`.
- A name that is not in the roster is still found by detection (best-effort) and gets its own,
  unlinked token.

**Tokens.** In a keyed scope a roster match becomes `FICTA_PERSON_<entity>_<surface>` or
`FICTA_ORG_<entity>_<surface>`. The entity tag depends only on the surrogate key, the scope key and
the entry's `id`; the surface tag adds the exact matched text. Roster order and the other entries
never affect a token, so adding an entry does not change existing tokens; changing an entry's `id`
does. Entity tags differ between scope keys. Within a scope, a surface matched once keeps its
linked token and its word boundary on every later text, including after a restart or in another
process on the same vault store, and even after its entry has left the roster.

**Not with `redactMany`.** `redactMany` is stateless and has no scope key, so it does not render
entity families: roster matches there get ordinary unlinked tokens (`FICTA_PERSON_<hex>` in the typed
style) that, like everything `redactMany` emits, cannot be restored. They are never left in the text
and never destroyed, but a later keyed pass never sees the names, so restoring its output yields
unknown tokens where the names were. That is almost always a pipeline mistake, so the first time it
happens `onWarn` reports it (profile name and item count only), and each such hit carries
`roster: true`. Run any pass whose output must restore in a keyed scope, as below.

**Two passes with a roster.** To destroy everything a detector finds in a first pass and still get
linked, restorable roster tokens, run the destroy pass in the keyed scope with `categories: "*"`:

```ts
const engine = await createEngine({
  surrogateKey,
  vault,
  roster,
  profiles: {
    // Every detector finding becomes a marker, whatever its category (including ones a backend adds
    // later); only roster names become tokens, so they are the only mappings ever written to the vault.
    rules: { destroy: { categories: "*", labels: { "password-label": "[REDACTED_SECRET]" } } },
    pseudonymise: { entities: ["PERSON", "ORGANIZATION", "EMAIL_ADDRESS"], secretShapes: false },
  },
});
const scope = engine.scope("owner");
const pass1 = await scope.pseudonymiseMany(texts, "rules");
const pass2 = await scope.pseudonymiseMany(pass1.texts, "pseudonymise");
```

With an explicit category list instead of `"*"`, a finding in a category the list does not name
keeps a reversible token and is saved to the vault in a keyed scope; `"*"` rules that out.

**Validation.** `createEngine` throws `InvalidEngineConfigError` for a missing or duplicate `id`, an
unknown `type`, a missing or too-short canonical name or form, or a canonical name that another entry
also claims (as its canonical name or as a form): merge or disambiguate those entries first. Messages
name entry indexes, never ids or values.

**Ambiguous forms.** A form claimed by more than one entry (compared case-insensitively) is linked to
none of them, but it stays registered: it is matched exactly, as a whole word, and gets its own
unlinked token, so sharing a form never leaves it to detection. `rosterAmbiguousForms` counts it,
and `onWarn` reports the count, never the value. Within a keyed scope, a mention that already got a
linked token before the form became ambiguous still restores; later mentions get the unlinked token.

**Persistence and reload.** Mappings minted from the roster in keyed scopes are saved to the vault
store like any other (encrypted, as the registry layer), so a token keeps restoring after its entry
leaves the roster. The roster is loaded once, by `createEngine`; to pick up a changed roster, create a
new engine.

### Lower-level API: `ProtectionEngine`

The facade is built on `ProtectionEngine`, which the ficta proxy uses directly. Reach for it when
you need registered exact-match values, JSON bodies, streaming restore, or fail-open detection.

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
- **Restore with counts.** `restoreTextDetailed(text, { unknownToken })` (on the engine and on any
  scope) returns `{ text, restoredCount, unknownCount }`. See [Unknown tokens](#unknown-tokens).
- **Detector outages.** By default a detector that cannot run (for example an unreachable Presidio
  sidecar) is skipped and the text is redacted by the rest. Set `detection: { failClosed: true }` to
  make an outage throw `DetectorUnavailableError` instead.

## Unknown tokens

Restore is exact-match: a token restores only if the vault maps it, byte for byte. A model can echo a
token it was never given, or change one on the way back (a case change, an inserted space, a dropped
character, a wildcard such as `FICTA_ORG_<tag>_*` standing for a whole entity family). `restoreText`
leaves such strings in the text as they are. `restoreTextDetailed` reports them and can replace them:

```ts
const { text, restoredCount, unknownCount } = scope.restoreTextDetailed(modelOutput, {
  unknownToken: "[unrestored]",
});
```

- **What counts as unknown.** Any token-shaped string the vault does not map: unmapped opaque, typed
  and entity-family tokens, entity wildcard references and truncated entity fragments, and tokens
  whose case changed, that lost or gained characters, or that one whitespace character split in
  two. Prose that merely mentions the prefix (`FICTA_SURROGATE_KEY`) is not a token.
- **Never decoded.** An unknown token is never mapped to a value, however close it is to a known one.
  A near-miss restoring the wrong value would be worse than not restoring.
- **Replacement is opt-in.** Without `unknownToken` the returned text is exactly what `restoreText`
  returns; only the counts are added. The placeholder must be non-empty and must not contain
  `FICTA_` (any case), so it can never be read back as a token; otherwise the call throws a
  `TypeError`. Error messages and counts never include a token or a value.
- **Counts** are occurrences in this call: `restoredCount` mapped tokens replaced by their value,
  `unknownCount` unknown tokens.
- **Markers are not tokens.** Destroy markers (`[REDACTED_…]`) and text inside restore markers are
  left as they are and never counted.
- **Persistent vaults.** With a [vault store](#persistent-vaults), "unknown" means not in this
  process's memory. Call `await scope.prepareRestore(text)` first so that tokens another process
  minted are fetched; a token whose entry was pruned or forgotten then counts as unknown.
- **Wire restores.** `restoreText`, `restoreJson`, `restoreStream` and `restoreEventStream` also
  accept `{ unknownToken }`. Streaming restores reassemble split references before replacing them.
  Known tokens withheld from tool arguments stay intact. Without this option, unknown references
  still pass through unchanged; `residualSurrogateCount` reports distinct unknown references.

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
- **Everything: `categories: "*"`** destroys every detector finding, whatever its category, so a
  category a detector or backend starts reporting later is destroyed too rather than surrogated.
  Each finding gets its category's default marker (`[REDACTED]` if the name would not make a safe
  one); `labels` may still override any category. `"*"` cannot be combined with category names.
  Registered values (including a facade roster) still keep their surrogates.
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
  `restoreText` unchanged; `restoreTextDetailed` counts it as unknown and can replace it.
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

### Shared profile configuration

`profileEngineConfig(profile, sharedSettings)` maps a library profile to the same `EngineConfig`
used by the proxy. It retains the library defaults: PII and secret shapes on, path redaction on,
and detector outages fail-closed. Transport adapters may choose different defaults explicitly.
`buildRoster(entries, surrogateKey)` exports the roster validation mechanism for registry adapters;
applications still own roster storage and refresh.
