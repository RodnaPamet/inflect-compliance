# Legacy-application access recertification — implementation phases

> **Status: living design** — no step has started. This is the executable companion to
> `docs/legacy-access-recertification-design.md`: each phase broken into
> pull-request-sized steps, each with a prompt for a fresh Claude Code session and a
> hardening checklist its pull request must satisfy. The design document says *what*
> and *why*; this one says *how, in what order, and how we will know it is safe.*

## Current state (true today)

No step has started. What exists today — and what is missing — is described once, in
the design document's `## Current state (true today)` section; this document does not
restate it.

| Step | Title | Status | Pull request |
| --- | --- | --- | --- |
| 0a | Guard the directory tables against a second writer | Not started | — |
| 0b | Persist directory login names | Not started | — |
| 0c | Persist structured HR names and real employee numbers | Merged | #3277 |
| 1a | Publish the contract and a fake server | In the merge queue | #3257 |
| 1b | The MCP client | Not started | — |
| 1c | Register the `legacy-mcp` provider | Not started | — |
| 2a | Snapshot models and a fail-closed pull | Not started | — |
| 2b | Mapping UI and suggestions | Not started | — |
| 3a | Normalisation library and labelled corpus | Not started | — |
| 3b | The deterministic engine and the precision ratchet | In the merge queue | #3286 |
| 3c | Persist results and the crosswalk | Not started | — |
| 4a | Naming conventions and similarity | Not started | — |
| 4b | Review queue and alias revalidation | Not started | — |
| 5a | Harden the existing access-review flows | Not started | — |
| 5b | Legacy recertification campaigns | Not started | — |
| 6a | Register TypeSafe as a proposed sub-processor | Inventory PR open | #3246 |
| 6b | Decision-model client and evaluation harness | Open | #3288 |
| 6c | Adjudication in the run, and the review lanes | Not started | — |
| 6d | Turn it on | Not started | — |

## Roadmap (future direction)

### How to use this document

- **One step, one pull request, one fresh session.** Paste the step's prompt into a new
  Claude Code session on a new branch. Each prompt is self-contained: it tells the
  session what to read, so it needs nothing from an earlier conversation.
- **The hardening checklist is the acceptance test.** The session copies it into the
  pull-request body and ticks each item beside the test that proves it. An item with
  no test stays unticked, and a pull request with an unticked item is not done.
- **Never start a step before its dependencies are merged.**

### Dependencies

Six steps depend on nothing new and can start on day one: **0a, 0c, 1a, 3a, 5a and
6a.** Step 6a is paperwork rather than code, and it should start first of all:
TypeSafe's 30-day customer-notice window is the longest fixed wait in the plan, and it
can elapse while everything else is built.

The critical path runs through the plumbing: **1a → 1b → 1c → 2a → 3c → 4b → 5b.**
The matching algorithm itself — 3a → 3b → 4a — is pure code proven against a
synthetic corpus, so it runs alongside the plumbing rather than after it.

| Step | Depends on | Change class |
| --- | --- | --- |
| 0a | — | Standard |
| 0b | 0a | Significant — schema migration |
| 0c | — | Significant — schema migration |
| 1a | — | Standard |
| 1b | 1a | Significant — new egress path |
| 1c | 1b | Significant — configuration validation is a security boundary |
| 2a | 1c | Significant — schema migration |
| 2b | 2a | Standard |
| 3a | — | Standard |
| 3b | 3a | Standard |
| 3c | 0b, 0c, 2a, 3b | Significant — schema migration |
| 4a | 3b | Standard |
| 4b | 3c, 4a | Significant — new permission keys |
| 5a | — | Significant — authorisation change |
| 5b | 2b, 4b, 5a | Significant — enum and schema change |
| 6a | — | Significant — new sub-processor |
| 6b | 3a, 6a | Significant — new model egress path |
| 6c | 4b, 6b | Significant — schema migration, and tenant data sent to a model |
| 6d | 6c; for Jev, also 6a's notice window closed | Significant — deployment change and sub-processor activation |

Change classes follow `docs/change-management-policy.md`.

### Global rules

These bind every step. The prompts point here rather than restating them.

1. **The design document is the source of truth for intent.** If the code contradicts
   a fact in it, the code wins and the pull request says so. If a step would have to
   deviate from the design, stop and ask.
2. **Legacy code never writes a directory table.** `IdentityAccountLink` and
   `ConnectedIdentityAccount` are read-only to everything built here. From Step 0a
   onward, CI enforces it.
3. **Only a strong deterministic signal produces `LINKED`.** No other path —
   similarity, conventions, the model, a bulk action — may create a link without a
   person confirming it.
4. **Fail closed, and never silently.**
   - A truncated, torn, drifted, partial or unauthenticated read is recorded with a
     named reason. It is never reported as complete.
   - A row that cannot be keyed fails the pull; it is never dropped. An account
     missing from a snapshot is an account nobody reviews.
5. **Legacy data is untrusted input.** It is size-bounded, validated by schema,
   rendered only as text, never logged row by row, and never reaches a model except
   through the AI Guard.
6. **Every new tenant table gets:**
   - the RLS migration triple;
   - a `tenantId`-leading index;
   - a two-tenant behavioural test registered in
     `tests/guardrails/tenant-isolation-forward-lock.test.ts`;
   - a row in `docs/data-retention.md`;
   - a decision in the encryption manifest.
7. **Every new route** uses `requirePermission(...)` with a rule in
   `src/lib/security/route-permissions.ts`. Admin routes are listed in
   `tests/guardrails/admin-route-coverage.test.ts`.
8. **Test behaviour, not shape.**
   - Each step ships tests that fail when the behaviour regresses.
   - A new guard is named for the invariant it protects, never for the step:
     `tests/guards/no-epic-named-ratchets.test.ts` rejects names like `p2a-…`.
   - Structural rules prefer an ESLint rule (`eslint-rules/README.md`).
   - Source scans take their population from git (`tests/helpers/repo-files.ts`).
   - Assertions bind to the construct they name (`tests/helpers/source-blocks.ts`).
9. **Migrations are additive and forward-only.** Columns are nullable or defaulted,
   enum values are only ever added, and nothing is backfilled inside a migration. A
   step with a migration or a security-boundary change is Significant: its pull request
   carries a rollback plan and a risk assessment.
10. **Stop and ask — do not improvise — if a step seems to need any of these:**
    - a write to a directory table;
    - any relaxation of `safeFetch`, or a private address a tenant can configure;
    - a model call outside Steps 6b–6d, or any model other than the pinned Jev and
      Laya revisions;
    - customer data reaching TypeSafe before Step 6d activates it;
    - a change to `emailKey()`, to how `ConnectedIdentityAccount.email` is derived,
      or to `Employee.fullName` — the JML chain depends on all three byte for byte.

### Definition of done

Every step, without exception:

- one branch and one pull request, driven to green and merged under the working
  agreements in `CLAUDE.md`;
- the step's hardening checklist in the pull-request body, every item ticked beside the
  test that proves it;
- an implementation note in `docs/implementation-notes/<date>-<slug>.md`. It needs no
  classification entry, because that subtree is classified by path;
- the step's row in the status table above updated;
- anything the step made true moved from the design document's Roadmap into its
  Current state, so that document stays accurate;
- the `CLAUDE.md` section "Legacy access recertification", created in Step 0a,
  updated with any invariant the step introduced. Every later session loads it
  automatically, which is how these rules reach sessions that never read this file.

---

### Phase 0 — Prerequisites

#### Step 0a — Guard the directory tables against a second writer

**Goal.** Make it impossible to write `IdentityAccountLink` or `ConnectedIdentityAccount`
from anywhere but their existing seams — before any legacy code exists — and put the
subsystem's invariants where every later session will read them.

```text
You are implementing Step 0a of docs/legacy-access-recertification-phases.md in this
repository. Before writing code, read that document's "Global rules", "Definition of
done" and all of "Step 0a", then docs/legacy-access-recertification-design.md,
section "Architecture: a separate snapshot subsystem".

Goal: CI fails if any source file other than the existing write seams creates,
updates, upserts or deletes an IdentityAccountLink or ConnectedIdentityAccount row.

1. Find every file under src/ that writes either table today. Look for Prisma
   delegate calls (create, createMany, update, updateMany, upsert, delete, deleteMany)
   through any client alias (prisma, db, tx and so on), and for raw SQL that mutates
   either table. CLAUDE.md names the seams: identity-account-link.ts for links, and
   identity-sync.ts plus identity-account-protection.ts for accounts. If reality
   differs, stop and report the difference before writing the guard. Do not silently
   allowlist a writer that CLAUDE.md does not name.
2. Write the guard. Model it on tests/guards/employee-status-single-write-seam.test.ts,
   or write an ESLint rule if the decision tree in eslint-rules/README.md says a rule
   fits better — but raw SQL must be covered either way. Name it for the invariant,
   for example tests/guards/directory-identity-tables-single-write-seam.test.ts.
3. Prove it is not vacuous. Feed the detector an in-memory second writer for each
   table, one per detection path (delegate call, aliased transaction client, raw SQL),
   and assert that each is caught.
4. Add a section "Legacy access recertification" to CLAUDE.md, next to "Identity
   lifecycle — JML". State the binding invariants:
   - legacy code never writes a directory table;
   - only a strong deterministic signal produces LINKED;
   - legacy data is untrusted input;
   - the design and phases documents are the source of truth.
   Keep it short; later steps extend it.

Deliver per the Definition of done.
```

**Hardening**

- [ ] The allowlist comes from a scan of `src/`. Any writer that `CLAUDE.md` does not name is reported in the pull request, not allowlisted.
- [ ] Every write verb is detected — `create`, `createMany`, `update`, `updateMany`, `upsert`, `delete`, `deleteMany` — through any client alias, including a transaction client.
- [ ] Raw SQL that mutates either table is detected (`$executeRaw`, `$executeRawUnsafe`, and `$queryRaw` carrying `INSERT`, `UPDATE` or `DELETE`).
- [ ] A mutation test injects one synthetic second writer per detection path, and the guard fails on each.
- [ ] The scan's population comes from git, not a directory walk.
- [ ] Assertions bind to the construct they check, and both assertion-reach ratchets stay at or below their baselines.
- [ ] The guard's name describes the invariant.
- [ ] The design document's "Guards that do not yet exist" bullet is updated.

**Exit.** CI fails when any file outside the seams writes either table, and the mutation test proves the guard sees all three write paths.

#### Step 0b — Persist directory login names

**Goal.** Store the login names that legacy applications usually copy —
`sAMAccountName` and UPN from Active Directory, UPN and `mailNickname` from Entra ID —
so that the directory bridge has something to match.

```text
You are implementing Step 0b of docs/legacy-access-recertification-phases.md. Read its
"Global rules", "Definition of done" and "Step 0b", then the subsection of the design
document's "Current state" on inputs that are thrown away. Step 0a is merged, and its
guard must stay green.

Goal: after a directory sync, ConnectedIdentityAccount rows carry the account's login
names, and nothing the JML chain depends on has changed.

1. Add nullable columns samAccountName, userPrincipalName and mailNickname to
   ConnectedIdentityAccount in prisma/schema/personnel.prisma. Additive migration, no
   backfill: the next sync fills them.
2. Add matching optional fields to NormalizedIdentityAccount in
   src/app-layer/integrations/providers/identity/types.ts.
3. Active Directory already requests sAMAccountName and userPrincipalName; map both.
   For Entra ID, add userPrincipalName and mailNickname to the Graph $select and map
   them. Leave Okta and Google Workspace null.
4. Persist the new fields in the identity-sync upsert
   (src/app-layer/usecases/identity-sync.ts), in both the create and the update. Do
   not touch the protection columns that the update deliberately leaves out.
5. Do NOT change how the email field is derived for any provider. The JML link
   reconcile and the leaver pass depend on it byte for byte.

Tests: provider fixtures map each new field; the sync persists them and overwrites
them on a later sync; and a regression test proves every provider's derived email is
unchanged for a fixed set of fixtures.

Deliver per the Definition of done. This step is Significant (schema migration).
```

**Hardening**

- [ ] Every provider's derived `email` is byte-identical before and after, proven by a fixed-fixture regression test.
- [ ] The migration is additive, nullable and not backfilled, and old containers keep working through a rolling deploy.
- [ ] Values are treated as untrusted: length-capped, with control characters stripped, before storage.
- [ ] The Entra `$select` change leaves pagination, the account cap and the resume-token origin check unchanged, and `tests/unit/identity-resume-token-origin.test.ts` stays green.
- [ ] The Step 0a guard stays green, so no new writer was introduced.
- [ ] `docs/data-retention.md` records the new columns as PII, and the encryption-manifest guard passes or has a justified `NOT_SENSITIVE` entry.
- [ ] The pull request carries a rollback plan and a risk assessment.

**Exit.** After a sync, Active Directory accounts carry `sAMAccountName` and UPN, Entra accounts carry UPN and `mailNickname`, and every account's `email` is unchanged.

#### Step 0c — Persist structured HR names and real employee numbers

**Goal.** Stop discarding the name parts HR systems already send, and tell a real
employee number apart from the `workEmail` fallback.

```text
You are implementing Step 0c of docs/legacy-access-recertification-phases.md. Read its
"Global rules", "Definition of done" and "Step 0c", then the subsection of the design
document's "Current state" on inputs that are thrown away.

Goal: Employee rows carry structured name parts and — only when the HRIS really has
one — an employee number.

1. Add nullable columns givenName, familyName, middleName, preferredName, legalName and
   employeeNumber to Employee in prisma/schema/personnel.prisma. Additive migration,
   no backfill.
2. Extend NormalizedEmployee in src/app-layer/integrations/providers/hris/index.ts.
3. Map each provider from fields it already fetches:
   - BambooHR: firstName, lastName and employeeNumber.
   - OrangeHRM: first, middle and last name, and its human-facing employee id.
   - Workday: legalName and preferredName, and employeeId as employeeNumber.
4. Set employeeNumber ONLY from a real HRIS employee number. It never falls back to
   workEmail or to anything else. externalId keeps its existing fallback unchanged.
5. Persist the new fields in the HRIS sync upsert
   (src/app-layer/usecases/hris-sync.ts). Keep fullName derived exactly as it is
   today, because the joiner pass builds addresses from it.
6. Do NOT populate hrisRecordId for Workday. It carries write-back meaning in
   docs/jml-hris-write-back-design.md. If you believe it should be populated, stop
   and ask.

Tests: per-provider fixture mapping; a record without an employee number yields null,
never an email; and fullName is byte-identical to today for a fixed set of fixtures.

Deliver per the Definition of done. This step is Significant (schema migration).
```

**Hardening**

- [ ] `employeeNumber` is `null` — never an email — for every provider fixture that lacks one. A fallback here would let a work email pose as the strongest match signal there is.
- [ ] `fullName` is byte-identical before and after for a fixed set of fixtures.
- [ ] Status derivation is untouched, and `tests/guards/employee-status-single-write-seam.test.ts` stays green.
- [ ] Workday's `hrisRecordId` is not populated.
- [ ] HRIS values are length-capped, with control characters stripped.
- [ ] The migration is additive, nullable and not backfilled.
- [ ] `docs/data-retention.md` records the new PII columns on the `Employee` row.
- [ ] The pull request carries a rollback plan and a risk assessment.

**Exit.** After an HRIS sync, employees carry name parts and, where the HRIS has one, a real employee number, and `fullName` is unchanged.

---

### Phase 1 — The pipe

#### Step 1a — Publish the contract and a fake server

**Goal.** Fix the wire contract `inflect-legacy-access/1` in Zod, document it for
operators, and build a fake server that serves both as the executable reference and as
the fault injector for every later test.

```text
You are implementing Step 1a of docs/legacy-access-recertification-phases.md. Read its
"Global rules", "Definition of done" and "Step 1a", then the design document's section
"1. Resources versus tools".

Goal: one source of truth for the contract, a document operators can build against,
and a fake server that proves both.

1. Write Zod schemas for the manifest and page resources in
   src/lib/mcp/client/contract.ts, versioned "inflect-legacy-access/1". The envelope
   is strict. A row is a record from column name to scalar. Bound every size: column
   count, column-name length, snapshotId length, rows per page, pages per snapshot.
2. Write docs/legacy-mcp-access-contract.md, class authoritative, in normative MUST /
   SHOULD language. Cover:
   - transport: streamable HTTP, JSON responses only;
   - resource URIs and response shapes;
   - the snapshotId rule;
   - the ?fields= projection rule;
   - limits and authentication;
   - what the client refuses.
   Register it in docs/_status/doc-classification.json.
3. Write tests/helpers/legacy-mcp-fake-server.ts: an in-process handler, Web Request to
   Response, implementing initialize, notifications/initialized and resources/read for
   the manifest and pages, honouring ?fields=. Keep its conforming path clean and
   commented; the contract document names this file as the reference implementation.
4. Add named faults that can be switched on independently:
   - torn snapshot;
   - oversharing (extra columns);
   - oversized page;
   - slow response;
   - malformed JSON;
   - a server-sent-event response;
   - an unsupported protocol version;
   - tools advertised;
   - a redirect;
   - schema drift between pulls;
   - a duplicate accountKey;
   - a row with no accountKey;
   - a secret-shaped value.

Tests: the fake server's conforming output validates against the schemas; each fault
is observable; the schemas reject oversized input and unknown versions.

Deliver per the Definition of done.
```

**Hardening**

- [ ] The contract is versioned, and the schema rejects an unknown major version.
- [ ] Every dimension has an upper bound in the schema, and Step 1b will enforce the same bounds whatever a server claims.
- [ ] Column names are length-capped and free of control characters, because they reach the mapping UI.
- [ ] Every fault in the prompt exists, and a test shows each one firing.
- [ ] The contract document names the fake server as the reference implementation, so the suite exercises the reference and it cannot drift from the contract.
- [ ] The contract document is registered and passes `tests/guardrails/docs-accuracy.test.ts`.

**Exit.** The schemas are merged, the contract is published, and the fake server serves a conforming snapshot and can inject every named fault.

#### Step 1b — The MCP client

**Goal.** A minimal client that reads a conforming server's manifest and pages — and
refuses everything else.

```text
You are implementing Step 1b of docs/legacy-access-recertification-phases.md. Read its
"Global rules", "Definition of done" and "Step 1b", the design document's sections
"1. Resources versus tools" and "Security and reachability", and
docs/legacy-mcp-access-contract.md.

Goal: src/lib/mcp/client/ pulls a snapshot from a conforming server, and fails closed
on every deviation.

1. Build the client in src/lib/mcp/client/, reusing the JSON-RPC types in
   src/lib/mcp/protocol.ts and the schemas in contract.ts. It is pure transport: no
   database, no tenant context.
2. Send every HTTP request through safeFetch
   (src/app-layer/automation/webhook-safety.ts). The only test seam is an injected
   fetch implementation, and production code must never pass one.
3. initialize:
   - advertises capabilities {} exactly;
   - negotiates a protocol version from the set src/lib/mcp/protocol.ts supports, and
     refuses anything else;
   - echoes Mcp-Session-Id if the server issues one, and sends the negotiated version
     on later requests;
   - requires the server to advertise resources.
4. Use only initialize, notifications/initialized and resources/read. Never call a
   tools/* method, even when the server advertises tools.
5. Accept application/json only, and refuse a text/event-stream response. Read every
   body through a byte-capped stream that aborts at the cap — never read an uncapped
   body into memory. Enforce a per-request deadline and page, row and total caps.
6. Every page's snapshotId must equal the manifest's; otherwise throw a torn-snapshot
   error. Return { manifest, rows, complete, reason }, and never report complete when
   any check failed.
7. Use typed errors: contract violation, torn snapshot, cap exceeded, SSRF blocked,
   authentication failed, timeout.

Tests: drive every Step 1a fault through the injected-fetch seam, and assert the typed
error and complete: false for each.

Deliver per the Definition of done. This step is Significant (new egress path).
```

**Hardening**

- [ ] Production code cannot bypass `safeFetch`:
  - the client is added to `SINKS` in `tests/guards/ssrf-egress-coverage.test.ts`;
  - a structural rule fails if code under `src/` passes an injected fetch to the client;
  - the same rule fails if code in `src/lib/mcp/client/` calls `fetch` or `resilientFetch` directly.
- [ ] Redirects, `http:`, and private, loopback, link-local and metadata addresses are refused. `safeFetch` supplies this; a test proves the client surfaces each as a typed error.
- [ ] The `initialize` body carries `capabilities: {}` exactly.
- [ ] No `tools/*` request is ever sent, proven by the fake server's request log while it advertises tools.
- [ ] A server-sent-event response is refused.
- [ ] The oversized-page fault aborts at the byte cap without buffering the body.
- [ ] A torn snapshot produces an error and `complete: false`.
- [ ] The bearer token appears in no error message, log line or thrown object, proven by searching serialised errors for it.
- [ ] Only counts and identifiers are logged, through the observability logger. No row contents are logged.
- [ ] The pull request carries a rollback plan and a risk assessment.

**Exit.** A clean pull returns every row with `complete: true`; every fault yields its typed error and `complete: false`; and production code can reach the network only through `safeFetch`.

#### Step 1c — Register the `legacy-mcp` provider

**Goal.** An administrator can create, test and store a connection to a legacy
application's MCP server.

```text
You are implementing Step 1c of docs/legacy-access-recertification-phases.md. Read its
"Global rules", "Definition of done" and "Step 1c", and the design document's section
"Security and reachability".

Goal: legacy-mcp is a registered provider whose configuration is validated and whose
credential cannot be redirected.

1. Implement IntegrationProvider in
   src/app-layer/integrations/providers/legacy-mcp/index.ts:
   - id "legacy-mcp";
   - configFields: endpointUrl, plus an optional display name;
   - secretFields: bearerToken;
   - liveValidation: true;
   - validateConnection initialises through the Step 1b client, reads the manifest,
     and returns the column list.
2. Register it in src/app-layer/integrations/bootstrap.ts.
3. Classify endpointUrl in CONFIG_FIELD_RULES
   (src/app-layer/integrations/config-schema.ts):
   - add a "publicOrigin" rule kind that requires https: and passes checkWebhookUrl
     when the configuration is saved;
   - include that kind where redirectsStoredCredential derives host-bearing fields,
     so a host change cannot inherit the stored token.
   safeFetch re-checks the resolved addresses at use time.
4. Give legacy applications a category of their own: extend PROVIDER_CATEGORY, the
   hub page's CATEGORY_ORDER, and the en and bg messages.
5. Satisfy the guards that enumerate providers:
   - EXPECTED_PROVIDER_IDS;
   - credential placement;
   - the integrations-hub guard's locked keys;
   - an entry in docs/sub-processors.md saying the operator's MCP server is the
     customer's own system, not a sub-processor.
6. Validation failures give the operator an actionable message, and never echo the
   token or raw internals. The Test button must not call markAuthFailure; only
   background pulls do.

Deliver per the Definition of done. This step is Significant (configuration validation
is a security boundary).
```

**Hardening**

- [ ] `legacy-mcp` is classified in `CONFIG_FIELD_RULES`. An unclassified provider's configuration passes through unvalidated, and this one must not be such a provider.
- [ ] A test proves that changing the endpoint host without re-entering the token is refused.
- [ ] Private, loopback and metadata URLs, and `http:`, are refused when saved.
- [ ] A hostname that only *resolves* to a private address is refused when fetched.
- [ ] The token appears in no API response, validation message, log line or audit row.
- [ ] The Test button never marks a connection as auth-failed.
- [ ] Every guard that enumerates providers passes, and the pull request explains each change to a guard's list.
- [ ] Messages exist in both `en` and `bg`.
- [ ] The pull request carries a rollback plan and a risk assessment.

**Exit.** An administrator connects to the fake server and *Test* lists its columns; a private-address URL, and a host change without the token, are both refused.

---

### Phase 2 — Mapping and ingestion

#### Step 2a — Snapshot models and a fail-closed pull

**Goal.** Pull a snapshot through a stored mapping and keep only canonical fields,
with integrity evidence an auditor can re-derive.

```text
You are implementing Step 2a of docs/legacy-access-recertification-phases.md. Read its
"Global rules", "Definition of done" and "Step 2a", and the design document's sections
"2. Too many columns" and "Security and reachability".

Goal: an on-demand pull stores a snapshot that is either complete and verifiable, or
visibly not complete.

1. Write the canonical account schema (Zod) in src/lib/legacy-access/canonical.ts, and
   the mapping shape, with validation modelled on assertMappingComplete in
   src/app-layer/integrations/providers/servicenow/field-mapping.ts:
   - accountKey is required, plus at least one identity-bearing field;
   - the mapping lives in configJson, with a version and the column-set fingerprint it
     was confirmed against;
   - for now it is set through the API.
2. Enforce the design document's column denylist when a mapping is saved, and again
   at ingestion.
3. Create prisma/schema/legacy-access.prisma, following prisma/schema/README.md:
   - LegacyAccessSnapshot: the connection, the server's snapshotId, the mapping
     version, the column-set fingerprint, the payload hash and its algorithm version,
     the row count, the status, a refusal reason, and the pull time;
   - LegacyAccount: canonical fields only, plus entitlements, unique per snapshot and
     accountKey.
   Enums go in enums.prisma.
4. Write the pull usecase:
   - take the connection lock and open an IntegrationExecution;
   - run the client, requesting only mapped columns with ?fields=;
   - apply the mapping and write the snapshot and its accounts;
   - mark the snapshot COMPLETE only as the final act;
   - on 401 or 403, call markAuthFailure;
   - write a hash-chained audit event carrying the payload hash.
5. Compute the payload hash as SHA-256 over the mapped rows in canonical form — sorted
   keys, rows ordered by accountKey — so it can be recomputed from the stored rows.
6. Trigger the pull through an on-demand job declared in ON_DEMAND_JOBS, started from
   an admin route. Never pull inside a request.

Tests: every Step 1a fault yields a snapshot that is not COMPLETE and has a named
reason; the hash recomputed from the database equals the stored hash; no unmapped or
denylisted column reaches the database.

Deliver per the Definition of done. This step is Significant (schema migration).
```

**Hardening**

- [ ] A row with no `accountKey` fails the pull — `PARTIAL`, counted and named. It is never skipped: a missing account is an account nobody reviews.
- [ ] A duplicate `accountKey` in one snapshot fails the pull, rather than collapsing under an upsert.
- [ ] Schema drift — a column-set fingerprint different from the mapping's — refuses the pull, and no accounts are stored.
- [ ] Oversharing drops the extra columns and flags the connection `OVERSHARING`, proven by a database check that no extra column's value was stored.
- [ ] A denylisted column never reaches the database, even when the server sends it.
- [ ] A secret-shaped value (AI Guard patterns) refuses the pull, and nothing from that batch is stored.
- [ ] A crash part-way through writing leaves a snapshot that is not `COMPLETE`, and readers only ever use `COMPLETE` snapshots.
- [ ] The payload hash recomputes from the stored rows, and its algorithm version is recorded.
- [ ] The connection lock prevents concurrent pulls, and re-enqueuing a running pull does nothing.
- [ ] Both new tables meet global rule 6, and `tests/guardrails/prisma-schema-folder-coverage.test.ts` passes.
- [ ] The job's body references `tenantId`, and the job is registered in `ON_DEMAND_JOBS`.
- [ ] The pull request carries a rollback plan and a risk assessment.

**Exit.** A pull from the fake server stores a `COMPLETE` snapshot whose hash recomputes from the stored rows; every fault yields a snapshot that is not `COMPLETE`, with a named reason; and the database holds no unmapped or denylisted column.

#### Step 2b — Mapping UI and suggestions

**Goal.** Administrators map columns in the UI, guided by suggestions, without ever
seeing raw sample data.

```text
You are implementing Step 2b of docs/legacy-access-recertification-phases.md. Read its
"Global rules", "Definition of done" and "Step 2b", the design document's section
"2. Too many columns", and the "UI Platform" section of CLAUDE.md.

Goal: a connection's mapping is built in the UI starting from suggestions, and is
re-confirmed after drift.

1. Write the suggestion engine in src/lib/legacy-access/mapping-suggest.ts. It is
   pure. It takes header names and per-column profile statistics — never raw values —
   and suggests a canonical target for each column, from a table of synonyms and from
   the statistics:
   - the share of values that look like emails, and the share that look like dates;
   - the ratio of distinct values;
   - small value sets, which mark status candidates.
2. Profiling reads the first page, requesting every column that is not denylisted,
   computes the statistics in memory and discards the rows. Denylisted names are never
   requested, not even for profiling. Nothing from profiling is persisted.
3. Add a mapping section to the connection page, built from the platform primitives
   (DataTable with a data-testid, Combobox, FormField). It shows each column, the
   suggestion, the chosen target and the profile statistics. Add:
   - a value-map editor for the status column, shown only when it has few distinct
     values;
   - a layout choice for entitlements, wide or long.
4. Saving is always an explicit act. It validates on the server, increments the mapping
   version, records the column-set fingerprint, and writes an audited diff.
5. After a drift refusal, show the columns added and removed, and require the mapping
   to be re-confirmed.

Deliver per the Definition of done.
```

**Hardening**

- [ ] The UI shows profile statistics only, never a raw sample value, proven by a rendered test.
- [ ] Profiling never requests a denylisted column, proven by the fake server's request log.
- [ ] Profiling persists nothing: no `LegacyAccount` rows exist after it runs.
- [ ] Column names render only as text. A column named like an HTML payload stays inert, and nothing uses `dangerouslySetInnerHTML`.
- [ ] No mapping is saved without an explicit save, even when every suggestion is accepted at once.
- [ ] The API, not only the UI, rejects an incomplete mapping and a mapping that targets a denylisted column.
- [ ] Each save increments the version and writes an audit event with the diff.
- [ ] The platform-primitive guards pass, and messages exist in both `en` and `bg`.

**Exit.** An administrator maps a forty-column fake table from suggestions, saves version 1 and pulls a `COMPLETE` snapshot; after the fake server adds a column, the next pull refuses until the mapping is re-confirmed.

---

### Phase 3 — Deterministic reconciliation

#### Step 3a — Normalisation library and labelled corpus

**Goal.** The pure normalisation functions, and the synthetic corpus that every later
reconciliation step is measured against. No database and no MCP, so this can start on
day one.

```text
You are implementing Step 3a of docs/legacy-access-recertification-phases.md. Read its
"Global rules", "Definition of done" and "Step 3a", and the design document's section
"3. Reconciliation — the critical path", especially Stage 0 and "Transliteration
without guessing".

Goal: deterministic, total normalisation functions in src/lib/identity/reconcile/, and
a labelled corpus that later steps are measured against.

1. normalise.ts:
   - Email: build on emailKey (src/lib/identity/email-key.ts) without modifying it.
     Add domain equivalence and +tag stripping as a separate layer.
   - Names: apply NFKC. Transliterate each Cyrillic token from its NFC form BEFORE
     folding diacritics, and only then NFD-strip marks from the Latin result. Parse
     "Last, First", middle names, suffixes and honorifics. Lift parenthetical tags into
     a field of their own.
   - Usernames: split on . _ - and case changes. Keep a DOMAIN\ prefix as a qualifier.
     Separate UPN suffixes and trailing numeric disambiguators.
   - Employee numbers: strip prefixes and leading zeros.
   - Mixed-script tokens: a token that mixes Latin letters with Cyrillic look-alikes
     gets an extra candidate with the look-alikes folded to Latin. A purely Cyrillic
     token is transliterated, never look-alike-folded.
2. Transliteration:
   - Implement Bulgaria's Streamlined System (the 2009 transliteration law) as an
     in-house table, including its word-final rule: ия becomes ia (София → Sofia).
   - For a generic scheme, either promote @sindresorhus/transliterate to a direct
     dependency under docs/dependency-governance.md, or write a small in-house table.
     Record the choice in the implementation note.
   - Every variant records the scheme that produced it.
3. Do NOT reuse normalizeForScan (src/app-layer/ai/guard/normalize.ts) for names. Its
   look-alike fold maps Cyrillic в to b and р to p, which destroys real names, and it
   appends decoded base64. Reuse only its zero-width and bidi stripping, by extracting
   a shared helper.
4. Build a synthetic corpus in tests/fixtures/identity-reconcile/. Each case holds a
   legacy account, an HR slice, a directory slice, the expected outcome and the
   expected employee. Cover every category in the design document's "Proving it
   works", plus:
   - the й and ё cases;
   - mixed-script tokens;
   - names built to make a naive regular expression backtrack.

Tests: every normalisation function against the corpus's expected normal forms, and a
bounded run over the pathological inputs.

Deliver per the Definition of done.
```

**Hardening**

- [ ] Transliteration runs before diacritic folding: under the Streamlined System, `Йордан` becomes `Yordan` and `Николай` becomes `Nikolay`, not `Iordan` and `Nikolai`.
- [ ] The word-final rule holds: `София` becomes `Sofia` and `Мария` becomes `Maria`.
- [ ] `normalizeForScan` is never applied to identity data, and a test asserts that `Иванов` survives as a transliteration rather than as `Иbaнob`.
- [ ] Look-alike folding applies only to tokens that mix scripts.
- [ ] `emailKey` is unmodified, and its existing tests are untouched and green.
- [ ] Every function is total. It never throws on empty, huge, control-character or unpaired-surrogate input, and every input is length-capped.
- [ ] No regular expression backtracks catastrophically. Each is linear by construction, and the pathological inputs finish within a bound measured in operations, not wall-clock time.
- [ ] Output order is deterministic, so identical input produces identical variant lists.
- [ ] The corpus is synthetic — no real names, emails or national identifiers — and its header says so.
- [ ] If a dependency was added, it went through `docs/dependency-governance.md`.

**Exit.** Normalisation reproduces the corpus's expected forms — both transliteration schemes, the `й` and `ё` cases, and mixed-script tokens — and the pathological inputs finish in linear time.

#### Step 3b — The deterministic engine and the precision ratchet

**Goal.** A pure engine that resolves each account to exactly one of the five outcomes
using strong signals and vetoes, with a 100 % precision ratchet in CI. Still no
database.

```text
You are implementing Step 3b of docs/legacy-access-recertification-phases.md. Read its
"Global rules", "Definition of done" and "Step 3b", and Stages 1 to 3 of the design
document.

Goal: src/lib/identity/reconcile/engine.ts exports a pure function. It takes canonical
accounts, a roster, a directory index, confirmed aliases, configuration and an
explicit `now`, and returns exactly one resolution per account.

1. Each resolution carries its outcome, its method, the signals behind it, its top
   candidates with their scores, and any vetoes. The function has no I/O and no clock.
2. Classify NON_PERSON before any matching.
3. Blocking: candidates come only from shared keys. Instrument the number of
   comparisons made.
4. Strong signals:
   - CONFIRMED_ALIAS;
   - EMPLOYEE_NUMBER, from real numbers only;
   - EMAIL_EXACT, with domain equivalence;
   - DIRECTORY_BRIDGE. The caller supplies only fresh, uncontradicted links, and the
     engine requires the username to match exactly one of them across every directory
     connection.
5. Vetoes, each of which beats every score:
   - conflicting employee numbers;
   - conflicting emails in the same domain;
   - an account createdAt later than the candidate's endDate.
6. Decide: LINKED only from a strong signal held by exactly one candidate, with no
   veto and a consistent timeline. The re-keyed person rule yields SUGGESTED, never
   LINKED.
7. Leave clear extension points for naming conventions and similarity (Step 4a).
8. Write tests/unit/identity-reconcile-precision.test.ts. It runs the engine over the
   Step 3a corpus and fails on any false LINKED. It reports recall and routing rates,
   but does not gate on them.

Deliver per the Definition of done.
```

**Hardening**

- [ ] Auto-link precision on the corpus is 100 %, and a single false `LINKED` fails CI.
- [ ] An exhaustive table of every combination of medium and weak signals never yields `LINKED`.
- [ ] An exhaustive test shows that any veto prevents a link to the vetoed candidate.
- [ ] Two candidates tied on the strongest signal yield `AMBIGUOUS`, never a pick.
- [ ] Outcomes are unchanged when both the accounts and the roster are shuffled, so no result depends on input order.
- [ ] The re-keyed rule yields `SUGGESTED` even when the signal onto the terminated record is strong.
- [ ] A `sAMAccountName` present in two directory connections produces no directory bridge.
- [ ] At a large synthetic scale, comparisons stay within a stated multiple of the input size, measured by count rather than time.
- [ ] Identical inputs produce byte-identical output.
- [ ] The module imports nothing that touches the database.

**Exit.** The engine resolves every corpus case to exactly one outcome with a recorded method, produces no false `LINKED`, and gives the same outcomes however its input is ordered.

#### Step 3c — Persist results and the crosswalk

**Goal.** Run the engine on real `COMPLETE` snapshots behind the freshness gates, and
persist immutable per-snapshot results alongside the durable crosswalk.

```text
You are implementing Step 3c of docs/legacy-access-recertification-phases.md. Read its
"Global rules", "Definition of done" and "Step 3c", and the design document's Stage 3
freshness gates and Stage 4. Steps 0b, 0c, 2a and 3b are merged.

Goal: a reconciliation run on a COMPLETE snapshot stores one immutable result per
account, or refuses as a whole with a named reason.

1. Add models to prisma/schema/legacy-access.prisma:
   - LegacyAccountResolution: one immutable row per account per run — outcome,
     method, signals, candidates, vetoes, and the run it belongs to;
   - LegacyIdentityAlias: the durable crosswalk from (connection, accountKey) to an
     employee — method, who confirmed it, when, the signals they were shown, and a
     status of ACTIVE or SUSPENDED.
   Add LegacyResolutionOutcome and LegacyMatchMethod to enums.prisma.
2. Write the usecase src/app-layer/usecases/legacy-reconcile.ts. It:
   - refuses unless the snapshot is COMPLETE;
   - refuses with NO_FRESH_ROSTER unless the latest HRIS sync PASSED within the
     freshness window;
   - builds the directory index by reading IdentityAccountLink and
     ConnectedIdentityAccount, with the same freshness predicate findLeaverCandidates
     applies: lastVerifiedAt within the window, contradictedAt null;
   - loads the active aliases, runs the engine, and writes the results as one run.
3. Record each run as an IntegrationExecution, and emit a metric with counts per
   outcome (item 4 of docs/new-subsystem-checklist.md).
4. This step only reads aliases. Step 4b writes them.

Deliver per the Definition of done. This step is Significant (schema migration).
```

**Hardening**

- [ ] A snapshot that is not `COMPLETE` is refused, and no results are written.
- [ ] A stale or non-`PASSED` HRIS sync refuses the whole run with `NO_FRESH_ROSTER`, and no results are written.
- [ ] A stale or contradicted directory link is never used as a bridge.
- [ ] Results are immutable: a second run writes a new set and never updates the old one.
- [ ] The Step 0a guard stays green; directory tables are only read.
- [ ] Both new tables meet global rule 6, including a two-tenant test proving a run never reads another tenant's roster, links or aliases.
- [ ] Each run emits counts per outcome.
- [ ] The pull request carries a rollback plan and a risk assessment.

**Exit.** A run on a `COMPLETE` fake-server snapshot stores exactly one result per account, and a stale roster refuses the whole run.

---

### Phase 4 — Assisted reconciliation and review

#### Step 4a — Naming conventions and similarity

**Goal.** Add the medium and weak signals — declared naming conventions and name
similarity — which move accounts from `UNMATCHED` to `SUGGESTED`, and never to
`LINKED`.

```text
You are implementing Step 4a of docs/legacy-access-recertification-phases.md. Read its
"Global rules", "Definition of done" and "Step 4a", and the design document's section
"Naming conventions are declared, not inferred".

Goal: the engine gains the NAMING_CONVENTION and NAME_SIMILARITY signals, and neither
can produce anything stronger than SUGGESTED.

1. src/lib/identity/reconcile/conventions.ts:
   - a small grammar: {first} {last} {f} {l} {middle} {m}, their upper-case forms,
     literal separators, and an optional numeric suffix {n?};
   - a parser that rejects anything outside the grammar;
   - a generator that produces each employee's expected username from their given and
     family names. If those parts are missing and fullName does not split into exactly
     two tokens, it generates nothing — never guess a split.
2. Collision check: a generated username held by two or more employees contributes
   AMBIGUOUS, never a pick.
3. Store conventions per connection in configJson, versioned and audited.
4. A convention proposer: given a snapshot and a roster, report for each grammar
   template the share of usernames it explains uniquely. A person adopts a template;
   nothing is adopted automatically.
5. Similarity: token-set ratio and Jaro-Winkler, implemented in-house, computed over
   normalised and transliterated forms, and only ever within a block.
6. Wire both into the Step 3b extension points. Add corpus cases; the precision
   ratchet must stay at 100%.

Deliver per the Definition of done.
```

**Hardening**

- [ ] A table test shows that neither signal ever produces `LINKED`.
- [ ] A convention collision — John and Jane Smith both generating `jsmith` — yields `AMBIGUOUS`.
- [ ] A mononym, a three-part name or a missing name part generates no convention candidate.
- [ ] Jaro-Winkler matches the published reference values: `MARTHA`/`MARHTA` 0.961, `DWAYNE`/`DUANE` 0.84, `DIXON`/`DICKSONX` 0.813.
- [ ] Similarity runs only within blocks, proven by comparison count.
- [ ] A candidate found through transliteration records its scheme, and is at most `SUGGESTED`.
- [ ] The grammar parser rejects unknown tokens and bounds template length.
- [ ] Convention changes are versioned and audited.
- [ ] The precision ratchet stays at 100 % with the new corpus cases.

**Exit.** On the corpus, conventions and similarity move cases from `UNMATCHED` to `SUGGESTED` with the correct top candidate, and add no `LINKED`.

#### Step 4b — Review queue and alias revalidation

**Goal.** People resolve what the engine could not; their confirmations become durable
aliases; and aliases revalidate every cycle without ever hiding a leaver.

```text
You are implementing Step 4b of docs/legacy-access-recertification-phases.md. Read its
"Global rules", "Definition of done" and "Step 4b", Stage 4 of the design document,
and the "UI Platform" section of CLAUDE.md.

Goal: a review queue for each legacy connection, confirmations that become aliases,
and revalidation that suspends only aliases that have become doubtful.

1. Build a queue page under the connection, on EntityListPage/DataTable, listing
   SUGGESTED, AMBIGUOUS and UNMATCHED accounts. A Sheet shows the mapped legacy
   record, the top candidates, and — signal by signal — why each scored as it did.
2. Actions:
   - confirm a candidate;
   - pick an employee manually, with a required justification (method MANUAL);
   - mark NON_PERSON, with a required active owner;
   - mark EXTERNAL (not in HR), with a required justification and expiry;
   - mark ORPHAN;
   - defer.
   Bulk confirmation is allowed only for SUGGESTED rows whose margin clears a
   threshold, and is capped in size. The server re-checks every row.
3. Add permission keys following the dotted convention in src/lib/permissions.ts, for
   example identity_reconciliation.view and identity_reconciliation.confirm. Enforce
   them with requirePermission, add them to route-permissions.ts and the coverage
   lists, and make sure custom roles can express them.
4. Confirming writes a LegacyIdentityAlias, and a hash-chained audit event recording
   the signals the reviewer was shown. A confirmation carries the version of the
   result it was made against, and returns 409 if a newer run has replaced it.
5. Revalidate aliases at each run. A departure NEVER suspends an alias — it makes the
   account a finding. Suspend only when:
   - the account's createdAt changed, meaning it was recreated;
   - its lifetime no longer fits the employment window;
   - the HR record was re-keyed;
   - the HR record disappeared.
   An expired EXTERNAL returns to the queue.
6. Emit metrics for the override rate and the queue size. Encrypt and sanitise
   reviewer notes and justifications.

Deliver per the Definition of done. This step is Significant (new permission keys).
```

**Hardening**

- [ ] A user without the confirm key is denied, and an `AUTHZ_DENIED` row is written.
- [ ] A two-tenant test proves a reviewer cannot confirm an employee from another tenant.
- [ ] A confirmation against a superseded result is refused with 409.
- [ ] Bulk confirmation is limited to `SUGGESTED` rows above the margin, is capped, is re-checked row by row on the server, and reports failures per row.
- [ ] **When an aliased employee leaves, the alias stays active and the account becomes a leaver finding**, proven by test.
- [ ] Each suspension trigger — recreation, a broken employment window, a re-key and a vanished record — has its own test.
- [ ] An expired `EXTERNAL` returns to the queue.
- [ ] `NON_PERSON` requires an active owner in the same tenant.
- [ ] Reviewer notes and justifications are in the encryption manifest and pass through `sanitizePlainText`, so `tests/guardrails/sanitize-rich-text-coverage.test.ts` stays green.
- [ ] Each confirmation's audit event records the signals the reviewer was shown.
- [ ] The override-rate metric is emitted.
- [ ] The pull request carries a rollback plan and a risk assessment.

**Exit.** A reviewer clears the fake snapshot's queue; the next run resolves every confirmed account as `CONFIRMED_ALIAS` with no human action; a user without the key cannot confirm, and the denial is audited.

---

### Phase 5 — Recertification campaigns

#### Step 5a — Harden the existing access-review flows

**Goal.** Fix the connected access review and put audited permission keys on access
reviews — for the directories that use them today, and before legacy subjects arrive.
This step needs nothing new and can start on day one.

```text
You are implementing Step 5a of docs/legacy-access-recertification-phases.md. Read its
"Global rules", "Definition of done" and "Step 5a", and the recertification subsection
of the design document's "Current state".

Goal: connected reviews become complete, evidenced and properly authorised — without
changing who may do what today.

1. Add permission keys for access reviews, following the dotted convention in
   src/lib/permissions.ts: for example access_reviews.view, .create, .decide and
   .close. The default role grants must reproduce today's outcomes exactly:
   - create and close wherever canAdmin allows them now;
   - decide for the assigned reviewer or an admin, keeping the assigned-reviewer rule
     in the usecase;
   - view wherever reads are allowed now.
   Enforce them with requirePermission, add rules to route-permissions.ts, and add
   access-reviews to PRIVILEGED_ROOTS.
2. Render connected decisions on the detail page:
   src/app/t/[tenantSlug]/(app)/access-reviews/[reviewId]/AccessReviewDetailClient.tsx,
   and the include in src/app-layer/repositories/AccessReviewRepository.ts. Enable
   Close only when every connected decision is made.
3. Refuse to create a connected review with zero subjects (NO_SUBJECTS). Zero accounts
   means a broken sync, not an empty application.
4. On close, produce an evidence PDF with a content hash, following
   src/app-layer/reports/pdf/accessReview.ts. Optionally attach it as Evidence, linked
   to controls the review's creator selects.
5. Count connected decisions in src/app-layer/jobs/access-review-reminder.ts and
   src/app-layer/jobs/access-review-overdue-escalation.ts.
6. Scope subject references to the connection (connectionId:externalUserId) for new
   reviews, so duplicates across connections stop merging. Flag a snapshot that was
   truncated at the cap.
7. Add HR context to each subject's snapshot — the linked employee, their employment
   status, manager and department — by reading IdentityAccountLink, never writing it.

Deliver per the Definition of done. This step is Significant (authorisation change).
```

**Hardening**

- [ ] A role-by-action table test shows every allow and deny outcome is identical to before, and every deny now writes `AUTHZ_DENIED`.
- [ ] A review with undecided connected subjects cannot close, and the old zero-equals-zero bug has a regression test.
- [ ] A connected review with zero subjects cannot be created.
- [ ] The evidence PDF's hash verifies, and the notes in it are sanitised.
- [ ] Two connections holding the same provider and email produce two subjects.
- [ ] A snapshot truncated at the cap is flagged, and the review cannot present itself as complete.
- [ ] Reminders and escalations fire for connected reviews.
- [ ] HR context is only read, and the Step 0a guard stays green.
- [ ] The member-review tests stay green.
- [ ] The pull request carries a rollback plan and a risk assessment.

**Exit.** An Entra connected review shows its decisions, closes only when complete, produces a hashed PDF, and writes `AUTHZ_DENIED` for every denial.

#### Step 5b — Legacy recertification campaigns

**Goal.** Recertify a legacy application end to end, from a reconciled snapshot to a
closed campaign with evidence on the controls.

```text
You are implementing Step 5b of docs/legacy-access-recertification-phases.md. Read its
"Global rules", "Definition of done" and "Step 5b", and the design document's section
"Recertification campaigns". Steps 2b, 4b and 5a are merged.

Goal: a LEGACY_APP campaign is created from a reconciled snapshot, raises the design's
findings, and closes with evidence an auditor can tie to that exact snapshot.

1. Add LEGACY_APP to the access-review scope enum. Enum values are only ever added.
2. Creating a campaign requires:
   - a COMPLETE snapshot within the freshness window;
   - a completed reconciliation run for it;
   - at least one subject.
   Freeze the subjects into AccessReviewConnectedDecision, with subject reference
   connectionId:accountKey and a snapshot holding the canonical fields, the
   resolution and the HR context.
3. Compute each finding from the design document when the campaign is created, and
   show it as a badge:
   - leaver with live access;
   - orphan;
   - unresolved ambiguity;
   - dormant — a tenant setting, 90 days by default;
   - privileged;
   - non-person with no owner;
   - several accounts resolving to one person;
   - mover-suspect, found by comparing against the subject's last closed
     certification.
4. On close, produce the Step 5a evidence PDF. It must include the snapshot's payload
   hash, the mapping version, and each subject's resolution method. Link it as
   Evidence to the controls the creator selects, suggesting SOC 2 CC6.2 and CC6.3,
   NIS2 Art. 21(2)(i), and ISO/IEC 27001 A.5.16 and A.5.18 where the tenant has them
   installed.
5. REVOKE and MODIFY each create one task per account, idempotently, and optionally a
   ServiceNow ticket if a connection exists. Nothing is written to the legacy
   application.
6. Extend the "Legacy access recertification" section of CLAUDE.md into a full
   description of the subsystem.

Deliver per the Definition of done. This step is Significant (enum and schema change).
```

**Hardening**

- [ ] Creation refuses a missing, stale, incomplete or unreconciled snapshot, and zero subjects, each with a named reason and a test.
- [ ] A campaign's subjects are frozen: a later pull changes nothing in an open campaign.
- [ ] Every finding type has a fixture and a test, and no other state ever suppresses a leaver with live access.
- [ ] Deciding requires the decide permission together with the reviewer-or-admin rule.
- [ ] Closing twice creates no duplicate tasks.
- [ ] The evidence PDF carries the payload hash, the mapping version and the resolution methods, and a test re-derives the hash from the stored rows and matches it.
- [ ] The legacy client exposes no write operation, and nothing sends a `tools/*` call.
- [ ] New relations meet global rule 6.
- [ ] The pull request carries a rollback plan and a risk assessment.

**Exit.** A `LEGACY_APP` campaign on the fake server's application shows every finding in its fixture, closes with a PDF carrying the snapshot hash, links its evidence to the SOC 2 and NIS2 controls, and creates revoke tasks.

---

### Phase 6 — Model adjudication (Jev and Laya)

Four steps. **Step 6a is paperwork, and it should start on day one.** TypeSafe's 30-day
customer-notice window is the longest fixed wait in this plan, and it can elapse while
everything else is built.

#### Step 6a — Register TypeSafe as a proposed sub-processor

**Goal.** Start the 30-day clock, so that Jev can be switched on as soon as the code is
ready. No code changes.

```text
You are implementing Step 6a of docs/legacy-access-recertification-phases.md. Read its
"Global rules", "Definition of done" and "Step 6a", the design document's section
"Model adjudication — Jev external, Laya local", docs/sub-processor-change-policy.md
and docs/sub-processors.md.

Goal: TypeSafe AI is recorded as a proposed, inactive sub-processor, legal review is
on the pull request, and customers are notified. Nothing in src/ changes.

1. Add a TypeSafe AI row and a detail subsection to docs/sub-processors.md, following
   the existing entries. State:
   - the data shared per residue account: the allowlisted identity fields of one legacy
     account and of up to five HR candidates, exactly as the design document lists
     them — no email domains, employee numbers, dates or employment status;
   - the purpose: identity adjudication for legacy access recertification;
   - the region, the US West Coast, and the transfer mechanism, Standard Contractual
     Clauses, noting that the vendor is not certified under the EU-US Data Privacy
     Framework;
   - that it is optional: nothing is sent unless a tenant selects EXTERNAL;
   - its status: proposed and inactive, naming the planned calling module,
     src/app-layer/ai/identity-match/.
   docs/sub-processors.md is an authoritative document, so write in the present tense;
   tests/guardrails/docs-accuracy.test.ts rejects future-tense markers in it.
2. Request compliance and legal review on the pull request, as the policy's step 2
   requires. Cover:
   - the transfer mechanism;
   - the vendor's own DPA;
   - zero data retention written into the signed DPA;
   - the vendor's commitment not to train on customer data.
3. Once approved, send the customer notice described in the policy's step 3. Record the
   notice date, and the date the window closes, in the detail subsection.

Deliver per the Definition of done. This step is Significant (a new sub-processor).
```

**Hardening**

- [ ] The row names every class of field the payload carries, and no other.
- [ ] The row states that the processor is inactive, and nothing in `src/` refers to TypeSafe.
- [ ] `tests/guardrails/docs-accuracy.test.ts` and `tests/guardrails/sub-processor-coverage.test.ts` are green.
- [ ] Legal approval is recorded on the pull request, including zero data retention in the signed DPA.
- [ ] The notice date and the window's closing date are recorded.

**Exit.** The inventory row is merged, the notice has gone out, and the date on which Jev may be activated is written down.

#### Step 6b — Decision-model client and evaluation harness

**Goal.** Inflect can ask Jev or Laya a typed question, and knows how far to trust the
answer, before any tenant data is involved.

```text
You are implementing Step 6b of docs/legacy-access-recertification-phases.md. Read its
"Global rules", "Definition of done" and "Step 6b", and the design document's section
"Model adjudication — Jev external, Laya local". Steps 3a and 6a are merged.

Goal: a client for the System One wire API, with a Jev and a Laya provider, and
evaluation records that decide whether a model revision may produce verdicts at all.
Synthetic data only; nothing tenant-facing changes.

1. Re-verify every row of the design document's "What the vendors publish" table
   against the vendors' current API references and model cards. Where one differs,
   the reference wins: the code follows it, and this pull request corrects the table.
2. src/app-layer/ai/identity-match/systemone-wire.ts:
   - build requests (model, state, questions) for the choice and noul question types;
   - parse responses with a .strict() Zod schema: every option and field known, every
     probability in [0, 1], and the usage block required.
3. Providers, in the same directory:
   - JevDecisionProvider. The TypeSafe host is a code constant. The key is
     TYPESAFE_API_KEY, declared in src/env.ts; the Step 6a row satisfies
     tests/guardrails/sub-processor-coverage.test.ts. Add the constant
     TYPESAFE_SUBPROCESSOR_ACTIVE = false. While it is false, the factory never
     returns this provider for tenant work.
   - LayaDecisionProvider. It reads LAYA_BASE_URL and an optional LAYA_API_KEY,
     declared in src/env.ts and added to NON_SUBPROCESSOR_ALLOWLIST with their reasons.
     These are deployment configuration only; no tenant setting reaches them.
   - StubDecisionProvider. It answers nothing, ever.
   - getDecisionProvider(effectiveMode). It returns before constructing any external
     provider when the mode is LOCAL_ONLY.
   Each call has an AbortController timeout (Jev 3 s, Laya 2 s) and at most one retry
   on 429 or 5xx, honouring Retry-After within a deadline the caller passes in.
4. Extend tests/guards/ai-residency-enforcement.test.ts to the new factory, pinning its
   set of constructors, so that a new provider fails the test until someone classifies
   it.
5. Add src/app-layer/ai/identity-match/** to eslint-rules/agentic-path.js, stating the
   reason in that module's header: this path ingests attacker-shaped data from
   operator-hosted servers.
6. Build the adjudication corpus in tests/fixtures/identity-reconcile/adjudication/.
   It is synthetic, like the Step 3a corpus, and holds residue-shaped cases only:
   - name-only matches;
   - both transliteration schemes;
   - people with the same name in different departments;
   - service accounts that look like people;
   - display names written as instructions.
7. scripts/eval-identity-match.ts runs the corpus through a chosen provider and writes
   src/app-layer/ai/identity-match/evaluations/<model>@<revision>.json, holding:
   - the raw answer to every case;
   - the corpus hash;
   - the derived thresholds;
   - a handful of canary cases.
8. tests/unit/identity-match-evaluation-records.test.ts recomputes, for every committed
   record, each verdict and each precision figure from the raw answers. It fails when:
   - AGREES precision is below 100 %;
   - any class falls below the minimum support you set, which is never lowered
     afterwards;
   - the corpus hash no longer matches the corpus.
9. Write a canary check that sends a record's canary states and compares the answers
   with the recorded probabilities, within 0.02.

If this session cannot reach the vendors' sites, TypeSafe or a Laya server, ship items
2–9 without committed records, and list in the pull request what remains. An operator
then does item 1 and produces the records. Until they exist, no revision has a record,
so no verdict can be produced — which is the safe default.

Deliver per the Definition of done. This step is Significant (a new model egress path).
```

**Hardening**

- [ ] Every row of the vendor table has been checked against a vendor reference, or the pull request names the rows still unverified.
- [ ] Under `LOCAL_ONLY`, no external provider is constructed, whatever the environment says. The residency guard covers the new factory, and its constructor set is pinned.
- [ ] While `TYPESAFE_SUBPROCESSOR_ACTIVE` is false, no tenant path can obtain a Jev provider.
- [ ] The response schema rejects an unknown option, an unknown field, a missing usage block and a probability outside [0, 1], each proven by its own test.
- [ ] The stub never answers, and a test proves no verdict can be derived from it.
- [ ] A timeout aborts the request, and the single retry never outlives the caller's deadline.
- [ ] The Jev host is a constant: no configuration can change the URL that `JevDecisionProvider` calls.
- [ ] `TYPESAFE_API_KEY` and the `LAYA_*` variables are classified in `tests/guardrails/sub-processor-coverage.test.ts`.
- [ ] The validator recomputes every figure from the raw answers. A record whose stated precision disagrees with its own answers fails CI.
- [ ] A record whose corpus hash no longer matches the corpus fails CI.
- [ ] The corpus is synthetic, and its header says so.
- [ ] `tests/guards/no-raw-prompt-logging.test.ts` covers the new directory.

**Exit.** Given a reachable endpoint, the harness produces a record that the validator accepts. The canary check rejects a deliberately perturbed answer. `LOCAL_ONLY` never constructs Jev.

#### Step 6c — Adjudication in the run, and the review lanes

**Goal.** A tenant that opts in has a verdict on every residue account before the queue
opens, and reviewers can clear agreed rows in bulk — while the model links no one.

```text
You are implementing Step 6c of docs/legacy-access-recertification-phases.md. Read its
"Global rules", "Definition of done" and "Step 6c", and the design document's section
"Model adjudication — Jev external, Laya local". Steps 4b and 6b are merged.

Goal: per-tenant adjudication of the residue at the end of each reconciliation run.
Verdicts annotate the queue and open a bulk lane; they never change an outcome or
create an alias.

1. Add the enum LegacyMatchAiMode (OFF, LOCAL_ONLY, EXTERNAL) and
   TenantSecuritySettings.legacyMatchAiMode, defaulting to OFF. Write it only through
   updateTenantSecurityConfig in src/app-layer/usecases/tenant-security-settings.ts:
   - the effective mode is the stricter of this setting and aiResidency;
   - refuse LOCAL_ONLY when LAYA_BASE_URL is unset;
   - refuse EXTERNAL under residency LOCAL_ONLY, and refuse it while
     TYPESAFE_SUBPROCESSOR_ACTIVE is false;
   - a change of mode writes its own audit event naming the new mode, the processor
     and its region. SECURITY_SETTINGS_UPDATED keeps recording field names only.
2. When the mode is enabled, provision a first-party RegisteredAgent: autonomy 2,
   tenant read scope, reversible. It must be scored before it may run. Check the kill
   switch and the circuit breaker before every batch, and record behaviour for the
   breaker.
3. Build the payload from the design document's allowlist:
   - label the content integration.legacy-mcp in src/lib/agentic/content-provenance.ts;
   - fence it with neutralizeUntrustedText, and run guardUntrustedInput before the
     call. A high-severity hit quarantines the account, whatever aiGuardMode says;
   - shuffle the candidates with a seed derived from the account id, withhold the
     engine's scores, and keep the letter-to-employee mapping on the server;
   - apply a pre-flight size cap that trims candidates from the bottom, never below
     two.
4. Add LegacyMatchVerdict to prisma/schema/legacy-access.prisma. It is immutable: one
   row per resolution per model revision. Each row holds either a verdict with its
   per-candidate probabilities, or a non-verdict reason, plus the model id, the
   revision and the latency. The reasons are NO_PROVIDER, NO_EVALUATION, MODEL_DRIFT,
   KILL_SWITCH, BREAKER_OPEN, QUARANTINED, OVER_BUDGET, TIMEOUT, DEADLINE and
   PROVIDER_ERROR.
5. Adjudicate at the end of each reconciliation run, in the job that runs it. If the
   run is ever triggered inside an HTTP request, move it to the on-demand job first.
   Then, in order:
   - write the run's results;
   - run the canary;
   - adjudicate the residue with Jev at 8 requests in flight, or Laya at 4, under a
     120-second deadline.
   An answer whose usage.input_tokens reaches the model's window is discarded as
   OVER_BUDGET.
6. Derive verdicts from the design document's table, using the thresholds in the
   evaluation record for the exact revision the endpoint reports. A verdict never
   writes LegacyAccountResolution.outcome, and never writes LegacyIdentityAlias.
7. In the Step 4b queue:
   - show each verdict with its probabilities;
   - add an AGREES bulk lane beside Step 4b's margin lane, limited to rows whose
     candidate is ACTIVE, with no veto, no privilege and no re-key. It works under the
     Step 4b cap and its row-by-row server re-check;
   - withhold 5 % of AGREES rows as a blind sample, chosen by a hash of the verdict id.
     They are shown without the verdict, kept out of the bulk lane, and compared with
     the reviewer's decision;
   - on a blind disagreement, close the AGREES lane for that revision for the rest of
     the cycle, and raise an alert.
   Confirming a PROPOSES pick records AI_PROPOSED_CONFIRMED. A ratified AGREES row
   keeps the engine's method and a reference to its verdict.
8. Write one AiDecisionLog row per verdict. It records the feature, the provider, the
   model and the input digest; the verdict class and top probability as its summary;
   the latency and the input tokens. Set sessionRef to the verdict id, and call
   recordDecisionOutcome on every reviewer decision.
9. Emit metrics:
   - a latency histogram per model;
   - verdicts by class;
   - non-verdicts by reason;
   - blind agreements and disagreements.
10. Add legacy-field attack vectors to tests/integration/prompt-injection-corpus.test.ts.

Deliver per the Definition of done. This step is Significant (a schema migration, and
tenant data sent to a model).
```

**Hardening**

- [ ] With no settings row, and with the mode `OFF`, nothing reaches any provider, proven by a spy on every provider.
- [ ] A table of mode against residency and the TypeSafe constant shows `EXTERNAL` is never effective under `LOCAL_ONLY` or while the constant is false. Saving either combination is refused.
- [ ] Saving `LOCAL_ONLY` without `LAYA_BASE_URL` is refused.
- [ ] A fake model that answers with an option outside the supplied letters has its answer discarded.
- [ ] No path leads from a verdict to `LINKED`, to a changed outcome, or to an alias, without a person confirming it. An import-graph test proves it, and the module imports nothing that writes aliases or resolutions.
- [ ] Seeded sensitive values never appear in any payload: an email domain, an employee number, a date, a national identifier.
- [ ] The same account and roster always produce the same candidate order, and that order does not follow the engine's ranking.
- [ ] An answer computed on truncated input is discarded as `OVER_BUDGET`.
- [ ] When the deadline passes, every remaining account carries a `DEADLINE` reason, and its queue row is identical to the one it would have with the mode `OFF`.
- [ ] With no evaluation record for the reported revision, every account gets `NO_EVALUATION`. After a failed canary, every account gets `MODEL_DRIFT`.
- [ ] With the kill switch engaged, no model call is made. An unscored agent is denied.
- [ ] Injection attempts in legacy fields are quarantined:
  - an instruction hidden in a display name;
  - forged chat-template tokens;
  - zero-width or look-alike obfuscation.
- [ ] Blind-sampled rows never enter the bulk lane, and one blind disagreement closes the lane for that revision.
- [ ] Every verdict has exactly one `AiDecisionLog` row, and a reviewer's decision stamps only that row.
- [ ] `LegacyMatchVerdict` meets global rule 6.
- [ ] The pull request carries a rollback plan and a risk assessment.

**Exit.** On the fake server's snapshot — with `LOCAL_ONLY` and a Laya endpoint, or a fake speaking the same wire API — every residue account receives a verdict or a named reason inside the deadline. A reviewer ratifies the `AGREES` rows in one action. With the mode `OFF`, no call is made. The model links no one.

#### Step 6d — Turn it on

**Goal.** Laya serves `LOCAL_ONLY` tenants from our own infrastructure, and Jev serves
`EXTERNAL` tenants once the notice window has closed.

```text
You are implementing Step 6d of docs/legacy-access-recertification-phases.md. Read its
"Global rules", "Definition of done" and "Step 6d", the design document's section
"Model adjudication — Jev external, Laya local", and the "Production VM" section of
CLAUDE.md. Step 6c is merged.

Goal: a vetted, pinned Laya service in every deployment that wants LOCAL_ONLY,
measured on the hardware it runs on; and Jev switched on only when the sub-processor
process allows it.

1. Choose the Laya server. Prefer the vendor's own serving entry point if one exists;
   otherwise vet a community server under docs/dependency-governance.md. Pin the image
   by digest, and the laya-multilingual checkpoint by revision.
2. Add a laya service to deploy/docker-compose.prod.yml, docker-compose.prod.yml and
   docker-compose.staging.yml. It is on the internal network only, publishes no port,
   has a health check on GET /v1/models, and has resource limits. Set LAYA_BASE_URL for
   the app and worker services.
3. Measure p50 and p95 latency over the adjudication corpus on the production VM's CPU,
   and record the figures in the design document. If a 500-account residue does not
   fit the 120-second deadline, raise the concurrency or add a GPU. Never raise the
   deadline silently.
4. Produce the Laya evaluation record on the deployed service, using the Step 6b
   harness. Confirm the canary passes before any tenant enables LOCAL_ONLY.
5. Apply the Compose change to the VM as CLAUDE.md describes: back up the file,
   validate with docker compose config, then run docker compose up -d laya.
6. Jev. Only once the Step 6a window has closed with no sustained objection, and zero
   data retention is confirmed in the signed DPA:
   - produce the Jev evaluation record;
   - set TYPESAFE_API_KEY in the VM's environment file, and never echo it;
   - in one pull request, flip TYPESAFE_SUBPROCESSOR_ACTIVE and mark the TypeSafe row
     in docs/sub-processors.md active. The pull request links the notice and states
     the date the window closed.
   If the window is still open when items 1–5 are done, merge those, and ship item 6
   as its own pull request later.
7. Write the runbook into the design document, covering:
   - turning the mode on and off;
   - reading non-verdict reasons;
   - what a closed AGREES lane means;
   - rotating the TypeSafe key.

Deliver per the Definition of done. This step is Significant (a deployment change and a
sub-processor activation).
```

**Hardening**

- [ ] The `laya` service publishes no port and is reachable only on the Compose network.
- [ ] Its image is pinned by digest and its checkpoint by revision, and the server went through `docs/dependency-governance.md`.
- [ ] The canary passes against the deployed service, and the evaluation record matches the revision it reports.
- [ ] The measured CPU latency is recorded, and a 500-account residue fits the deadline.
- [ ] `TYPESAFE_SUBPROCESSOR_ACTIVE` flips in a pull request that links the notice and shows that the window closed.
- [ ] No secret value appears in any log, commit, pull request or command output.
- [ ] Rollback is proven: setting the mode `OFF` stops every call from the next run, and flipping the constant back refuses `EXTERNAL` again.
- [ ] The pull request carries a rollback plan and a risk assessment.

**Exit.** A `LOCAL_ONLY` tenant gets Laya verdicts from our own infrastructure inside the deadline. An `EXTERNAL` tenant gets Jev verdicts only after the window has closed. Setting the mode `OFF` stops every model call.
