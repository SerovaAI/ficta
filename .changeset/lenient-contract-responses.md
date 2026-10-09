---
"@serovaai/ficta-contract": minor
---

Response schemas no longer reject unknown fields, so an older client keeps working when a newer engine adds response fields; breaking changes still bump the control protocol version. Config-edit and trace-capture request inputs stay strict.
