---
"@serovaai/ficta-engine": patch
---

Apply `restore_into_tools` to Codex freeform tools. A registry secret placed in a Responses `custom_tool_call` (`apply_patch`) or `local_shell_call`, or in a chat custom tool call, is now withheld under the default `detected` policy instead of being restored. This covers buffered bodies, streamed `custom_tool_call_input` deltas (including a token split across them), and replay events. The `response.function_call_arguments.done` and `response.custom_tool_call_input.done` events, which re-send the whole input, are withheld too. Restored values in freeform input are no longer JSON-escaped.
