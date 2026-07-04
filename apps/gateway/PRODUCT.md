# Product

## Register

product

## Users

End users inside a company who use the web UI to chat with an LLM while working with internal or sensitive context. They are not managing redaction infrastructure directly in the chat flow; they need a familiar chat experience that makes the protection posture visible enough to trust.

## Product Purpose

Ficta Gateway provides a company-facing LLM chat surface routed through the ficta redaction proxy. It lets users ask questions, paste or attach supported text content, choose available models, and keep chat history while registered secrets and best-effort detected PII are tokenized before reaching the model provider and restored in responses. Success means users can work naturally with LLMs without needing to reason about every proxy detail, while still understanding when protection is active or degraded.

## Brand Personality

Trustworthy and precise. The interface should feel calm, direct, and operationally honest: it explains protection limits plainly, treats warnings as workflow-critical, and avoids theatrical security cues.

## Anti-references

Avoid flashy AI SaaS styling, cybersecurity theater, and cluttered enterprise dashboards. The UI should not feel like a marketing demo, a dark hacker console, or an over-branded admin suite. Avoid decorative effects that compete with the chat task or imply stronger security guarantees than the product can make.

## Design Principles

- Keep the chat task first: model choice, protection status, history, settings, and attachments support the conversation instead of competing with it.
- Make protection legible, not dramatic: status, warnings, and limitations should be visible, specific, and calm.
- Preserve familiar product affordances: standard chat, sidebar, dialogs, inputs, and menus should behave predictably.
- Be explicit about limits: unsupported document uploads, fail-open/fail-closed posture, and best-effort PII detection need plain copy and actionable next steps.
- Favor quiet precision over decoration: density, alignment, iconography, and copy should help users scan and decide quickly.

## Accessibility & Inclusion

Target WCAG AA. Preserve keyboard access and visible focus states across chat, sidebar, dialogs, menus, file controls, and settings. Respect reduced-motion preferences. Do not rely on color alone for protection, warning, error, loading, or selected states; pair semantic color with text, iconography, or shape.
