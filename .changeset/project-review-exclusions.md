---
"@serovaai/ficta": minor
---

`ficta review` now saves exclusions per project by default, in the user-local `~/.ficta/projects.json` keyed by the project root (the nearest ancestor holding `.git`). Agent launches inside that project apply that list on top of the global one. `ficta review --global` edits the global `registry.exclude_names` as before. `ficta doctor` shows the current project, and the startup banner and doctor list project exclusions separately. The project list is never read from a file inside the repository.
