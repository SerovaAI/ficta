---
"@serovaai/ficta": patch
"@serovaai/ficta-protocol": patch
"@serovaai/ficta-engine": patch
---

Proxy: never edit a caller's string Anthropic `system` prompt when adding the literal-preservation instruction. The prompt now stays verbatim as its own first block, with the instruction in a second block. Previously the instruction was appended to the string, which broke subscription (OAuth) requests that must carry the exact Agent SDK prompt (such as the Claude Code security-review hook): api.anthropic.com answered every retry with a bare `429 rate_limit_error "Error"`.
