# 2026-11-16 — The assistant asks the external-AI transfer check

**Commit:** `fix(assistant): ask the external-AI transfer check before the first model call`

## Design

The in-product assistant's tool-use loop is a third route to Anthropic beside
Flue and the Tool Runner. Both engines ask `externalResidencyRefusal` (#3872,
#5364) between building the offer and the first model call. The assistant did
not.

The gap reached only API keys. `/assistant/ask` and `/assistant/stream` accept
them, and a key bound to a registered agent gets an invocation carrying that
agent's granted external tools (`inv.externalTools`, which `loadableReadTools`
appends). `assistantTools` offered them to the model, and their results went to
Anthropic with no acknowledgement on record. A signed-in person holds no grants
and is offered no external tool, so they were never affected.

The turn now runs:

```
assistantPosturesFor (one read: residency + acknowledgement)
  -> resolveFlueModel -> assistantProviderFor
       LOCAL_ONLY / no provider -> keyword router, no model, gate never reached
  -> resolveMcpInvocation -> assistantTools (the offer)
  -> externalResidencyRefusal(offered external connections, acknowledgement)
       refusal -> ForbiddenError, reason EXTERNAL_AI_BUSINESS_DATA_UNACKNOWLEDGED
  -> runAssistantLoop (first model call)
```

`/ask` answers 403 with the gate's message
(`assistant_external_ai_business_data_unacknowledged: …`, naming the
connections). The stream emits a `refusal` event that names the connections and
says no model was called, no tool ran and nothing was created. All three are
provable, because the gate fires before the loop starts.

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/external-residency-gate.ts` | `enginePrefix: 'assistant'`, with the assistant's own LOCAL_ONLY remedy and subject ("this assistant turn"). Flue and Tool Runner messages unchanged. |
| `src/app-layer/ai/assistant/tools.ts` | `AssistantToolSet.externalConnections`: the offer's own record from `offerToolSet`. |
| `src/app-layer/usecases/assistant.ts` | `assistantPosturesFor` (one read), the gate between the offer and the loop, the stream's refusal sentence. |
| `tests/unit/ai/assistant-external-ai-transfer.test.ts` | Through both real routes. Runs the conformance table's two `business-data-transfer-*` scenarios as assistant turns and adds route, stream, session, non-business and LOCAL_ONLY cases. |

## Decisions

- **Once per turn, over the offered set.** The engines judge once per run, and
  a turn cannot change its set: `runAssistantLoop` gets `set.tools` once and
  sends the same array on every round trip. Changing it would also break the
  byte-identical prefix that replayed thinking blocks need. The acknowledgement
  travels with the turn, read once, for the reason the drivers give: the
  question is what permitted this turn.
- **One read for both postures**, `{ ...RESIDENCY_SELECT, ...EXTERNAL_AI_ACK_SELECT }`,
  as both drivers' `posturesFor` do. The assistant's old residency read is
  replaced, not joined by a second one.
- **The offer's own record, not a rebuilt list.** `set.externalConnections` is
  the population both engines judge. It can be wider than the tools the
  assistant hands the model only by a tool dropped for having no registry
  schema. That cannot happen while both come from the same registry functions,
  and wider is the refusing direction.
- **The whole turn refuses.** No dropping the business-system tools, and no
  fallback to the keyword router. An answer about an ERP the assistant was
  quietly stopped from reading is worse than a refusal that says why.
- **403 with a named reason** (`details.reason`), the shape the usecase already
  uses for a refused history. The stream recognises it by that reason, never by
  matching the message.
- **No Art 12 row on a refusal.** No model was called, so no row claims one.
  The operator signal is the `assistant.external_ai_transfer_refused` log line,
  which carries a connection count, not names or the question.
- **Conformance reuse, not a parallel copy.** The two scenarios and their
  assertions come from `CONFORMANCE_SCENARIOS` by id. The rest of that table
  (kill switch, ledger, run rows) is about runs, which a turn does not have.
