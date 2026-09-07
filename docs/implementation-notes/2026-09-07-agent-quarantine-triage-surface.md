# 2026-09-07 — Quarantine triage surface (#2330 item 3)

**Branch:** `feat/w2330` — feat(agentic): give the quarantine triage listing an API route and a page (#2330 item 3)

## The gap

`createAgentProposal` writes a QUARANTINED row instead of throwing, and the seam
says why in its own comment: *"the row is the only durable evidence that the
attempt happened, and an operator triaging an injection needs to see what was
tried, not an error somebody's agent swallowed."*

`listQuarantinedAgentProposals` existed and was tested. It had no HTTP entrance
and no page. Its only caller in the repository was
`tests/integration/prompt-injection-corpus.test.ts`.

The EVENT was already discoverable — every quarantine appends a hash-chained
`AGENT_PROPOSAL_QUARANTINED` audit row. The PAYLOAD was not, and deliberately
so: that audit entry carries rule ids and a digest and never content, and
`summarizeWithoutContent` in the guard is built so no excerpt of the proposal is
ever persisted alongside it. The one place the attempted text survives is the
`AgentProposal` row itself, which nothing outside a psql session could read.

## Design

```
GET /api/t/:slug/admin/mcp/quarantine        requirePermission('admin.agent_registry')
  └── listQuarantinedAgentProposals(ctx, { take: PAGE_SIZE + 1 })   [assertCanRead + RLS]
        └── projected to QuarantinedProposalDTO + { truncated }

/t/:slug/admin/mcp/quarantine  (SUBPAGE of /admin/mcp, carded on the MCP hub)
  page.tsx        thin server component
  QuarantineClient.tsx   EntityListPage + DataTable + Sheet, reads the route above
```

Four decisions worth the words:

**The page has no SSR twin.** Every sibling admin page loads its rows through
the usecase in the server component and hands them to a client. That is right
when the page is the only consumer, and wrong here: the whole defect being fixed
is that the usecase had no HTTP entrance, and an SSR read would have shipped the
route with no production caller — the same defect one layer up, delivered
alongside its own fix. Routing the page through the API also means every read of
the attempted content passes the `requirePermission` gate, so a denial writes an
`AUTHZ_DENIED` row and an allowed read is an ordinary logged request.

**`truncated` is measured, not guessed.** The route asks for `PAGE_SIZE + 1` and
reports whether the extra row came back. `rows.length === PAGE_SIZE` cannot tell
a page that is exactly full from one that is cut short, and here the rows past
the cut are the OLDEST attempts, because the listing is newest-first — silence
would hide exactly the history an investigator came for.

**The search is client-side, so the copy has to say what it searched.** The
route returns one page of `QUARANTINE_TRIAGE_PAGE_SIZE` (100) rows and there is
no cursor; `QuarantineClient` filters that array in the browser. That is not a
shortcut that a later PR should "fix" by pushing it into SQL:
`AgentProposal.payloadJson` and `.rationale` are in `ENCRYPTED_FIELDS`
(AES-GCM at rest, decrypted by the Epic B read extension on the way out), so a
`contains` in the `WHERE` clause would be matching ciphertext. The two fields
that make the search worth having cannot be filtered server-side at all.

The consequence is that on a TRUNCATED page the search has not seen the older
attempts — and truncation is not the rare case here, it is the case the surface
exists for: a tenant under sustained injection is exactly the tenant with more
than 100 quarantined rows. So every message the page can show while truncated
names the number of rows it actually covered, and the empty-search state gets
its own string. The first version of this page shipped
`emptyMatchingDesc = "… Clear it to see every quarantined proposal"`, which was
false precisely when it mattered; the header count read `"{total} quarantined"`,
which was a claim about the population rather than the page. Both are fixed, and
`tests/rendered/agent-quarantine-client.test.tsx` carries the pair that keeps
them fixed — a DOM test that the truncated state renders its own message, and a
catalogue test over `en.json` + `bg.json` that every message reachable while
truncated contains `{shown}`. The second exists because the first FOLLOWS the
copy: a reworded over-promise slips past the DOM assertion and is caught only by
the catalogue one. (Verified: mutating the component to use one unconditional
string fails only the DOM test; rewording the truncated string back to the old
promise fails only the catalogue test.)

**No approve control, anywhere.** Quarantine is terminal: `approveAgentProposal`
refuses every row this page lists and `listAgentProposals` excludes them
unconditionally, including from `?status=QUARANTINED`. A "review anyway"
affordance here would be the one path back into the queue that the design exists
to close. The page says so in a banner rather than only in a comment, because an
operator who cannot find the button will otherwise assume they lack the grant.

## The index that is NOT in this diff

#2330 asks for the index that backs the query, and the honest answer, after
measuring, is that the query already has one.

`listQuarantinedAgentProposals` reads
`where { tenantId, status: 'QUARANTINED' } orderBy createdAt desc`. That is two
equality columns then the sort column — an exact cover for the existing
`@@index([tenantId, status, createdAt])`. The index that suggests itself is
`[tenantId, guardVerdict, createdAt]`, because `guardVerdict` is the column a
reader assumes a "quarantine" page filters on and nothing covers it; but the
query filters on `status`, not on `guardVerdict`.

Measured on a scratch database, 200 000 rows across 20 tenants with QUARANTINED
at 0.5%: the planner serves the triage query from
`AgentProposal_tenantId_status_createdAt_idx` (Bitmap Index Scan, 3 shared
buffers for the index read), and adding the `guardVerdict` composite left the
plan byte-for-byte unchanged — the new index was never touched. It would have
been a second B-tree on a table written once per agent proposal, paid for on
every insert, serving nothing. `AgentProposalSampleAudit` records the same
reasoning for the FK index it deliberately does not carry.

The reasoning is written onto the `@@index` in `agentic.prisma` and into the
`LIST_MODELS_TENANT_INDEX_SUFFICIENT` entry.

### FLAGGED-but-queued: a real population, and what this diff decided about it

`guardVerdict` names a second population, and the reason it has no index is that
it has no query — not that the population is imaginary.

`guardAgentProposal` returns three verdicts. `QUARANTINED` when an injection or
egress rule scored malicious; `FLAGGED` when a rule fired but nothing did;
`CLEAN` otherwise. `createAgentProposal` then writes
`status: guard.quarantined ? 'QUARANTINED' : 'PENDING'` — and `quarantined` is
exactly `verdict === 'QUARANTINED'`. So **FLAGGED rows are written `PENDING`**,
which has two consequences worth stating precisely, because the loose version of
each is wrong:

1. **The rows are not invisible.** `/t/:slug/agent-proposals` calls
   `listAgentProposals(ctx, { status: 'PENDING' })`, so a FLAGGED proposal sits
   in the reviewer's queue like any other. What is invisible is the SIGNAL: that
   page's server projection forwards `id / kind / operation / status /
   targetEntityId / rationale / proposedViaKeyId / createdAt / diff` and **no
   guard column**. Grepping `src/app/t/` and `src/components/` for
   `guardVerdict` / `guardRuleIds` / `guardProvenance` returns hits in exactly
   one file — `QuarantineClient.tsx`, added by this diff. A reviewer approves a
   guard-flagged proposal without being told the guard fired.

2. **This surface does not list them, and that is a decision, not an oversight.**
   A FLAGGED row is `PENDING` and therefore approvable. This page has no approve
   control on purpose and says so in a banner — "Quarantine is terminal. Nothing
   listed here can be approved." Mixing FLAGGED rows in would make that banner
   false for half the table and would show an operator a row that needs a
   decision while offering no way to make it. The fix for (1) is a guard column
   and a filter on the REVIEWER'S QUEUE, next to the approve button that already
   exists there — not a second population on a read-only page.

That is why no `guardVerdict` index ships here either: after this diff, still
nothing filters on `guardVerdict`. The query that would is the one described in
(1), it is not written, and whoever writes it picks the index in the same diff —
the column order follows the filter, so this diff does not pre-commit to one.

## Files

| File | Role |
| --- | --- |
| `src/app/api/t/[tenantSlug]/admin/mcp/quarantine/route.ts` | The gated GET, the DTO projection, the over-fetch truncation probe |
| `src/lib/security/route-permissions.ts` | The rule that gates the path — the only rule in the map that matches it |
| `src/app/t/[tenantSlug]/(app)/admin/mcp/quarantine/page.tsx` | Thin server component |
| `src/app/t/[tenantSlug]/(app)/admin/mcp/quarantine/QuarantineClient.tsx` | List + detail sheet; payload rendered inert |
| `src/app/t/[tenantSlug]/(app)/admin/mcp/page.tsx` | The MCP hub card that makes the page reachable |
| `src/lib/nav/page-segregation.ts`, `src/lib/nav/canonical-parents.ts` | Route classified SUBPAGE, parent `/admin/mcp` |
| `src/components/layout/EntityListPage.tsx` | `selectionEnabled` added to the table `Pick` (see below) |
| `prisma/schema/agentic.prisma` | The index reasoning, on the index it is about |
| `messages/en.json`, `messages/bg.json` | `agents.quarantine.*` (incl. the truncation-aware `countTruncated` / `emptyMatchingDescTruncated`) + the two hub-card strings |
| `public/openapi.json` | Regenerated — the build discovers routes from the filesystem and emits a stub entry |

## Decisions

- **`admin.agent_registry`, not a new key.** The operator's move after reading
  this page is to suspend or retire the agent that produced the row, which is
  exactly the authority that key names. It is the same choice the sibling
  `review-quality` surface made and argued for. The rule in
  `ROUTE_PERMISSIONS` is REQUIRED rather than stylistic: exactly one rule in
  that map matches `/api/t/:slug/admin/mcp/quarantine`, and it is this one.
  Nothing reaches `/admin/mcp/**` by prefix — the nearest neighbour,
  `^…/admin/agents(/.*)?$`, differs in the segment — so without the rule the
  path would carry no declared permission at all. Nothing about rule ORDER is
  load-bearing here, and
  `tests/unit/agent-quarantine-route-authz.test.ts` asserts the whole-map count
  rather than a precedence, so that if somebody later adds an `/admin/mcp`
  subtree wildcard, first-match-wins starts deciding the answer and the test
  reddens.

- **`selectionEnabled: false`, and a one-line shell change to allow it.** The
  select column is DEFAULT-ON across the product and `DataTable`'s own docs name
  `selectionEnabled={false}` as the opt-out "for tables that are deliberately
  read-only at the row level". `EntityListPage` could not express it — the prop
  was missing from its `Pick` — so every page that adopted the shell was forced
  into the default. On this page that would have been a checkbox column with no
  verb behind it (quarantine is terminal, there is no bulk action to offer) AND,
  less obviously, the row action would have silently moved from single click to
  DOUBLE click, because selection takes the single one. That would have put the
  payload — the only reason to open a row — behind an undiscoverable gesture.

- **The payload lives in the sheet, not a table cell.** It is rendered into a
  `<pre>` (React escapes; never `dangerouslySetInnerHTML`, never a link `href`)
  and only when a row is opened, so scanning the list does not put a wall of
  injected prose in front of somebody who wanted the counts.

- **The free-text search covers the payload.** The triage question is usually
  "did this phrase appear anywhere else", and a search over metadata alone could
  not answer it. There are no filter dropdowns: the population is one refusal
  class, so a `kind` chip would be furniture. Its REACH is the loaded page — see
  the section above.

- **No "guard verdict" column, and none on the wire either.** It would be a
  constant. `quarantined === (verdict === 'QUARANTINED')` and
  `status = quarantined ? 'QUARANTINED' : 'PENDING'`, so every row a
  `status = 'QUARANTINED'` query can return carries `guardVerdict =
  'QUARANTINED'` by construction — the column rendered the same badge on every
  row, costing width on a triage table for zero signal, and the DTO field told a
  consumer only what the endpoint it had just called already said. The signal
  that VARIES is `guardRuleIds` (which rules fired), and that has its own
  column and stays. Should the FLAGGED population ever be listed alongside these
  (see above — this diff decided it should not be), the verdict becomes
  meaningful and the column comes back with it.

- **`formatPayload` falls back to the raw string.** `payloadJson` is written as
  `JSON.stringify(sanitized)` and should always parse, but this surface exists
  for rows that are not normal, and a page that renders nothing when the evidence
  is malformed withholds it at the one moment it matters.
