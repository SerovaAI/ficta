---
"@serovaai/ficta": minor
---

Add `ficta stats`, which totals protection stats across every logged session by agent, model, surface, label, and day (`--since`, `--json`). Stop protecting well-known runtime config env vars such as `NODE_ENV`, `AWS_REGION`, and `LANG`, whose ordinary-word values were being replaced throughout conversations.
