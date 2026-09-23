# 2026-09-23 — The adapter tells the truth about what it carries

**Commit:** `<sha>` fix(agentic): carry tool descriptions to the model, and make the un-scanned-output justification true

Phase 1 audit, points **2a** and **4a**. Both are the same kind of defect —
something the adapter *said* about itself that was not so — and neither is a
missing check.

## 2a — the contract was dropped on the way to the model

`JsonSchemaProperty` declared `description` from the day
`json-schema-to-valibot.ts` was written, and nothing ever read it. So every
per-property description in `src/lib/mcp/tools/` was lost in conversion: the
model saw the types and not the contract.

That matters most on the propose surface, where the description *is* the
contract — *"Each is validated against the risk create-schema; malformed items
are rejected, never queued"*. A model told the types but not that asks for the
wrong shape and gets refused at the funnel, which is the same failure the
converter's own `additionalProperties` note was written about: telling the
model less than the enforcement layer will hold it to.

`described()` pipes `v.description` onto the **inner** schema, so the text
belongs to the type rather than to the optionality of it. An absent or
whitespace-only description is left alone — a schema carrying
`description: ""` asserts something false.

## 4a — the justification for the absent scan was aspirational

`tools-adapter.ts` explained why the model's free-text output is not
egress-scanned: *"that output is not an action — it becomes an `AgentProposal`
a human reads"*.

**That path did not exist when it was written.** The adapter offered read tools
only until #2777, so there was no propose tool for a model to call. A comment
explaining why a guard is unnecessary is load-bearing exactly like the guard,
and this one was discharging that duty against a future.

It is true now, and the comment says the whole of it: output that becomes an
action is a tool *argument*, already scanned by the egress slice before the
funnel and guarded again by `createAgentProposal`; output that becomes nothing
reaches exactly one column, `AiDecisionLog.outputSummary`, sanitised and
bounded by `logAiDecision`.

**No egress scan was added**, and that is the finding's resolution rather than
a deferral of it. The scan would guard a path that does not exist: the model's
free text never leaves the tenant, never re-enters the model's context (a
dispatch is one turn, and the runtime's own loop feeds back tool *results*,
which the untrusted-input slice scans), and is not returned to any caller.

## Decisions

- **The claim is pinned, not just corrected.**
  `tests/guards/flue-model-output-has-one-destination.test.ts` counts the reads
  of `reply.text` and asserts there is exactly **one**. A second sink for model
  output is the regression that matters, and it arrives looking like a helpful
  one-line addition to a ledger write.
- **The description test discriminates PLACEMENT, not presence.** The first
  version asserted only that the description was findable, and a mutation
  moving it outside the `v.optional` wrapper passed — the accessor walks
  through `wrapped`, so it could not tell. It now asserts the optional node
  carries no description of its own.
- **Descriptions are metadata, not rules.** A test asserts the converted schema
  still accepts and rejects exactly what it did before, because the risk of
  piping a new action in is changing what the schema validates.
