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

Node.js 20 or newer. The package has no runtime dependencies and never reads environment variables:
everything is configured through the object you pass in.

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
  requires the original mappings, or registered `values` reloaded into the new engine. Persistent
  vault storage is not part of this package yet.
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
  surrogate category, it is destroyed. Overlapping findings resolve exactly as they do for
  surrogates (registry first, then confidence, then span length); whatever part a destroy finding
  wins is destroyed. A 13-digit national ID that is also Luhn-valid can be reported as a card, so a
  profile that destroys the ID usually destroys `credit-card` too.

What destroy does **not** change: it is about what happens to a value _once found_. Detection stays
best-effort, so a value no detector reports passes through unchanged. Destroyed values are not part
of the fail-closed exact-match promise, which covers registered values only.

## Security model

What the engine does and does not protect against is described in ficta's
[threat model](https://github.com/SerovaAI/ficta/blob/main/packages/ficta/docs/threat-model.md).

## License

MIT
