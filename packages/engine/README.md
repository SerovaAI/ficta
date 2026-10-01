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

## Security model

What the engine does and does not protect against is described in ficta's
[threat model](https://github.com/SerovaAI/ficta/blob/main/packages/ficta/docs/threat-model.md).

## License

MIT
