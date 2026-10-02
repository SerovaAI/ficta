---
"@serovaai/ficta-engine": minor
---

Library roster: `createEngine({ roster })` takes known people and organisations (`RosterEntry` / `RosterSource`), matches them exactly before detection in every profile, links each entry's surfaces under one `FICTA_PERSON|ORG_<entity>_<surface>` family in keyed scopes, drops forms claimed by more than one entry, and exposes `rosterFingerprint` so processes can check they loaded the same roster.
