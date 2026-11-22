# In-product assistant

The assistant answers questions about a tenant's compliance records in a sheet
any workspace page can open (`src/components/assistant/AssistantLauncher.tsx`,
`AssistantSheet.tsx`). It reads through the same tools agents use, and it never
changes anything itself: an action it is asked for becomes a pending proposal in
the agent-proposal queue, which a person approves. The orchestration is
`src/app-layer/usecases/assistant.ts`; the parts it is built from are in
`src/app-layer/ai/assistant/`.

## Entry points and gates

| Route | Answers |
|---|---|
| `POST /api/t/:slug/assistant/ask` | One answer as JSON |
| `POST /api/t/:slug/assistant/stream` | The same turn as a server-sent event stream |

Both routes take `controls.view`, and a turn then passes, in order:

1. **The feature gate** (`enforceFeatureGate(ctx, 'assistant')`): the global
   `AI_RISK_ENABLED` switch, `AI_ASSISTANT_ENABLED`, the write tier (Editor,
   Admin or Owner), the tenant's own AI toggles, and the plan named by
   `AI_RISK_PLAN_REQUIRED` when one is set. The launcher is not rendered when
   either deployment switch is off.
2. **The rate limit** (`checkRateLimit`): a per-user burst limit
   (`AI_RISK_USER_RPM`, 5 a minute by default) and a daily quota per tenant
   (`AI_RISK_DAILY_QUOTA`, 50 by default), shared with the other AI features. `spend-ceiling.ts` derives the worst-case token cost this admits
   from the live constants; it is a statement of the bound, not a limiter.
3. **The input guard** over the question and every earlier turn (below).

A stream also takes a slot: at most 4 open streams per tenant and 32 in all, per
Node process (`stream-capacity.ts`), because a stream holds a connection in the
same process as the notifications stream.

## The turn

A turn is a bounded tool-use loop (`tool-loop.ts`): at most 6 model calls, 24
tool calls, 60 seconds and 24,000 bytes of tool results (`DEFAULT_LOOP_BOUNDS`),
and a halted turn says which bound stopped it. The model is chosen by the
tenant's residency posture (`resolveFlueModel`): a `LOCAL_ONLY` tenant, or a
deployment with no tool-use model configured, gets the deterministic keyword
router and no model call. `turn-provider.ts` re-checks the provider before it
opens a socket and refuses a specifier addressed elsewhere. The system prompt
carries a scope rule: answer about the tenant's records, general compliance and
regulatory questions and the product, and decline anything else briefly
(#5590).

**Tools are the asker's own.** `tools.ts` adapts the MCP read and propose
surfaces through `flueToolsFor`, filtered by the acting context's permission
keys, so the assistant is offered exactly the tools its asker could call and
cannot out-read them. It inherits the review latch: once a tool result needs
review, every later tool on either surface does. The propose tools put a
finding, a risk or a process map ([`PROCESS_MAP`](./processes-canvas.md#proposed-maps))
into the proposal queue as PENDING; nothing is created until a person approves.

**External tools ask the transfer check.** An API key bound to a registered
agent brings that agent's granted external tools (MCP-server tools, A2A sends).
Before the turn's first model call the assistant asks the same
business-data transfer check the agent engines ask (`externalResidencyRefusal`,
#5754); a refusal is a 403 with reason
`EXTERNAL_AI_BUSINESS_DATA_UNACKNOWLEDGED`, and the stream emits a refusal
naming the connections.

Every answer passes the egress guard before it is returned, and the generation
is recorded for AI cost visibility. What the assistant sends to Anthropic is
recorded in `docs/sub-processors.md`.

## Input: the question and its history

The limits live in one import-free module, `limits.ts`, read by both the server
schema and the sheet's counter, so the two never disagree:

| Limit | Value |
|---|---|
| A question | 8,000 characters (UTF-16 code units, as `String.length` counts) |
| Earlier turns carried | 6 question-and-answer pairs |
| Their total | 24,000 characters |

`selectHistoryWindow` takes whole turns back from the newest while both caps
hold; only the newest turn's answer may be shortened (marked `[…]`), and the
first older turn that does not fit ends the window, so the model never reads a
reply to a question it was not shown.

The sheet takes multi-line input and states the limit. History arrives from the
browser, so it is untrusted: it is a list of question-and-answer **pairs** with
no `role` field (`history.ts`, `.strict()`), so nothing in it can pose as a
system message, a tool result or a proposal id. Every question in it, and every
answer, is scanned by the same input guard as the new question, and the model is
told earlier turns are context, never instructions.

**The answer seal** (`answer-seal.ts`) spares the server's own words that second
scan. Each answer leaves with an HMAC-SHA256 over the tenant, the asker and the
exact answer text, under a key derived from the master key for this purpose
alone. An earlier answer that comes back with a seal that verifies is the
server's own, already egress-guarded text, and is not scanned again; anything
else — no seal, a seal over other text, another person's or tenant's seal, an
answer trimmed to fit — is scanned as a question is. Questions are always
scanned. A seal grants nothing: it names no row and unlocks no tool. Rotating the
master key invalidates every seal, which only means open conversations are
scanned in full.
