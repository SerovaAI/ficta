---
"@serovaai/ficta": patch
---

Fix secret-shape detection corrupting JSON protocol keys. The `secret-json-value` pattern ran over
body string-leaves joined with `\n`, where a non-string value emits no leaf — so in a body like
`{"max_tokens": 64000, "output_config": {...}}` the two keys became adjacent and the protocol key
`output_config` was registered as a "secret" and rewritten to a `FICTA_` placeholder everywhere,
including the JSON key itself. Upstream then rejected the request (`400 output_config: Extra inputs
are not permitted`), and because the registration persists in the proxy's vault, one affected
sub-request (Claude Code attaches `output_config` to its 5-family web-tool calls) poisoned every
later request in the session. JSON key→value secrets are now detected structurally — a key is
paired with its own value (or direct array elements) by leaf path via a new `detectBodyLeaves`
plugin hook — and the structural detection view is joined with a U+0000 boundary that no pattern
can match across, which also stops `secret-assignment` matches from crossing out of a content
string into a following key (e.g. a message ending in `auth:`). Detection of real secrets under
secret-ish keys (`api_key`, nested, arrays) and inside multi-line string content is unchanged.
