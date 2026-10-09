---
"@serovaai/ficta": patch
---

Mark stale or spent protection-ticket 409 responses with `x-should-retry: false` so OpenAI and Anthropic SDK clients don't replay a single-use ticket.
