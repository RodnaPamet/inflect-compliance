# 2026-10-18 — integration passport with weekly drift findings (2d)

**Commit:** step 2d of the agentic IAM roadmap (#3672)

## Design

`docs/integration-passport.md` (merged with 0c, #3693) is the specification.
One passport per `mcp-server` connection, twelve fields, each read from a stored
row; a weekly sweep compares it with the last one emitted and raises a `Finding`
for each change the specification calls drift.

```
Sunday 05:45 UTC  integration-passport-sweep
  discovery   tenants with an mcp-server connection ∪ tenants with a passport
              artefact in the last 35 days            (drained, global client)
  per tenant  delegated job ctx (resolveEmissionActor), try/catch, counted outcome
    tx1 read  connections (cap 200+1) · pins · grants · pairings · parameter sets
              (one findMany each, cap 5000+1, prefix OR) · owners' ACTIVE
              memberships · target controls · prior · audit window
    build     decrypt each secret once, keyed digest of the endpoint URL →
              buildIntegrationPassport (pure)
    plan      planPassportFindings (pure): STATE findings from this week alone
              (a truncated read raises these for the rows it read, and nothing
              else); EVENT findings only when the prior VERIFIED and this pass
              emits
    tx2 write pg_advisory_xact_lock('integration-passport:<tenant>')
              refuse a week earlier than one already emitted (409)
              emitPassportArtefactsInTx (one artefact per target control)
              reconcile findings (create / reopen state / close on evidence)
              reassign every open connection finding to its accountable owner
    after     logEvent for every finding change + INTEGRATION_PASSPORT_SWEPT

prior = newest INTEGRATION_PASSPORTS artefact with periodStart < this ISO week,
        Evidence.content verified against AgenticEvidenceArtefact.sourceDigest
```

The view is the same reads for one connection, built live, with the planner run
against the last verified emission as a preview. It is served OWNER-only at
`admin/integration-passport/{id}` and rendered by two cards on the connection's
page: the passport (OWNER) and the owner picker (`admin.manage`).

## Files

| File | Role |
|---|---|
| `src/lib/agentic/integration-passport.ts` | Pure builder (P1–P12), digest, canonical bundle, embed and verify, evidence body |
| `src/lib/agentic/integration-passport-drift.ts` | Pure planner: finding codes, severities, `sourceRef` grammar, assignee, citations |
| `src/app-layer/usecases/integration-passport.ts` | Bounded reads, the prior, one tenant's sweep pass, the view, the owner setter |
| `src/app-layer/jobs/integration-passport-sweep.ts` | Tenant discovery, actor, per-tenant outcome, metric, `runJob` |
| `src/app-layer/jobs/{types,executor-registry,schedules}.ts` | Payload, `attempts: 1`, registration, `'45 5 * * 0'` with the slot reasoning |
| `src/lib/agentic/evidence-artefact.ts` | `INTEGRATION_PASSPORTS` kind, six targets, `weeklyPeriod`, `periodForKind` |
| `src/app-layer/usecases/agentic-evidence-emission.ts` | Spelling-aware target resolution, `installedKinds` per kind, `writeArtefactInTx`, kind-aware withdrawal label |
| `src/app-layer/jobs/agentic-evidence-emission.ts` | Spelling-aware tenant discovery; `resolveEmissionActor` exported |
| `src/app-layer/usecases/mcp-tool-manifest.ts` | `declaresWrite` on the pin; a BASELINE pin approved unchanged becomes APPROVED |
| `src/app-layer/usecases/external-mcp-tools.ts` | The external approval passes the catalogue's write declaration |
| `src/app-layer/usecases/external-prior-state-read.ts` | `EXTERNAL_PRIOR_STATE_READ_CLEARED` audit |
| `prisma/migrations/20261018001000_integration_passport/` | `ownerUserId` (+ index, FK SET NULL), `declaresWrite`, the kind CHECK |
| `src/app/api/t/[tenantSlug]/admin/integrations/[connectionId]/owner/route.ts` | PUT owner, `admin.manage`, strict body |
| `src/app/api/t/[tenantSlug]/admin/integration-passport/[connectionId]/route.ts` | GET view, `admin.tenant_lifecycle` |
| `src/lib/security/route-permissions.ts` | The passport rule, `GET` only |
| `src/app/t/[tenantSlug]/(app)/admin/integrations/[connectionId]/IntegrationPassportCard.tsx` | The passport view |
| `src/app/t/[tenantSlug]/(app)/admin/integrations/[connectionId]/IntegrationOwnerCard.tsx` | The owner picker |
| `src/app/t/[tenantSlug]/(app)/admin/integrations/[connectionId]/page.tsx` | Mounts both cards, each behind the key its route holds |
| `src/lib/observability/integration-metrics.ts` | `agentic.integration_passport.sweep` by outcome |
| `src/lib/security/encryption.ts` | `keyedChangeDigest`: case-preserving, domain-separated HMAC under the lookup key, for P1 |
| `src/lib/mcp/tool-manifest.ts` | Corrected comment: annotations-only moves are refused by the resolver, not the boundary |

## Decisions

- **The owner accepted both changes to the 0c specification on 2026-10-18**: P1 is
  the endpoint's origin plus a keyed digest rather than the URL, and naming an
  owner moves the connection's open passport findings to that owner at the next
  sweep, overruling a hand reassignment. Both are explained below.

- **The prior is read from the emitted artefact, not from a table or from
  findings.** Findings hold differences, so they cannot reconstruct a passport;
  `IntegrationExecution.resultJson` is purged and unkeyed. `Evidence.content` is
  editable, but `sourceDigest` has no route writer, so verifying one against the
  other makes the body tamper-evident. The price is that a tenant with no target
  control has no prior; it is told so by `PASSPORT_NOT_EVIDENCED`.
- **"Strictly before this week"** is what makes the sweep idempotent per week:
  every re-run compares against the same prior.
- **Event keys carry the ISO week; state keys do not.** The specification's
  `(connection, field, rule)` key stays the prefix. Without the week, a second
  widening of one connection while the first finding is open folds into it, and
  a same-week re-run after somebody closes the finding must choose between
  reopening a triaged event and staying silent for good.
- **Events are written only by a pass that emits, in the same transaction.** A
  pass that raised events without emitting would leave the old prior in place
  and raise the same events next week under next week's key.
- **One artefact per target control per week bundles every connection.** The
  artefact identity has no connection dimension and `controlId` is NOT NULL.
  `recordCount` is the connection count.
- **Six evidence targets across three families**, not ASI only: ASI-only would
  leave every ISO 27001 and SOC 2 tenant with no prior and so no drift. This
  forced three changes to the shared emitter: ISO codes resolve through
  `requirementCodeSpellings` (a target matched only its exact spelling, so the
  seeded `5.19` and the library's `A.5.19` missed each other), "installed" is
  judged per kind (one flag across kinds would let a tenant whose only targets
  are ISO ones run a withdrawal pass whose capped catalogue read misses its ASI
  rows, and withdraw every receipt artefact), and the withdrawal notice is
  labelled with the kind's own period. The receipt and decision kinds resolve
  and withdraw exactly as before.
- **Two tenant-level findings the specification does not name**,
  `PASSPORT_NOT_EVIDENCED` and `PASSPORT_PRIOR_UNVERIFIABLE`. Roadmap rule 7
  (fail closed, never silently): without them a tenant whose drift is never
  compared looks the same as a tenant with no drift.
- **Audit rows after commit; namespaced lock.** `logEvent` appends in its own
  transaction under `hashtext(tenantId)`, so a row written inside the write
  transaction would commit even when the findings it describes rolled back, and
  sharing that lock key would queue the tenant's every audit append behind a
  pass.
- **The owner is set on its own route under `admin.manage`**, the existing
  connection-write key, not through the connection upsert: the upsert computes
  `isEnabled ?? true`, so an owner edit through it would re-enable a disabled
  connection. `ON DELETE SET NULL` makes an erased user read as no owner, the
  fail-closed direction. An owner without an ACTIVE membership is no owner.
- **An open finding follows the owner, every sweep.** The column starts empty,
  so the first Sunday raises every connection's findings with no assignee; a
  create-only reconcile would have left them unassigned after an owner was
  named, pointing at a closed `CONNECTION_OWNER_MISSING`, and would have left a
  departed owner's findings on nobody. The sweep moves each open finding about a
  connection, state and event, to the current accountable owner (or the OWNER
  role) and rewrites only the description's ownership tail, which the planner
  therefore always writes last. A hand reassignment is overruled next Sunday:
  the specification names the owner, and naming somebody the connection's owner
  is how its findings are handed over. The alternative, moving only rows the
  sweep itself assigned, needs to know who assigned a row, which nothing stores.
- **A truncated read still raises the state of the rows it read.** It used to
  plan its one `POPULATION_TRUNCATED` finding and stop, so a tenant over any cap
  never had `CONNECTION_OWNER_MISSING` raised for a connection added after it
  crossed it. Each state condition is a positive observation on a row that was
  read, so it holds whatever lies past the cap; only events, `VANISHED` and
  closures depend on completeness, and those stay off.
- **`asOf` names a week, the rows are read now.** The job refuses a week that
  has not begun, and the pass refuses a week earlier than the tenant's newest
  emitted one, checked under the lock. Without it a re-run of W41 after W43
  rewrote W41's evidence with W43's rows and raised W42's and W43's changes
  again under W41's key. A clock-relative "past weeks are refused" rule was
  rejected: it would refuse a retry of a tenant that failed, and make every
  fixed-date test of the sweep fail once its dates were in the past.
- **P1 is an origin and a keyed digest, never the URL.** The emitted passport is
  Evidence, read by every role with evidence read and by an audit pack's share link,
  and an MCP URL can carry its credential in the path (`/s/<key>/mcp`). Origin
  plus `keyedChangeDigest` of the whole URL still raises any change. The key is
  the deployment's lookup key rather than the tenant DEK, because rotating a
  tenant DEK is a routine response to a compromise and would report every
  endpoint as changed; rotating the master key re-keys it too, and the finding
  text says so. The specification's "no hash of a secret" now reads "no unkeyed
  hash": a keyed digest lets nobody without the key test a guess.
- **The write declaration is stored, not inferred.** `declaresWrite` is written
  from the same catalogue read that produced the pinned `annotationsHash`, so it
  cannot disagree with the hash beside it; NULL means not recorded, never
  read-only. A write tool with no prior-state pairing is reported in the evidence
  and the view, not raised: the specification defines no rule for it and
  dispatch already refuses such a write.
- **A BASELINE pin approved unchanged now becomes APPROVED.** `writeToolManifestPin`
  did nothing when the hashes matched, whatever `approvalSource` said, so the
  specification's HIGH `PIN_BASELINE` finding could not be cleared through the
  product while the server left the tool alone. This also applies to built-in
  approvals of baseline pins: one revision and one notification per tool, once.
- **The view is a sibling path, OWNER-only, gated at the route only, as a
  placement and not a boundary.** It sits with the surfaces that change P8 and
  P9 under `admin.tenant_lifecycle`; the passport it shows is the week's
  Evidence, readable by every evidence reader, so nothing in a passport relies
  on the gate. Under `admin/integrations/` first-match-wins would resolve it to
  `admin.manage`. Both cards are gated at the mount on their route's key, so an
  ADMIN is never shown a card whose request would be refused, and never writes
  an `AUTHZ_DENIED` row by visiting. A 404 or 403 renders nothing, which is how
  the passport card stays off every other provider's connection page.
- **The cards use `<DataTable>` directly**, as sub-tables of a detail page,
  exempt from the list-page shell, filter toolbar and column-gear ratchets like
  the legacy mapping card beside them. Secondary signals in the pins table are
  inline text so the approval badge is each row's one loud signal, and the owner
  card's Save is a secondary button under the product's primary-action ceiling.
- **Coordination.** The kind CHECK is `DROP CONSTRAINT IF EXISTS` + `ADD`
  listing every kind this branch defines. #3687 widens the same CHECK in
  `20261017235500`; whichever merges second re-lists both kinds.
