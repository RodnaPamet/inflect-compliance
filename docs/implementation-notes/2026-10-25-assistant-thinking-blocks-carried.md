# 2026-10-25 — The assistant's loop carries thinking blocks

**Commit:** `<sha>` fix(assistant): carry thinking blocks between tool-loop turns

Step 2x of the roadmap in `docs/claude-tool-runner-design.md` (#4153). It is
independent of the phases.

## The defect

`buildMessages` rebuilt each assistant turn from the loop's provider-neutral
`text` and `toolCalls`, and in doing so dropped every `thinking` and
`redacted_thinking` block the API had returned.

On the Claude 5 models thinking is on by default. On Opus 5.5 it cannot be
turned off at all. Those blocks carry the model's reasoning, and on Opus 5.5
also the progress notes it writes between tool calls. The API expects them back
unchanged, in order. Nothing failed: the API accepts a turn without them. The
model simply lost its own reasoning at every tool call.

The rebuild had a second effect. It trimmed the text and put the blocks into
`[text, ...tool_use]` order. A replayed block is valid only while the system
prompt, the tools array and every earlier message are byte-identical to when it
was produced, so that rebuild could never have carried a block correctly anyway.

## Design

```
ProviderTurn.providerPart?: unknown          the loop carries it and never reads it
  └─ Anthropic: { kind: 'anthropic-content', content: <reply.content, as returned> }

runAssistantLoop   history.push({ role, text, toolCalls, ...providerPart-if-set })
buildMessages      assistant entry with an anthropic-content part → content verbatim
                   otherwise → rebuilt from text + toolCalls, exactly as before
```

The loop stays provider-neutral, as the owner decided in #3808. The part is
opaque, tagged with its kind, and only the provider that wrote it reads it.
History stays append-only. The system prompt and the tools array are the same
on every round trip, so nothing earlier in the request moves.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/ai/assistant/tool-loop.ts` | `providerPart` on `ProviderTurn` and on the history entry, carried when set |
| `src/app-layer/ai/assistant/turn-provider.ts` | `parseTurn` keeps the reply's content as the part, and `buildMessages` replays it |

## Decisions

- **The whole content is replayed, not only the thinking blocks.** If the
  thinking blocks were spliced back into a rebuilt turn, the text would still
  be trimmed and the blocks reordered. Replaying the content as returned is
  the only form that is byte-identical by construction.
- **There is no part when a `tool_use` block is unusable.** `parseTurn` drops a
  `tool_use` that has no id or name. Replaying it would name a call that the
  loop never dispatched and never answered, and the API rejects a `tool_use`
  with no `tool_result`. That turn is rebuilt from what was parsed, as before.
- **A part that is not tagged `anthropic-content` is ignored, and the turn is
  rebuilt.** A turn written by another provider is never sent to Anthropic as
  if it were Anthropic's.
- **The conditional spread is deliberate.** A provider that sets no part
  produces a history entry with exactly the keys it had before, not a
  `providerPart: undefined` key. The test pins the key list.
- **The design named three providers that do not exist.** The step's checklist
  asks for unchanged request bodies from "the openrouter, local and stub
  providers". The assistant's loop has one provider, `AnthropicAssistantProvider`.
  `assistantProviderFor` returns `null` for everything else, which hands the
  turn to the keyword router. The code wins. The control is a provider written
  for the test that sets no part, together with the two shapes `buildMessages`
  must still rebuild.
- **No `thinking` parameter is added.** It is omitted, which on these models
  means adaptive with display `omitted`. The returned blocks then carry
  signatures and empty text, so nothing more reaches the user. Choosing
  `display: "updates"` to show progress notes would be a product decision, and
  it is not part of this step.
- **No thinking text can reach a log, an audit row or the answer.** The part
  lives only in the loop's local history and in the next request body.
  `LoopResult` carries `text` (text blocks only), calls and usage. The
  sentinel test drives the real usecase, both through its happy path and
  through its one log line.
