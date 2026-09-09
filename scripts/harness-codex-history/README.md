# Codex history transport regression

Run from the repository root after installing dependencies:

```sh
bun scripts/harness-codex-history/run.ts
```

The harness runs Atlas's bundled Codex 0.150.1 with a 128k context configuration
against a deterministic localhost Responses server. It uses a fresh temporary
Codex home and passes no authentication credentials to the child. The host must
permit launching the bundled executable and listening on localhost.

It builds more than 1.3 million characters of conversation from 42 completed tool
receipts, each smaller than 32 KiB. The native negative control must reject the
original aggregate `turn/start` input at the 1,048,576-character transport limit.
Atlas then supplies a bounded bootstrap and a private read-only history-source
tool. The complete authorized source stays available through paging instead of
being inserted into one oversized model request. Direct paging must reconstruct
every source part exactly. The mock model actively reads the complete first,
middle, and last receipts through real native dynamic-tool calls, following each
returned cursor. The middle receipt contains dense JSON-escaped control characters
and the last contains emoji, so the check also catches native output truncation.
After restarting Codex, the model must read an earlier source part again with the
same index from the current authorized snapshot. Historical application tools
must never execute during these reads.

The mock rejects requests over 512k text characters using the native
`context_length_exceeded` streaming error. It verifies bounded model inputs and
exact tool-result transport, not model reasoning quality or a tokenizer's capacity.
The output reports assertions and request counts; temporary state is removed.
No external provider, paid model, or production dashboard is used.

## References

- [Pinned Codex turn processor](https://github.com/openai/codex/blob/90854393966b21e9ebfd21b122334eb09a20c93d/codex-rs/app-server/src/request_processors/turn_processor.rs): the aggregate `turn/start` character ceiling.
- [Pinned Codex output truncation](https://github.com/openai/codex/blob/90854393966b21e9ebfd21b122334eb09a20c93d/codex-rs/core/src/context_manager/history.rs#L469): native tool outputs have a separate truncation budget. Source pages therefore bound serialized UTF-8 bytes and advance their cursor only by the text actually returned.
- [OpenClaw overflow recovery](https://github.com/openclaw/openclaw/blob/8642c68b6b9f6ee42fa91641dd8656fcf0a617a9/src/agents/embedded-agent-runner/run/overflow-context-recovery.ts): distinguishes transport payload limits from context overflow.
- [Hermes turn overflow recovery](https://github.com/NousResearch/hermes-agent/blob/ead7e91dabf1e963796ec834b196984a2fa44ff4/agent/turn_overflow.py): retries transport overflow only after measuring a smaller serialized request.
- [Hermes tool-result storage](https://github.com/NousResearch/hermes-agent/blob/ead7e91dabf1e963796ec834b196984a2fa44ff4/tools/tool_result_storage.py#L192-L255): bounded previews with access to the full source.

These references inform the separation of transport and model context limits and
the use of bounded previews with full-source access. Atlas uses its existing tool
bridge over an authorized in-memory snapshot; it does not copy either agent's
recovery implementation.
