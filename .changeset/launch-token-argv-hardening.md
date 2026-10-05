---
"@serovaai/ficta": patch
"@serovaai/ficta-protocol": patch
"@serovaai/ficta-engine": patch
---

Harden the per-launch proxy token and scope its guarantee accurately. Codex receives the token through an env-mapped `x-ficta-launch` header instead of its `base_url` command-line override, so the token value no longer appears in `ps`-visible argv (the proxy accepts the token via that header as well as the base-URL path, and sweeps it before forwarding upstream). The threat model now states plainly that the token stops a process that reaches the loopback port without inspecting the launched agent, not a same-user process that can read the agent's env/argv/config. Adds regression tests: token absent from Codex argv, header-based acceptance, and the token never written to the log directory.
