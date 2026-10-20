# 2026-10-20 — Promoting an ACCEPTED A2A send through tasks/get (#3743)

**Commit:** see the pull request for #3743.

## Design

A peer that answers a send with a task still `submitted` or `working` leaves
the journal row `ACCEPTED`. Before this change nothing asked again, so the row
never showed whether the work landed. The external-write reconcile pass already
promotes `ACCEPTED` MCP writes by re-running their paired read. An A2A send has
no paired read: its far end is the peer's task. So the pass routes those rows to
`pollAcceptedA2aSend`, which asks the peer.

```
reconcileAcceptedExternalWrites (every 10 min, per tenant)
  └─ row.advertisedToolName === a2a_send_task
       └─ pollAcceptedA2aSend
            kill ─ admission ─ basis (pin) ─ due? ─ peer's task id (from the kept answer to the send)
            ─ signing key ─ identity ─ credential
            ─ sign TASK tasks/get ─ keep ─ send on the one wire ─ verify RESULT ─ keep
            ├─ completed                        → promoteAcceptedWrite        (APPLIED)
            ├─ submitted/working/input-required → noteAcceptedWrite           (stays ACCEPTED, detail says when and how long)
            ├─ failed/canceled/rejected         → concludeAcceptedIndeterminate
            ├─ signature does not verify        → concludeAcceptedIndeterminate
            └─ anything else                    → NOT_POLLED (asked again later)
```

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/a2a-outbound.ts` | `pollAcceptedA2aSend`, `a2aPollDue` and the interval constants |
| `src/app-layer/usecases/external-write-reconcile.ts` | Routes A2A rows to the poll; `indeterminate` in the result |
| `src/app-layer/usecases/external-write-journal.ts` | `concludeAcceptedIndeterminate`, `noteAcceptedWrite`, both pinned to `ACCEPTED` |
| `src/lib/agentic/a2a/protocol.ts` | `tasks/get` in `A2A_CLIENT_METHODS`; `buildA2aTaskGetBody` |
| `src/lib/agentic/a2a/client.ts` | Accepts the widened method set |
| `src/app-layer/jobs/external-write-dispatch.ts` | Carries the new count |

## Decisions

- **Built before the pilot** (owner, 2026-10-20). The issue deferred it until the
  vendor pilot showed what the peer expects. The pilot's peer is now a second
  Inflect tenant, whose `tasks/get` is this codebase's own and already tested,
  so nothing waited on the pilot. #3744 still does.
- **The same rails as the send, in the same order**, including the basis check:
  a card re-approved since the send is a different peer as far as the decision
  knew, so the row is not polled. A killed peer is not polled either.
- **`INDETERMINATE`, never `FAILED`.** The pass's rule is no negative claim from
  the far end's silence or from a timer. A peer's signed report that its task
  failed is its claim, which is what `INDETERMINATE` records; the send settles
  the same report the same way when it arrives on the send. An answer that does
  not verify settles `INDETERMINATE` too, as the issue specifies and as the send
  does, because the row can no longer be tied to the peer's own account.
- **An error or an unrecognised answer moves nothing.** A JSON-RPC error may mean
  the peer has not indexed the task yet. It is kept as a receipt and the row is
  asked again.
- **The peer's task id comes from the kept answer to the send**: the oldest
  `INBOUND RESULT` against the journal row. Later results are the pass's own
  polls. No new column: the signed answer is the authority for the id.
- **Backoff from the row's age.** The pass runs every ten minutes. Polling at
  that rate would keep 288 receipts a day for a task that runs for days, and
  spend the peer's inbound quota (an Inflect peer counts `tasks/get` against
  it). A row is asked again after a quarter of the time it has been accepted,
  between ten minutes and six hours. The last poll's time is read from the
  receipts, so it needs no column either.
- **A still-running row's detail moves, its outcome and `settledAt` do not.**
  `settledAt` stays the moment it was accepted, so its age remains derivable.
  The detail says when the peer was last asked and what it answered.
