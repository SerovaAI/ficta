---
"@serovaai/ficta": minor
---

Add an opt-in `FICTA_DEV_TRACE=1` (`[logging] dev_trace`) debug switch: agent launches capture a full trace of every request (raw and restored bodies, protected-value audit sidecars) into their instance log dir and write a debug `ficta.log` without touching the agent's terminal. `ficta doctor` warns while it is on.
