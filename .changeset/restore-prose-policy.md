---
"@serovaai/ficta": minor
"@serovaai/ficta-protocol": minor
"@serovaai/ficta-engine": minor
---

Add `restore_prose` / `FICTA_RESTORE_PROSE`, the restore-into-tools policy's analogue for assistant prose. It defaults to `all` (no behavior change — registered secrets round-trip into the model's reply as before, since prose is ficta's core restore surface). High-assurance deployments can opt into withholding: `detected` keeps locally-read detected content but renders registry/env secrets the model only ever saw as placeholders as `[ficta:withheld]`, and `none` withholds every mapped value from prose. This closes the prose + transcript-echo rehydration path for deployments that choose it, without disabling the default round-trip. Tool-call arguments remain governed separately by `restore_into_tools`.
