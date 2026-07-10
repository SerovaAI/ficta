---
"@serovaai/ficta": patch
---

Scope trace-mode restore-highlight markers to assistant output. The highlight triple (the gateway's show/hide toggle format) now rides only on streamed text fragments and their sibling fields; metadata/replay events that echo the request back (`response.created` / `response.in_progress` `instructions`) restore plainly — surrogates still never reach the client, but the echoed preamble is no longer littered with marker sentinels.
