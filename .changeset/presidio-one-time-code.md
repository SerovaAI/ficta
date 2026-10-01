---
"@serovaai/ficta": patch
---

The bundled Presidio registry now detects one-time codes (`ONE_TIME_CODE`, typed surrogate `FICTA_OTP_…`): 4–8 digit codes next to an OTP, 2FA, PIN, passcode or verification label in English, or a Bestätigungscode, Einmalcode, Einmalpasswort, Sicherheitscode, TAN or "Code lautet" label in German. A bare "code" only counts in OTP phrasing, so statute, postal and branch-code numbers stay visible.
