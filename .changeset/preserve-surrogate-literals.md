---
"@serovaai/ficta": patch
---

Add an opt-in `FICTA_PRESERVE_LITERALS` mode that injects a system/developer instruction carrying the exact surrogate tokens present in each outbound request, telling the model to reproduce them verbatim. This improves restore reliability: models otherwise truncate or editorialise long opaque tokens (`FICTA_62a02923…`), which leaves them unrestorable. The instruction only ever adds surrogate tokens the proxy already minted (never raw values) and runs after the fail-closed leak gate.
