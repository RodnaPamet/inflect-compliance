# 2026-10-25 — The egress scanner reads keys, and reports what lies too deep

**Commit:** `<sha> fix(ai-guard): the egress scanner reads keys and reports content past its depth limit`

Fixes #4206, found by Step 0H's re-read of #4111.

## Design

`scanEgress` (`src/app-layer/ai/guard/egress-scanner.ts`) flattened a payload
to its string values and stopped silently at depth 12. So two shapes came back
`clean` from every egress guard:

- `{"AKIA…": 1}`, a secret used as an object key;
- a secret nested 13 levels deep.

Both reached a third-party server through an external MCP read tool, whose
arguments are an open `z.record(z.string(), z.unknown())`.

The walk now collects three things:

```
values    string leaves             joined, scanned against EVERY rule (unchanged)
keys      distinct object keys      each scanned ALONE against the high-severity rules
unscanned anything that can carry   → egr.unscanned.depth (medium → suspicious)
          text below depth 12
```

Rule ids are reported in the order found: value hits in table order, then a
rule only a key fired, then the depth report. A payload with no keys and no
depth is scanned exactly as before.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/ai/guard/egress-scanner.ts` | the walk, the key scan and the depth report |
| `tests/unit/egress-scanner-keys-and-depth.test.ts` | both refusals, each with a clean positive control |

## Decisions

Both owner decisions, recorded on #4206 on 2026-10-25:

- **Depth is suspicious, not malicious.** Under `balanced` and `strict`,
  `suspicious` maps to `flag`, so every egress caller still stops the call. A
  direct `/api/mcp` caller gets `ai_guard_review_required`, and a Flue run
  latches for review. The audit row does not claim a secret was found where
  none was read. Under `audit`, nothing is enforced, as for every verdict.
- **Keys get the high-severity rules only.** The generic high-entropy rule
  fires on a 32-character mixed-case token, which is what a base64url digest
  looks like. Maps keyed by digests or ids are ordinary in tool arguments, so a
  key is held only to the real secret shapes.

One decision made here:

- **Each key is scanned on its own.** Joining keys into one text would let
  field names assemble into a shape no single key has. The seed-phrase rule is
  the example: it wants the word "mnemonic" and a run of short lowercase words,
  and twelve ordinary field names supply both.

The bound on the walk is unchanged at 12. What changed is that hitting it is
reported. An empty container, a number, a boolean or a null below the limit is
not, because none can carry a secret shape.
