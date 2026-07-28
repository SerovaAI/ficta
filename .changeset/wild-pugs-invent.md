---
"@serovaai/ficta": patch
---

Record restore-side counters per response. A run's metadata described what was redacted on the way up and nothing about what came back, so a restore that mangled a tool call left no trace unless raw body capture happened to be granted — which the CLI shim path never does. Each response that restores something now writes a `res-NNNN.restore.meta.json` sidecar next to its existing meta, carrying counts only (no values, no bodies), and so is written regardless of the trace-capture grant. It adds a `restoredIntoTools` count — values the policy spliced into a tool-call argument, the complement of the existing withheld count — because those restore one JSON context deeper than the response body and are the ones an escaping defect can corrupt. The same count is logged as `🔧 restored N value(s) into tool-call arguments` and exposed on the request scope as `restoredIntoToolsCount`.
