# 2026-10-03 — Saved-parameters operator surface (#3124)

**Commit:** `feat(agents): operator surface for external-tool parameter sets (#3124)`

## Design

`ExternalToolParameterSet` shipped in #2906 with four HTTP verbs, five usecases
and — after #3051 step 5b — a database trigger enforcing four eyes on a template
edit. Nothing in the product called any of it. `saveParameterSet`,
`proposeParameterChange`, `signParameterChange` and `approveParameterChange` had
been API-only for their whole life, so an operator could not create a parameter
set, propose an edit, sign one or approve one at all.

That is the third time the same shape shipped in this subsystem — #2921's
external-tool approval API, #2861's external-write ladder route, and this — which
is why the surface lands as the WHOLE operation set rather than "a sign button".
Signing is the last step of a flow whose earlier steps were equally absent, and
an approve control over a list nobody can populate is a screen that lies about
what it can do.

```
/agents/external-tools ──"Saved parameters"──▶ /agents/parameter-sets?connectionId=…
   (tool catalogue)                              │
                                                 ├─ GET    …/parameter-sets             list
                                                 ├─ POST   …/parameter-sets             baseline
                                                 ├─ PATCH  …/parameter-sets             propose
                                                 ├─ POST   …/parameter-sets/signatures  sign
                                                 └─ PUT    …/parameter-sets             approve
```

Four states render differently and are each covered by a rendered test: empty,
populated baseline, pending edit with no signature, pending edit with one.

**What the surface owes beyond CRUD.** Two facts about these rows are not
inferable from a generic form, and both are on screen rather than implied:

1. **A baseline is trust-on-first-use.** `saveParameterSet` creates the first
   version with no approver and nothing to compare against, deliberately, and
   REFUSES open fields and a target population for that reason. The form states
   the ordering before the refusal can be reached, and renders the server's own
   sentence when it is.
2. **A signature is against a DIGEST, not against a row.** The signature row
   stores the hash it was taken on and the promotion counts only signatures
   naming what is pending now. So the count (`N of M signatures on this digest`)
   is rendered beside the digest it is about, every signature carries the hash it
   names, and the approve control's own label names the digest being approved.

**Refusals are the server's sentences, verbatim.** The nine four-eyes refusals
are raised by the database trigger and mapped to operator prose by
`fourEyesRefusal` inside the usecase, which rethrows anything it does not
recognise. The client reads `error.message` and renders it; a second copy of
those sentences in the browser would be a second place for them to drift. The one
thing judged locally is whether a textarea's JSON parses, because a body has to
be an object before it can be sent at all.

## Files

| File | Role |
| --- | --- |
| `src/app/t/[tenantSlug]/(app)/agents/parameter-sets/page.tsx` | Server component. Gates on `admin.agent_registry`, reads the MCP connections and the target-population registry (key, description, bound) and hands them down as data. |
| `src/app/t/[tenantSlug]/(app)/agents/parameter-sets/ParameterSetsClient.tsx` | The surface: list, baseline form, propose form, diff, bounds, signatures, sign, approve. |
| `src/app/t/[tenantSlug]/(app)/agents/external-tools/ExternalToolsClient.tsx` | The inbound link, beside the write-policy one, carrying the selected connection in the query string. |
| `src/lib/nav/page-segregation.ts` | `/agents/parameter-sets` classified as a SUBPAGE. |
| `src/lib/nav/canonical-parents.ts` | Back/breadcrumb parent is `/agents/external-tools` — the page the link lives on. |
| `messages/en.json`, `messages/bg.json` | 64 leaf keys under `agents.parameterSets`, plus `agents.externalTools.parameterSetsLink`. |
| `tests/rendered/parameter-sets-surface.test.tsx` | 23 assertions over the four states, the diff, the digest/signature pairing, and every mutation's request body. |
| `tests/guards/agentic-route-inbound-links.test.ts` | New route registered in `AGENTIC_ROUTES`. |
| `tests/guards/primary-action-budget.test.ts` | Budget 3 with the three regions named. |
| `tests/guards/rendered-coverage-floor.test.ts` | Floor raised to the measured live count. |
| `tests/guardrails/design-system-drift.test.ts` | Both new files promoted to `MIGRATED_PAGES` rather than parked in the unmigrated tally. |

## Decisions

- **Nav placement is the tool catalogue, not the agents Views menu.** A parameter
  set is scoped to a TOOL ON A CONNECTION, and the catalogue page is where an
  operator already has that connection selected — the same reasoning
  `page-segregation.ts` records for `/admin/external-write-policy`. The Views
  menu's entries are all agent-WIDE surfaces. The connection travels in
  `?connectionId=`, and the href is composed from a literal path precisely so
  `agentic-route-inbound-links` can see it: its needle for a static route is the
  path followed by a quote, and a path interpolated ahead of a query string
  matches nothing.
- **The list filters by connection client-side.** The route's `toolName`
  parameter takes one exact qualified name, and the connection is a PREFIX of
  that name, so one read serves every tool on the server rather than one request
  per tool.
- **The catalogue read is separate, and a failure does not blank the list.** The
  saved sets come from our own database; the tool list for the baseline form
  reaches a third party. Collapsing the two would make somebody else's outage
  read as "this tenant has no saved parameters".
- **The propose form always submits the whole intended state.** `openFields` and
  `targetPopulation` are SENT as explicit nulls when empty, never omitted —
  omitting them means "carry the row's current bounds forward" in the usecase,
  which is a different edit from the one the form describes.
- **The target populations arrive as props.** The registry imports
  `runInTenantContext`, so it is a server module and `no-usecase-imports-in-client`
  refuses a client value-import. Passing key + description + bound keeps the one
  authoritative list in one place; a hand-copied union is how a page keeps
  offering a population a deploy has removed.
- **The constraint vocabulary is pinned at compile time.** `KNOWN_KINDS` is a
  `Record<ValueConstraintKind | 'target', true>`, so a fifth `ValueConstraint`
  kind fails `tsc` until somebody writes its sentence. An array of strings would
  have gone stale silently and rendered the new kind as "unreadable".
- **The diff is over the UNION of argument keys.** A diff that iterated only the
  proposal would render a DELETION as nothing at all — the change an approver is
  least likely to notice and the one most likely to re-point a live agent. An
  edit that touches no argument says so explicitly, because the change is then in
  the bounds or the target.
- **`BASELINE` wears a `warning` badge, not `neutral`.** It is the one row on the
  page whose content nobody reviewed; the same grey as everything else would hide
  the single most important fact about it.
- **Approver and proposer are shown as user IDs.** `listParameterSets` returns
  `approvedByUserId` / `pendingByUserId` / `approverUserId` and no display name,
  and resolving names would mean a second route this issue does not ask for. The
  ids are rendered as data; a name resolver is a follow-up.
- **Promoted to `MIGRATED_PAGES` rather than bumping the unmigrated ceiling.**
  The ratchet's stated path forward, and honest here — both files are
  design-system-native from birth. It also leaves a shared ceiling untouched
  while several branches are open against it.
