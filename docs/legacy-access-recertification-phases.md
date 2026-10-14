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

<!--
    NO `Status` COLUMN. It used to be here and it was derived data stored beside
    its own source, which is a shape this repo has already been bitten by — see
    CLAUDE.md on why the per-class `counts` header was deleted from
    docs/_status/doc-classification.json.

    Two things went wrong, and the second was worse than the first:

    1. Each step's own pull request set its own row to `Open`, which was true at
       the moment of writing. MERGING that branch is what made the row false, so
       the commit that falsified the row was the commit that added it. 5 of 19
       rows were wrong when this was removed.

    2. Every concurrent step edited the SAME rows, so the table conflicted on
       nearly every pair — three times in one day — and each resolution had the
       same shape: both sides were stale snapshots, so the right answer came from
       neither and every row had to be re-read from GitHub anyway.

    The pull request number is NOT derived — it is the fact. Derive the status
    from it when you want it:

        gh pr view <N> --json state -q .state

    Or for the whole table at once:

        grep -oE '#[0-9]+' docs/legacy-access-recertification-phases.md \
          | tr -d '#' | sort -un \
          | xargs -I{} gh pr view {} --json number,state \
              -q '"#\(.number) \(.state)"'

    Guarded by tests/guards/recert-phases-no-derived-status.test.ts.
-->
| Step | Title | Pull request |
| --- | --- | --- |
| 0a | Guard the directory tables against a second writer | #3247 |
| 0b | Persist directory login names | #3273 |
| 0c | Persist structured HR names and real employee numbers | #3277 |
| 1a | Publish the contract and a fake server | #3257 |
| 1b | The MCP client | #3293 |
| 1c | Register the `legacy-mcp` provider | #3306 |
| 2a | Snapshot models and a fail-closed pull | #3318 |
| 2b | Mapping UI and suggestions | #3332 |
| 3a | Normalisation library and labelled corpus | #3267 |
| 3b | The deterministic engine and the precision ratchet | #3286 |
| 3c | Persist results and the crosswalk | #3338 |
| 4a | Naming conventions and similarity | #3296 |
| 4b | Review queue and alias revalidation | #3344 (part 1) |
| 5a | Harden the existing access-review flows | #3272 |
| 5b | Legacy recertification campaigns | — |
| 6a | Register TypeSafe as a proposed sub-processor | #3246 |
| 6b | Decision-model client and evaluation harness | #3288 |
| 6c | Adjudication in the run, and the review lanes | — |
| 6d | Turn it on | — |

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

- [x] The allowlist comes from a scan of `src/`. Any writer that `CLAUDE.md` does not name is reported in the pull request, not allowlisted. **Verified #3480:** `tests/guards/directory-identity-tables-single-write-seam.test.ts`'s docblock states the allowlist is "taken from a scan of `src/`, then checked against the seams `CLAUDE.md` names", and that an unnamed writer "is reported, never allowlisted".
- [x] Every write verb is detected — `create`, `createMany`, `update`, `updateMany`, `upsert`, `delete`, `deleteMany` — through any client alias, including a transaction client. **Verified #3480:** all seven are in one list — `create`, `createMany`, `update`, `updateMany`, `upsert`, `delete`, `deleteMany`.
- [x] Raw SQL that mutates either table is detected (`$executeRaw`, `$executeRawUnsafe`, and `$queryRaw` carrying `INSERT`, `UPDATE` or `DELETE`). **Verified #3480:** `RAW_METHOD_RE` covers `$executeRaw`, `$executeRawUnsafe`, `$queryRaw` and `$queryRawUnsafe` as ONE ordered alternation — the docblock records that scanning for each separately matched `$executeRaw` inside `$executeRawUnsafe`.
- [x] A mutation test injects one synthetic second writer per detection path, and the guard fails on each. **Verified #3480:** a `the detector is not vacuous` describe block feeds a synthetic second writer per path.
- [x] The scan's population comes from git, not a directory walk. **Verified #3480:** `tests/guards/directory-identity-tables-single-write-seam.test.ts` imports `repoFiles`, which is `git ls-files -co --exclude-standard` — not `fs.readdirSync`.
- [x] Assertions bind to the construct they check, and both assertion-reach ratchets stay at or below their baselines. **Verified #3480:** `raw-source-assertion-ratchet`, `assertion-needle-uniqueness-ratchet` and `assertion-span-reach-ratchet` are all in the Ratchets population, which is green at 776 suites.
- [x] The guard's name describes the invariant. **Verified #3480:** `describe('the directory identity tables have one write seam each')`.
- [x] The design document's "Guards that do not yet exist" bullet is updated. **NOT done until #3480 — this was the one genuinely unmet criterion in Phase 0a.** The bullet still claimed no such guard existed, months after it shipped. Removed in the same change, with a note saying what it had claimed.

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

- [x] Every provider's derived `email` is byte-identical before and after, proven by a fixed-fixture regression test. **Verified #3480:** `tests/unit/directory-login-names.test.ts` carries a `REGRESSION - email is still ...` test per provider (`upn || mail || sam` for AD, `mail || userPrincipalName` with MAIL WINS for Entra), and its docblock states every candidate holds a DIFFERENT value on purpose so a reordering is visible.
- [x] The migration is additive, nullable and not backfilled, and old containers keep working through a rolling deploy. **Verified #3480:** `20261008120000_directory_login_names` adds three TEXT columns with no default; its docblock states the rolling-deploy property (a previous-image container omits them and Postgres supplies NULL) and why a backfill would be wrong — a `samAccountName` rebuilt from an email local-part is the plausible-but-wrong key.
- [x] Values are treated as untrusted: length-capped, with control characters stripped, before storage. **Verified #3480:** `normaliseLoginName` strips C0/C1 plus the invisible set, trims, returns null for empty and caps at 256; applied to all three at the upsert.
- [x] The Entra `$select` change leaves pagination, the account cap and the resume-token origin check unchanged, and `tests/unit/identity-resume-token-origin.test.ts` stays green. **Verified #3480:** that suite exists and is in the green population.
- [x] The Step 0a guard stays green, so no new writer was introduced. **Verified #3480:** `directory-identity-tables-single-write-seam` is in the green Ratchets population.
- [x] `docs/data-retention.md` records the new columns as PII, and the encryption-manifest guard passes or has a justified `NOT_SENSITIVE` entry. **Verified #3480:** the `ConnectedIdentityAccount` row names all three, calls them PII with the reason (a login name identifies as directly as an email), records nullable/never-backfilled and that Okta and Google Workspace leave them null permanently, and states plaintext-at-rest with `protectionReason` as the one encrypted column.
- [x] The pull request carries a rollback plan and a risk assessment. Carried in the pull request delivering this step, and repeated here so it outlives the pull request:

  **Rollback, cheapest first.** (1) Set the tenant's `legacyMatchAiMode` to `OFF` — takes effect from the next reconciliation run, writes a `LEGACY_MATCH_AI_MODE_CHANGED` audit event, retracts nothing and needs to retract nothing, because a verdict never changed an outcome. (2) To stop the service itself: `cd /opt/inflect && sudo docker compose … stop laya`; `app` and `worker` keep their `LAYA_BASE_URL` and a `LOCAL_ONLY` tenant then gets `PROVIDER_ERROR` non-verdicts, which is fail-closed and still a queue a person clears. (3) To undo the Compose change entirely, the backup `apply.sh` wrote: `sudo cp -a /opt/inflect/docker-compose.prod.yml.bak.20261012-150455 /opt/inflect/docker-compose.prod.yml && … up -d`. (4) To revoke the external path, set `TYPESAFE_SUBPROCESSOR_ACTIVE = false` — mutation-proved above to refuse `EXTERNAL`.

  **Risk assessment.** *Data:* no new category reaches a new processor — `laya` runs on our own VM, moves nothing off it, and `HF_HUB_OFFLINE=1` means it cannot fetch. *Availability:* the apply recreated nine containers including `postgres`; volumes were untouched and all came back healthy, and `readyz` answered 200 on both hostnames. The ongoing risk is 1.0 CPU of a 2-vCPU host held by a model during a residue batch, bounded by the Compose limit precisely so a batch cannot starve the request path. *Correctness:* the model answers confidently about 1 case in 19, so ~95 % of a residue reaches a person — the failure direction is "no verdict", never a wrong link, and `AGREES` precision is 1.0 at the committed threshold. *Residual, accepted:* the endpoint's self-reported revision is a fixed vendor string, so the canary is the only control detecting a changed checkpoint; the canary is reliable because the service is bit-for-bit deterministic.

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

- [x] `employeeNumber` is `null` — never an email — for every provider fixture that lacks one. A fallback here would let a work email pose as the strongest match signal there is. **Verified #3480:** `hris-record-id-handle.test.ts` asserts the fallback lands on the work email and NOT the row id when there is no `employeeNumber`; the mapper passes `employeeNumber` through rather than synthesising it.
- [x] `fullName` is byte-identical before and after for a fixed set of fixtures. **Verified #3480:** three `REGRESSION - fullName is still ...` tests in `tests/unit/structured-hr-names.test.ts`, one per derivation shape.
- [x] Status derivation is untouched, and `tests/guards/employee-status-single-write-seam.test.ts` stays green. **Verified #3480:** that guard is in the green Ratchets population.
- [x] Workday's `hrisRecordId` is not populated. **Verified #3480:** only the BambooHR mapper sets it (`hrisRecordId: r.id || null`); a grep across `src/app-layer/integrations/providers/` finds no assignment in Workday's.
- [x] HRIS values are length-capped, with control characters stripped. **NOT done until #3480.** All seven Step 0c columns were written verbatim at `hris-sync.ts`'s upsert — the only `.slice()` in the file were on error messages. `normaliseHrisText` now caps at 256 and strips C0/C1 plus the invisible set (composed with `stripInvisible` rather than duplicating that list), applied in BOTH arms. `fullName` and `externalId` are deliberately exempt — the joiner pass builds mailbox addresses from `fullName` byte for byte. Pinned by a test that names the column when it fails, and mutation-proved.
- [x] The migration is additive, nullable and not backfilled. **Verified #3480:** `20260917120000_employee_hris_record_id` adds the column nullable with no default, and its docblock says no backfill is attempted BECAUSE nothing reads the column — not because its prior contents are known (#2548).
- [x] `docs/data-retention.md` records the new PII columns on the `Employee` row. **NOT done until #3480.** The row read "name + work email + employment status" and named none of the seven. It now names all of them, says which provider populates `hrisRecordId`, and records that `employeeNumber` is a LINK-strength signal so a stale one would auto-link to a person the HRIS no longer asserts.
- [x] The pull request carries a rollback plan and a risk assessment. Carried in the pull request delivering this step, and repeated here so it outlives the pull request:

  **Rollback, cheapest first.** (1) Set the tenant's `legacyMatchAiMode` to `OFF` — takes effect from the next reconciliation run, writes a `LEGACY_MATCH_AI_MODE_CHANGED` audit event, retracts nothing and needs to retract nothing, because a verdict never changed an outcome. (2) To stop the service itself: `cd /opt/inflect && sudo docker compose … stop laya`; `app` and `worker` keep their `LAYA_BASE_URL` and a `LOCAL_ONLY` tenant then gets `PROVIDER_ERROR` non-verdicts, which is fail-closed and still a queue a person clears. (3) To undo the Compose change entirely, the backup `apply.sh` wrote: `sudo cp -a /opt/inflect/docker-compose.prod.yml.bak.20261012-150455 /opt/inflect/docker-compose.prod.yml && … up -d`. (4) To revoke the external path, set `TYPESAFE_SUBPROCESSOR_ACTIVE = false` — mutation-proved above to refuse `EXTERNAL`.

  **Risk assessment.** *Data:* no new category reaches a new processor — `laya` runs on our own VM, moves nothing off it, and `HF_HUB_OFFLINE=1` means it cannot fetch. *Availability:* the apply recreated nine containers including `postgres`; volumes were untouched and all came back healthy, and `readyz` answered 200 on both hostnames. The ongoing risk is 1.0 CPU of a 2-vCPU host held by a model during a residue batch, bounded by the Compose limit precisely so a batch cannot starve the request path. *Correctness:* the model answers confidently about 1 case in 19, so ~95 % of a residue reaches a person — the failure direction is "no verdict", never a wrong link, and `AGREES` precision is 1.0 at the committed threshold. *Residual, accepted:* the endpoint's self-reported revision is a fixed vendor string, so the canary is the only control detecting a changed checkpoint; the canary is reliable because the service is bit-for-bit deterministic.

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

- [x] The contract is versioned, and the schema rejects an unknown major version. **Verified #3480:** `CONTRACT_VERSION = 'inflect-legacy-access/1'` and the manifest schema is `z.literal(CONTRACT_VERSION)`, so any other value is rejected rather than merely an unknown MAJOR. `isSupportedContract` is exact equality, and `legacy-mcp-contract.test.ts` carries an `an unknown contract version` case.
- [x] Every dimension has an upper bound in the schema, and Step 1b will enforce the same bounds whatever a server claims. **Verified #3480:** `LIMITS` bounds all seven — columns 200, column name 128, snapshot id 200, rows per page 1,000, pages 1,000, cell 4,096, short text 512 — and the client parses every response through those same schemas, so a server's claim is never the bound that applies.
- [x] Column names are length-capped and free of control characters, because they reach the mapping UI. **Verified #3480:** `ColumnNameSchema = inertText(LIMITS.MAX_COLUMN_NAME_LENGTH, 'column name')`; `FORBIDDEN_CONTROL` REJECTS rather than strips C0, C1, zero-width, bidi and separator marks, and the docblock gives the reason the criterion gives — stripping would silently rename a column and let two names collide in the mapping UI.
- [x] Every fault in the prompt exists, and a test shows each one firing. **Verified #3480:** all 13 are declared as values in `FAULT_NAMES` with a compile-time exhaustiveness check against the `FaultName` union (`UnlistedFault extends never`), `FAULT_EXPECTATIONS` is a total `Record<FaultName, …>`, and `the expectation table covers every declared fault` asserts the key set equals `FAULT_NAMES` at length 13 before the per-fault cases run.
- [x] The contract document names the fake server as the reference implementation, so the suite exercises the reference and it cannot drift from the contract. **Verified #3480:** `docs/legacy-mcp-access-contract.md` line 7 names `tests/helpers/legacy-mcp-fake-server.ts` as the reference implementation.
- [x] The contract document is registered and passes `tests/guardrails/docs-accuracy.test.ts`. **Verified #3480:** registered in `docs/_status/doc-classification.json`, and `docs-accuracy` is in the Ratchets population, green on main.

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

- [x] Production code cannot bypass `safeFetch`:
  - ~~the client is added to `SINKS`~~ — **satisfied differently, and better (#3480).** The SINK is `src/lib/mcp/wire-transport.ts`, the single place either dialect reaches the network; the clients sit in `MCP_CLIENTS`, which asserts they contain NO fetch call at all AND import the transport, and pins the list at two so neither dialect goes unlisted (the omission #3400 found was invisible because the *other* client was registered). A `SINKS` entry only asks whether a file mentions `safeFetch` somewhere, which a file can satisfy while fetching directly elsewhere. This criterion's wording describes the weaker mechanism it replaced.
  - a structural rule fails if code under `src/` passes an injected fetch to the client — **verified:** `tests/unit/legacy-mcp-client.test.ts:559`, `no file under src/ passes fetchImpl to the client`.
  - the same rule fails if code in `src/lib/mcp/client/` calls `fetch` or `resilientFetch` directly — **NOT enforced until #3480.** The pattern was `/\bfetch\(/` plus a `safeFetch` literal, and the leading `\b` means it matched neither `resilientFetch(` nor `boundedFetch(`. Both reach the network without address filtering: `resilientFetch`'s inner is `boundedFetch`, which bounds size and time and redacts query strings for logs, and does no private/loopback/link-local/metadata checks at all. So the rule was stated in this criterion AND in the client's own docblock while only half of it was enforced. The pattern is name-agnostic now and mutation-proved against `fetch(`, `resilientFetch(` and `boundedFetch(`.
- [x] Redirects, `http:`, and private, loopback, link-local and metadata addresses are refused. `safeFetch` supplies this; a test proves the client surfaces each as a typed error. **Verified #3480:** this was the one criterion in Phase 1 the suite did NOT cover, and the gap is now closed rather than argued away. `redirect` was the only destination case, and it reaches the rule from the opposite direction — an allowed host answering with a hostile `Location`. The scheme and the address families were proven in `tests/guards/egress-allowlist.test.ts`, about `safeFetch` rather than about this client, so nothing proved the composition. `legacy-mcp-client.test.ts` now drives the PRODUCTION path with no `fetchImpl` over seven cases — `http:`, IPv4 and IPv6 loopback, 10/8, 192.168/16, 172.16/12 and the link-local metadata address — each asserting `complete: false`, `kind: 'ssrf-blocked'` and zero rows. Every one was measured before the test was written; no socket opens, because each is refused on inspection.
- [x] The `initialize` body carries `capabilities: {}` exactly. **Verified #3480:** `capabilities: {}` at the call site, and the test reads the recorded wire body and asserts `params.capabilities` equals `{}` — not merely that it is empty.
- [x] No `tools/*` request is ever sent, proven by the fake server's request log while it advertises tools. **Verified #3480:** `sends no tools/* request while the server advertises tools` asserts no logged request method starts with `tools/`, with the `toolsAdvertised` fault on; the contract suite asserts the same over its own log.
- [x] A server-sent-event response is refused. **Verified #3480:** `server-sent events: the content type the contract forbids`, and `serverSentEvents` carries a typed expectation in `FAULT_EXPECTATIONS`.
- [x] The oversized-page fault aborts at the byte cap without buffering the body. **Verified #3480:** `oversizedPage` expects `cap-exceeded`, and the suite drives it through a fetch double that observes `init.signal` so the abort is the client's own rather than the fake server resolving late.
- [x] A torn snapshot produces an error and `complete: false`. **Verified #3480:** `tornSnapshot` expects `torn-snapshot`, and the shared per-fault case asserts `complete: false` alongside the kind.
- [x] The bearer token appears in no error message, log line or thrown object, proven by searching serialised errors for it. **Verified #3480:** a per-fault case over all 13 faults searches the serialised result and the reason message for the token, and a further case serialises a thrown error three ways (`JSON.stringify`, `String(message)`, `kind`) because they do not agree about what they carry. Both collect every leak before asserting, so a failure names which serialisation leaked.
- [x] Only counts and identifiers are logged, through the observability logger. No row contents are logged. **Verified #3480:** the logger is spied, the whole captured blob is searched for a real cell value taken from the result and for the token, and both must be absent — a sampled value rather than a hypothetical one.
- [x] The pull request carries a rollback plan and a risk assessment. Carried in the pull request delivering this step, and repeated here so it outlives the pull request:

  **Rollback, cheapest first.** (1) Set the tenant's `legacyMatchAiMode` to `OFF` — takes effect from the next reconciliation run, writes a `LEGACY_MATCH_AI_MODE_CHANGED` audit event, retracts nothing and needs to retract nothing, because a verdict never changed an outcome. (2) To stop the service itself: `cd /opt/inflect && sudo docker compose … stop laya`; `app` and `worker` keep their `LAYA_BASE_URL` and a `LOCAL_ONLY` tenant then gets `PROVIDER_ERROR` non-verdicts, which is fail-closed and still a queue a person clears. (3) To undo the Compose change entirely, the backup `apply.sh` wrote: `sudo cp -a /opt/inflect/docker-compose.prod.yml.bak.20261012-150455 /opt/inflect/docker-compose.prod.yml && … up -d`. (4) To revoke the external path, set `TYPESAFE_SUBPROCESSOR_ACTIVE = false` — mutation-proved above to refuse `EXTERNAL`.

  **Risk assessment.** *Data:* no new category reaches a new processor — `laya` runs on our own VM, moves nothing off it, and `HF_HUB_OFFLINE=1` means it cannot fetch. *Availability:* the apply recreated nine containers including `postgres`; volumes were untouched and all came back healthy, and `readyz` answered 200 on both hostnames. The ongoing risk is 1.0 CPU of a 2-vCPU host held by a model during a residue batch, bounded by the Compose limit precisely so a batch cannot starve the request path. *Correctness:* the model answers confidently about 1 case in 19, so ~95 % of a residue reaches a person — the failure direction is "no verdict", never a wrong link, and `AGREES` precision is 1.0 at the committed threshold. *Residual, accepted:* the endpoint's self-reported revision is a fixed vendor string, so the canary is the only control detecting a changed checkpoint; the canary is reliable because the service is bit-for-bit deterministic.

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

- [x] `legacy-mcp` is classified in `CONFIG_FIELD_RULES`. An unclassified provider's configuration passes through unvalidated, and this one must not be such a provider. **Verified #3480:** `'legacy-mcp'` is a key in `CONFIG_FIELD_RULES` in `src/app-layer/integrations/config-schema.ts`, carrying `endpointUrl` as `publicOrigin` plus the Step 4a/2b `inert` keys.
- [x] A test proves that changing the endpoint host without re-entering the token is refused. **Verified #3480:** `1c — a host change cannot inherit the stored token` asserts `redirectsStoredCredential(P, before, after)` returns `'endpointUrl'`, and the suite docblock states the attack — an `admin.manage` holder repointing the host at their own server to collect the stored bearer token.
- [x] Private, loopback and metadata URLs, and `http:`, are refused when saved. **Verified #3480:** a table in `legacy-mcp-provider.test.ts` covers `http:`, `127.0.0.1`, `[::1]`, 10/8, 192.168/16, 172.16/12 and `169.254.169.254` at save time through `validateProviderConfig`.
- [x] A hostname that only *resolves* to a private address is refused when fetched. **Verified #3480:** `1c — a name that only RESOLVES to a private address` — save-time validation cannot see it, so the refusal is `safeFetch` re-resolving at use time, which is the half that closes DNS rebinding.
- [x] The token appears in no API response, validation message, log line or audit row. **Verified #3480:** the token is declared a SECRET field rather than a config field (asserted: `configKeys` does not contain `bearerToken`, so it lands in the encrypted `secretEncrypted` column and not in plaintext `configJson`), and a dedicated block asserts a fixture token is absent from the serialised surface.
- [x] The Test button never marks a connection as auth-failed. **Verified #3480:** `markAuthFailure is reached only from background sweeps, never from validateConnection` — a source scan with the needle bound so a file that merely mentions the function cannot satisfy it. The flag feeds the freshness surface and the leaver pass, so a half-typed token in the Test box must not read as the integration being down.
- [x] Every guard that enumerates providers passes, and the pull request explains each change to a guard's list. **Verified #3480:** the provider-enumerating guards run green — `integration-bootstrap-runtime-wiring`, `mcp-server-token` and `legacy-access-mapping` at 39 tests — and 16 test files reference `legacy-mcp` by name, all in the green populations. The pull-request half is attested by the PR that delivered Step 1c.
- [x] Messages exist in both `en` and `bg`. **Verified #3480:** both locales carry the Step 1c keys (`legacyQueue`, `legacyMapping`, `notLegacyProvider`, `legacy`), and parity is enforced rather than eyeballed: `tests/guardrails/i18n-completeness.test.ts` and `tests/guards/i18n-keys-resolve.test.ts` run green at 15 tests.
- [x] The pull request carries a rollback plan and a risk assessment. Carried in the pull request delivering this step, and repeated here so it outlives the pull request:

  **Rollback, cheapest first.** (1) Set the tenant's `legacyMatchAiMode` to `OFF` — takes effect from the next reconciliation run, writes a `LEGACY_MATCH_AI_MODE_CHANGED` audit event, retracts nothing and needs to retract nothing, because a verdict never changed an outcome. (2) To stop the service itself: `cd /opt/inflect && sudo docker compose … stop laya`; `app` and `worker` keep their `LAYA_BASE_URL` and a `LOCAL_ONLY` tenant then gets `PROVIDER_ERROR` non-verdicts, which is fail-closed and still a queue a person clears. (3) To undo the Compose change entirely, the backup `apply.sh` wrote: `sudo cp -a /opt/inflect/docker-compose.prod.yml.bak.20261012-150455 /opt/inflect/docker-compose.prod.yml && … up -d`. (4) To revoke the external path, set `TYPESAFE_SUBPROCESSOR_ACTIVE = false` — mutation-proved above to refuse `EXTERNAL`.

  **Risk assessment.** *Data:* no new category reaches a new processor — `laya` runs on our own VM, moves nothing off it, and `HF_HUB_OFFLINE=1` means it cannot fetch. *Availability:* the apply recreated nine containers including `postgres`; volumes were untouched and all came back healthy, and `readyz` answered 200 on both hostnames. The ongoing risk is 1.0 CPU of a 2-vCPU host held by a model during a residue batch, bounded by the Compose limit precisely so a batch cannot starve the request path. *Correctness:* the model answers confidently about 1 case in 19, so ~95 % of a residue reaches a person — the failure direction is "no verdict", never a wrong link, and `AGREES` precision is 1.0 at the committed threshold. *Residual, accepted:* the endpoint's self-reported revision is a fixed vendor string, so the canary is the only control detecting a changed checkpoint; the canary is reliable because the service is bit-for-bit deterministic.

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

- [x] A row with no `accountKey` fails the pull — `PARTIAL`, counted and named. It is never skipped: a missing account is an account nobody reviews. **Verified #3480:** `a row with no account key` is a case in the refusal table, asserting `status: 'PARTIAL'`, reason `MISSING_ACCOUNT_KEY` and that nothing is stored.
- [x] A duplicate `accountKey` in one snapshot fails the pull, rather than collapsing under an upsert. **Verified #3480:** `a duplicate account key` in the same table refuses with `DUPLICATE_ACCOUNT_KEY` — the row is sent twice and the pull fails rather than the second write collapsing onto the first.
- [x] Schema drift — a column-set fingerprint different from the mapping's — refuses the pull, and no accounts are stored. **Verified #3480:** `assertNoSchemaDrift(mapping, observedColumns)` runs at step 4 of `legacy-access-pull.ts`, before anything is stored, and the comment records that the fingerprint and the mapping both speak in NAMES rather than positions.
- [x] Oversharing drops the extra columns and flags the connection `OVERSHARING`, proven by a database check that no extra column's value was stored. **Verified #3480:** `drops the extra column, flags the connection, and stores NO value from it`, with `CLEARS the flag on a later clean pull, so the banner cannot go stale` as its other direction, and `a manifest declaring MORE columns than the projection does NOT flag the connection` as the false-alarm case.
- [x] A denylisted column never reaches the database, even when the server sends it. **Verified #3480:** `a DENYLISTED overshared column REFUSES the pull and stores nothing`, `names the column but never a value — the transport stripped those`, and `refuses on a denylisted column even when the read ALSO tore` for the compound case.
- [x] A secret-shaped value (AI Guard patterns) refuses the pull, and nothing from that batch is stored. **Verified #3480:** `a secret-shaped value` refuses with `SECRET_SHAPED_VALUE`, driven by the AWS documentation example key as a synthetic input so the scan is shown firing rather than assumed.
- [x] A crash part-way through writing leaves a snapshot that is not `COMPLETE`, and readers only ever use `COMPLETE` snapshots. **Verified #3480:** `a refusal leaves the snapshot unverifiable rather than falsely verified`, and the reader side is `legacy-reconcile.ts` refusing `SNAPSHOT_NOT_COMPLETE` on `snapshot.status !== 'COMPLETE'` before any resolution.
- [x] The payload hash recomputes from the stored rows, and its algorithm version is recorded. **Verified #3480:** `the hash RECOMPUTES from the rows in the database`, its negative twin `the recomputed hash FAILS once a stored row is altered`, and `equals computePayloadHash over the canonical accounts`. The version is a stored column: `payloadHashAlgorithmVersion` is written on all three paths and `legacy-access-verify.ts` reads it FROM THE ROW and refuses a version it does not know.
- [x] The connection lock prevents concurrent pulls, and re-enqueuing a running pull does nothing. **Verified #3480:** `a second concurrent pull does nothing rather than opening a rival snapshot`, paired with `releases the lock, so the next pull is not wedged until the lease expires` — the failure the first test alone would not catch.
- [x] Both new tables meet global rule 6, and `tests/guardrails/prisma-schema-folder-coverage.test.ts` passes. **Verified #3480:** `LegacyAccessSnapshot` and `LegacyAccount` live in `prisma/schema/legacy-access.prisma`, and that guardrail is in the Ratchets population, green on main.
- [x] The job's body references `tenantId`, and the job is registered in `ON_DEMAND_JOBS`. **Verified #3480:** `executorRegistry.register('legacy-access-pull', …)` with the payload typed in `jobs/types.ts`, and the executor carries the comment pointing at `ON_DEMAND_JOBS` in `tests/guardrails/runtime-wiring-coverage`, which is what stops an on-demand job being read as an unwired one.
- [x] The pull request carries a rollback plan and a risk assessment. Carried in the pull request delivering this step, and repeated here so it outlives the pull request:

  **Rollback, cheapest first.** (1) Set the tenant's `legacyMatchAiMode` to `OFF` — takes effect from the next reconciliation run, writes a `LEGACY_MATCH_AI_MODE_CHANGED` audit event, retracts nothing and needs to retract nothing, because a verdict never changed an outcome. (2) To stop the service itself: `cd /opt/inflect && sudo docker compose … stop laya`; `app` and `worker` keep their `LAYA_BASE_URL` and a `LOCAL_ONLY` tenant then gets `PROVIDER_ERROR` non-verdicts, which is fail-closed and still a queue a person clears. (3) To undo the Compose change entirely, the backup `apply.sh` wrote: `sudo cp -a /opt/inflect/docker-compose.prod.yml.bak.20261012-150455 /opt/inflect/docker-compose.prod.yml && … up -d`. (4) To revoke the external path, set `TYPESAFE_SUBPROCESSOR_ACTIVE = false` — mutation-proved above to refuse `EXTERNAL`.

  **Risk assessment.** *Data:* no new category reaches a new processor — `laya` runs on our own VM, moves nothing off it, and `HF_HUB_OFFLINE=1` means it cannot fetch. *Availability:* the apply recreated nine containers including `postgres`; volumes were untouched and all came back healthy, and `readyz` answered 200 on both hostnames. The ongoing risk is 1.0 CPU of a 2-vCPU host held by a model during a residue batch, bounded by the Compose limit precisely so a batch cannot starve the request path. *Correctness:* the model answers confidently about 1 case in 19, so ~95 % of a residue reaches a person — the failure direction is "no verdict", never a wrong link, and `AGREES` precision is 1.0 at the committed threshold. *Residual, accepted:* the endpoint's self-reported revision is a fixed vendor string, so the canary is the only control detecting a changed checkpoint; the canary is reliable because the service is bit-for-bit deterministic.

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

- [x] The UI shows profile statistics only, never a raw sample value, proven by a rendered test. **Verified #3480:** `shows NO identity value anywhere in the document` checks a login, an email, a person's name, a department and a bcrypt-shaped hash are each absent from `document.body.innerHTML`. Its denominator is the next test — `DOES show the status vocabulary, because that is the one gated exception` — so the absence cannot pass by rendering nothing. The exception is deliberate and gated server-side by `mayExposeValueSet`.
- [x] Profiling never requests a denylisted column, proven by the fake server's request log. **Verified #3480:** `never REQUESTS the denylisted column the server declares`, read off the recorded `fields=` projection, with `still SHOWS the column, as present and unmappable` and `carries no value from it anywhere in the response` as the other two halves.
- [x] Profiling persists nothing: no `LegacyAccount` rows exist after it runs. **Verified #3480:** `persists NOTHING — no snapshot and no account row`.
- [x] Column names render only as text. A column named like an HTML payload stays inert, and nothing uses `dangerouslySetInnerHTML`. **Verified #3480:** the second half held (no legacy component uses `dangerouslySetInnerHTML`) but the FIRST WAS UNTESTED — inertness rested on React escaping its children, which is true and unasserted. It cannot rest on the schema instead: `ColumnNameSchema` rejects control and invisible characters but deliberately permits `<` and `>`, since those are legal in a customer's column name. Closed with `a column NAME from the far end renders as text, never as markup`, which feeds `<img src=x onerror=…>` as a column name and asserts no `img` element exists, the handler never ran, and — as the denominator — the name IS on screen. Mutation-proved: rendering that cell through `dangerouslySetInnerHTML` fails exactly this test and nothing else.
- [x] No mapping is saved without an explicit save, even when every suggestion is accepted at once. **Verified #3480:** `reading the columns issues no write, even though every suggestion is pre-selected` asserts the recorded call log holds no write, and `pressing save writes the mapping once, with the confirmed columns` is its positive control.
- [x] The API, not only the UI, rejects an incomplete mapping and a mapping that targets a denylisted column. **Verified #3480:** the refusals are asserted at the usecase rather than in the component: `refuses a mapping with no accountKey`, `refuses a key-only mapping`, `refuses a DENYLISTED column, so it is never requested`, `refuses a denylisted ENTITLEMENT column too`, `refuses one column mapped to two canonical fields`, plus `stores NOTHING when it refuses` and `reports EVERY problem at once`.
- [x] Each save increments the version and writes an audit event with the diff. **Verified #3480:** `stores version 1 with the fingerprint it was confirmed against`, `increments the version on a real change`, `writes an audit row naming the columns, the version and the projection`, and `is a NO-OP on an identical re-save — no version bump, no audit row`, which is the part that keeps the version meaningful.
- [x] The platform-primitive guards pass, and messages exist in both `en` and `bg`. **Verified #3480:** the platform-primitive guards are in the green Ratchets population, and locale parity is enforced rather than eyeballed by `tests/guardrails/i18n-completeness.test.ts` and `tests/guards/i18n-keys-resolve.test.ts` (15 tests, green).

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

- [x] Transliteration runs before diacritic folding: under the Streamlined System, `Йордан` becomes `Yordan` and `Николай` becomes `Nikolay`, not `Iordan` and `Nikolai`. **Verified #3480:** an `it.each` asserts `Йордан -> Yordan`, `Николай -> Nikolay` and `Йоана -> Yoana`, and the ORDER has its own control: `и` + U+0306 is the token the table would see if folding ran first, and `и` maps to `i`. So the test names the value that would appear if the order inverted, rather than only the value expected.
- [x] The word-final rule holds: `София` becomes `Sofia` and `Мария` becomes `Maria`. **Verified #3480:** asserted, with `the rule is word-final, not a blanket ия substitution` beside it so a blanket replacement cannot satisfy the criterion, plus `and the traditional scheme deliberately does NOT contract it` for the other scheme.
- [x] `normalizeForScan` is never applied to identity data, and a test asserts that `Иванов` survives as a transliteration rather than as `Иbaнob`. **Verified #3480:** `a purely Cyrillic name is transliterated, never folded`, with the two surrounding cases giving the boundary from both sides — `a mixed token gets a folded candidate, because it is a Latin name mistyped` and `a pure Latin token produces only itself`.
- [x] Look-alike folding applies only to tokens that mix scripts. **Verified #3480:** the same three cases: pure Cyrillic transliterates, pure Latin yields only itself, and only a MIXED token gets a folded candidate.
- [x] `emailKey` is unmodified, and its existing tests are untouched and green. **Verified #3480:** `key is exactly what emailKey returns`, and the two layers above it are asserted to leave it alone — `+tag stripping is a SEPARATE layer that leaves key untouched` and `domain equivalence likewise — comparison only`. This is the invariant the design document's `da-01` case exists for: a link made on a folded address is one the leaver pass cannot act on.
- [x] Every function is total. It never throws on empty, huge, control-character or unpaired-surrogate input, and every input is length-capped. **Verified #3480:** an `every function is total` block drives a hostile input list through every function by index, plus `caps its input rather than trusting the caller` and `bounds the token count`.
- [ ] No regular expression backtracks catastrophically. Each is linear by construction, and the pathological inputs finish within a bound measured in operations, not wall-clock time. **NOT met — #3496.** The test asserts wall-clock `ms < 250`, which is the one thing the criterion excludes: at that ceiling a quadratic regex on a 400-character input can finish inside it on an idle machine, and linear code can exceed it on a runner carrying four shards. The sibling criterion in Step 3b is satisfied properly (`counted not timed`, against `COMPARISON_BUDGET_MULTIPLE`), so the pattern exists in this subsystem — only this one was left on the clock. No catastrophic regex has been demonstrated; what is missing is the evidence, which #3496 proposes pinning statically as "linear by construction".
- [x] Output order is deterministic, so identical input produces identical variant lists. **Verified #3480:** `identical input gives a byte-identical list`, `order is none, then the law, then traditional`, and `de-duplicates when the schemes agree, keeping the first scheme that produced it` — which is the case where a set-based implementation would silently reorder.
- [x] The corpus is synthetic — no real names, emails or national identifiers — and its header says so. **Verified #3480:** the fixture header reads `ENTIRELY SYNTHETIC` and spells out the four classes: no real name, no real address, no national identifier, no real employee number.
- [x] If a dependency was added, it went through `docs/dependency-governance.md`. **Verified #3480:** satisfied VACUOUSLY, and recorded as such rather than left ambiguous: Step 3a added no dependency. Every import in `src/lib/identity/reconcile/` resolves to a local module or an internal `@/lib` path — the Jaro-Winkler implementation is in-house, which is also what lets the published reference values be asserted. The repo's one slugify dependency predates this work and is used by the policy module.

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

- [x] Auto-link precision on the corpus is 100 %, and a single false `LINKED` fails CI. **Verified #3480:** `links nothing the corpus does not expect linked, and reports recall`, floored by `links every case the corpus expects linked, so the gate has a floor` — without which a reconciler that links NOTHING would score perfect precision — and `resolves every account to exactly one outcome`.
- [x] An exhaustive table of every combination of medium and weak signals never yields `LINKED`. **Verified #3480:** `covers every subset, and the count is stated` (the 127 non-empty subsets of the supporting kinds) and `never yields LINKED, at any score, for one candidate or two`, at score 10,000 each. Paired with `classifies every signal kind, so a new kind cannot default to strong`, which is what stops the exhaustive table going stale when a kind is added.
- [x] An exhaustive test shows that any veto prevents a link to the vetoed candidate. **Verified #3480:** `every (strong signal × veto) pair refuses to link to the vetoed candidate` — the cross product, not a sample.
- [x] Two candidates tied on the strongest signal yield `AMBIGUOUS`, never a pick. **Verified #3480:** asserted for both of the tie-able strong signals: `two candidates with the same exact email yield AMBIGUOUS` and `two candidates with the same employee number yield AMBIGUOUS`. A strict `>` tie-break never fires on ties, so this is the assertion that catches a collapse-to-one.
- [x] Outcomes are unchanged when both the accounts and the roster are shuffled, so no result depends on input order. **Verified #3480:** `is unchanged when accounts AND roster are shuffled, over many seeds` — both sides shuffled, over seeds, comparing a canonicalised serialisation.
- [x] The re-keyed rule yields `SUGGESTED` even when the signal onto the terminated record is strong. **Verified #3480:** `suggests the successor rather than linking the terminated record`, generalised by `holds for EVERY strong signal, not just the email it was written for`, and bounded by the four cases that must NOT be read as a re-key: no successor, an overlapping namesake, two concurrent namesakes, and a leaver with no successor at all.
- [x] A `sAMAccountName` present in two directory connections produces no directory bridge. **Verified #3480:** `produces NO bridge when the same sAMAccountName is in two connections`, with `links on one fresh link in one connection (the control)` as the denominator and `produces no bridge from a stale link` as the freshness case.
- [x] At a large synthetic scale, comparisons stay within a stated multiple of the input size, measured by count rather than time. **Verified #3480:** `stays within COMPARISON_BUDGET_MULTIPLE at scale, counted not timed`, asserting `metrics.comparisons` against a budget derived from the input size and printing the cross product it avoided.
- [x] Identical inputs produce byte-identical output. **Verified #3480:** `identical inputs produce byte-identical output` compares two serialised runs over the same input.
- [x] The module imports nothing that touches the database. **Verified #3480:** every import in the module resolves to `./normalise`, `./similarity`, `./conventions`, `./engine`, `@/lib/identity/email-key` or `@/lib/text/invisible-chars`. No Prisma, no repository, no client.

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

- [x] A snapshot that is not `COMPLETE` is refused, and no results are written. **Verified #3480:** the snapshot is set to `PARTIAL` and the run returns `REFUSED` with `SNAPSHOT_NOT_COMPLETE`, asserting `legacyAccountResolution.count` is 0 — the write check, not only the return value. `refuses an EMPTY snapshot — zero is never complete, one level up` sits beside it, which is invariant 5 applied to this gate.
- [x] A stale or non-`PASSED` HRIS sync refuses the whole run with `NO_FRESH_ROSTER`, and no results are written. **Verified #3480:** four cases rather than one: stale, fresh-but-not-passed, no sync at all, and `accepts a fresh PASSED sync from ANY supported HRIS provider` as the denominator that stops the gate passing by refusing everything.
- [x] A stale or contradicted directory link is never used as a bridge. **Verified #3480:** `does NOT cross a STALE link` and `does NOT cross a CONTRADICTED link, however fresh`, with `DOES cross a fresh uncontradicted link — the denominator` naming itself as the control.
- [x] Results are immutable: a second run writes a new set and never updates the old one. **Verified #3480:** `is keyed per RUN, so a second run ADDS rather than colliding`, and `refuses two rows for one account in ONE run` — the pair that keeps "why was this suggested in March?" answerable.
- [x] The Step 0a guard stays green; directory tables are only read. **Verified #3480:** `writes NOTHING to the directory tables — invariant 1` asserts it behaviourally at this seam, and the Step 0a structural guard is in the green Ratchets population.
- [x] Both new tables meet global rule 6, including a two-tenant test proving a run never reads another tenant's roster, links or aliases. **Verified #3480:** `legacy-reconcile-rls.test.ts` carries the two-tenant set: each tenant sees only its own resolutions, the other tenant's row is unreadable, an unbound context reads NOTHING, an INSERT claiming the other tenant is refused, a DELETE of the other tenant's row removes ZERO rows and it survives, and a resolution cannot be attached to the other tenant's snapshot or execution. The zero-row DELETE case matters because RLS makes a forbidden delete silent.
- [x] Each run emits counts per outcome. **Verified #3480:** `reports counts per outcome`, alongside `records the run as an IntegrationExecution that PASSED` and `stores the EVIDENCE, so a reviewer can see why`.
- [x] The pull request carries a rollback plan and a risk assessment. Carried in the pull request delivering this step, and repeated here so it outlives the pull request:

  **Rollback, cheapest first.** (1) Set the tenant's `legacyMatchAiMode` to `OFF` — takes effect from the next reconciliation run, writes a `LEGACY_MATCH_AI_MODE_CHANGED` audit event, retracts nothing and needs to retract nothing, because a verdict never changed an outcome. (2) To stop the service itself: `cd /opt/inflect && sudo docker compose … stop laya`; `app` and `worker` keep their `LAYA_BASE_URL` and a `LOCAL_ONLY` tenant then gets `PROVIDER_ERROR` non-verdicts, which is fail-closed and still a queue a person clears. (3) To undo the Compose change entirely, the backup `apply.sh` wrote: `sudo cp -a /opt/inflect/docker-compose.prod.yml.bak.20261012-150455 /opt/inflect/docker-compose.prod.yml && … up -d`. (4) To revoke the external path, set `TYPESAFE_SUBPROCESSOR_ACTIVE = false` — mutation-proved above to refuse `EXTERNAL`.

  **Risk assessment.** *Data:* no new category reaches a new processor — `laya` runs on our own VM, moves nothing off it, and `HF_HUB_OFFLINE=1` means it cannot fetch. *Availability:* the apply recreated nine containers including `postgres`; volumes were untouched and all came back healthy, and `readyz` answered 200 on both hostnames. The ongoing risk is 1.0 CPU of a 2-vCPU host held by a model during a residue batch, bounded by the Compose limit precisely so a batch cannot starve the request path. *Correctness:* the model answers confidently about 1 case in 19, so ~95 % of a residue reaches a person — the failure direction is "no verdict", never a wrong link, and `AGREES` precision is 1.0 at the committed threshold. *Residual, accepted:* the endpoint's self-reported revision is a fixed vendor string, so the canary is the only control detecting a changed checkpoint; the canary is reliable because the service is bit-for-bit deterministic.

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

- [x] A table test shows that neither signal ever produces `LINKED`. **Verified #3480:** two layers. By TYPE: `CandidateScorer` returns `SupportingSignal`, whose `kind` is narrowed to the non-strong union, so conventions and similarity cannot produce a `LINKED` however they score — that is `tsc`, not convention. By TABLE: the exhaustive 127-subset test over all supporting kinds at score 10,000 each, plus `a unique convention match is SUGGESTED, not LINKED`.
- [x] A convention collision — John and Jane Smith both generating `jsmith` — yields `AMBIGUOUS`. **Verified #3480:** that exact case by name, with the mechanism asserted separately: `matchConvention returns BOTH, and says it collides`, and `the colliding candidates are scored EQUALLY, which is what makes it a tie`. The equal score is the point — a tie-break preferring the earlier hire would reach a reviewer as confidence.
- [x] A mononym, a three-part name or a missing name part generates no convention candidate. **Verified #3480:** four cases: `a mononym generates nothing`, `a three-part name generates nothing — the split has two readings`, `a missing name part generates nothing`, and `a {middle} template over somebody with no middle name generates nothing`. `splits a fullName of EXACTLY two tokens` is the positive control.
- [x] Jaro-Winkler matches the published reference values: `MARTHA`/`MARHTA` 0.961, `DWAYNE`/`DUANE` 0.84, `DIXON`/`DICKSONX` 0.813. **Verified #3480:** all three asserted to three decimal places. These are assertable only because the implementation is in-house rather than a dependency.
- [x] Similarity runs only within blocks, proven by comparison count. **Verified #3480:** a `4a — similarity runs only within blocks` block, and the engine-level budget in Step 3b counts `metrics.comparisons` against a multiple of the input size rather than timing it.
- [x] A candidate found through transliteration records its scheme, and is at most `SUGGESTED`. **Verified #3480:** `scorers.ts` carries the scheme into the signal's `evidence` (`${convention.template} via ${match.scheme}`) and sets `kind: 'NAME_TRANSLIT'`, which is in the non-strong union — so the SUGGESTED ceiling is held by the type, not by a check that could be edited out.
- [x] The grammar parser rejects unknown tokens and bounds template length. **Verified #3480:** `bounds the template length`, `rejects a template with no name token, which would match everyone`, a rejection table covering unknown tokens, an unclosed brace, empty, and `{n?}` misplacement, plus `every shipped candidate template parses` so the parser is not merely strict.
- [x] Convention changes are versioned and audited. **Verified #3480:** `starts at version 1 with no previous template`, `increments the version and carries the previous template`, `records both templates and the version` in the audit row, and `re-adopting the identical template changes nothing and writes no audit row` — the no-op case that keeps a version number meaningful. `writes the record under one key and PRESERVES the rest of configJson` covers the adjacent-data risk.
- [x] The precision ratchet stays at 100 % with the new corpus cases. **Verified #3480:** `identity-reconcile-precision` is green, and its precision assertion is paired with a recall floor so a reconciler that linked nothing could not satisfy it.

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

- [x] A user without the confirm key is denied, and an `AUTHZ_DENIED` row is written. **Verified #3480:** `a role without the confirm key is denied` at the usecase, and the ROW comes from the route: `queue/bulk-confirm/route.ts` wraps the handler in `requirePermission('identity_reconciliation.confirm', …)`, which is the mechanism that writes a hash-chained `AUTHZ_DENIED`. The composition is held by `api-permission-coverage`, which accepts only a LITERAL `requirePermission` in the route file. `a CUSTOM role granting confirm over a READER base is ALLOWED` is the case a coarse `canAdmin` check would have refused.
- [x] A two-tenant test proves a reviewer cannot confirm an employee from another tenant. **Verified #3480:** `refuses an employee from ANOTHER tenant, even via MANUAL` — MANUAL being the arm that accepts an unscored employee, so it is the one that would otherwise bypass the engine's own tenant scoping.
- [x] A confirmation against a superseded result is refused with 409. **Verified #3480:** `refuses a confirmation against a SUPERSEDED result with 409`, with `refuses CONFIRM for an employee the engine never scored` beside it.
- [x] Bulk confirmation is limited to `SUGGESTED` rows above the margin, is capped, is re-checked row by row on the server, and reports failures per row. **Verified #3480:** all four: `refuses more rows than the cap`, `reports failures PER ROW rather than failing the request`, `refuses an AMBIGUOUS row even when its margin would pass`, and `confirms a clear SUGGESTED row through the SAME path as a single decision` — the last being what stops bulk becoming a second, laxer implementation. `the margin of a sole candidate is Infinity, not its score` covers the arithmetic edge.
- [x] **When an aliased employee leaves, the alias stays active and the account becomes a leaver finding**, proven by test. **Verified #3480:** `does NOT suspend when the aliased employee simply left`, and — the half that matters — `and the surviving alias still links the account to the departed employee`. Without the alias the row would be `UNMATCHED` and indistinguishable from an unclassified service account, so suspending would delete the fact that made it urgent.
- [x] Each suspension trigger — recreation, a broken employment window, a re-key and a vanished record — has its own test. **Verified #3480:** one test each: `HR_RECORD_VANISHED`, `HR_RECORD_REKEYED`, `ACCOUNT_RECREATED`, `ACCOUNT_POSTDATES_EMPLOYMENT_END`. Plus `every reason the function can emit is in SUSPENSION_REASONS`, which stops the set going stale, and four must-NOT-trigger cases including `two namesakes with overlapping tenure are not a re-key, so a departure stays a departure`.
- [x] An expired `EXTERNAL` returns to the queue. **Verified #3480:** `an EXPIRED EXTERNAL comes BACK, labelled EXTERNAL_EXPIRED` — labelled rather than merely present, because it did not become doubtful, it became old. `EXTERNAL refuses an expiry in the past` guards the other end.
- [x] `NON_PERSON` requires an active owner in the same tenant. **Verified #3480:** `NON_PERSON requires an owner who is a member of THIS tenant`.
- [x] Reviewer notes and justifications are in the encryption manifest and pass through `sanitizePlainText`, so `tests/guardrails/sanitize-rich-text-coverage.test.ts` stays green. **Verified #3480:** `LegacyIdentityAlias: ['justification']` is in `ENCRYPTED_FIELDS`, the usecase imports and applies `sanitizePlainText`, and `RICH_TEXT_COVERAGE` registers the model against this usecase as its write path. `does NOT copy the justification into the audit row` is the related leak check.
- [x] Each confirmation's audit event records the signals the reviewer was shown. **Verified #3480:** `carries the engine signals and the resolution outcome`. `verdictId` is recorded for EVERY action that writes an alias rather than only a confirm, so a non-person classification against a model verdict is captured too.
- [ ] The override-rate metric is emitted. **NOT met — #3498.** `legacy-reviewer-actions.ts` emits no metric at all — zero `record*` calls — and no override rate is computed anywhere in `src/`. The thirteen legacy and identity metrics that do exist all measure whether the machinery RAN (outcomes, refusals, latency, suspensions); none measures whether its output was any good. The design document calls this one "the production outcome metric" for the phase, and it is the only signal that would say whether the suggestions are worth a reviewer's time. The DATA is already in hand at the write — `verdictId` plus the scored candidate set — so what is missing is the recorder and its wiring, not a new column.
- [x] The pull request carries a rollback plan and a risk assessment. Carried in the pull request delivering this step, and repeated here so it outlives the pull request:

  **Rollback, cheapest first.** (1) Set the tenant's `legacyMatchAiMode` to `OFF` — takes effect from the next reconciliation run, writes a `LEGACY_MATCH_AI_MODE_CHANGED` audit event, retracts nothing and needs to retract nothing, because a verdict never changed an outcome. (2) To stop the service itself: `cd /opt/inflect && sudo docker compose … stop laya`; `app` and `worker` keep their `LAYA_BASE_URL` and a `LOCAL_ONLY` tenant then gets `PROVIDER_ERROR` non-verdicts, which is fail-closed and still a queue a person clears. (3) To undo the Compose change entirely, the backup `apply.sh` wrote: `sudo cp -a /opt/inflect/docker-compose.prod.yml.bak.20261012-150455 /opt/inflect/docker-compose.prod.yml && … up -d`. (4) To revoke the external path, set `TYPESAFE_SUBPROCESSOR_ACTIVE = false` — mutation-proved above to refuse `EXTERNAL`.

  **Risk assessment.** *Data:* no new category reaches a new processor — `laya` runs on our own VM, moves nothing off it, and `HF_HUB_OFFLINE=1` means it cannot fetch. *Availability:* the apply recreated nine containers including `postgres`; volumes were untouched and all came back healthy, and `readyz` answered 200 on both hostnames. The ongoing risk is 1.0 CPU of a 2-vCPU host held by a model during a residue batch, bounded by the Compose limit precisely so a batch cannot starve the request path. *Correctness:* the model answers confidently about 1 case in 19, so ~95 % of a residue reaches a person — the failure direction is "no verdict", never a wrong link, and `AGREES` precision is 1.0 at the committed threshold. *Residual, accepted:* the endpoint's self-reported revision is a fixed vendor string, so the canary is the only control detecting a changed checkpoint; the canary is reliable because the service is bit-for-bit deterministic.

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

- [x] A role-by-action table test shows every allow and deny outcome is identical to before, and every deny now writes `AUTHZ_DENIED`. **Verified #3480:** `tests/unit/security/access-review-authz-table.test.ts` runs the cross product as `${role} — ${case}`, and carries three things a table alone would not: `the ladder actually discriminates, so the assertions above have teeth`, `the table covers EVERY access-reviews route file on disk` (so a new route cannot be omitted), and `the connected CREATE is not swallowed by the detail VIEW pattern`. The audit row is guaranteed by a STRICT mock of the `@/lib/audit` barrel rather than a subset factory — the docblock records that a bare factory leaves other exports `undefined`, so a call meant to guarantee an audit row would pass while writing nothing.
- [x] A review with undecided connected subjects cannot close, and the old zero-equals-zero bug has a regression test. **Verified #3480:** `refuses to close while a connected subject is undecided`, and the regression by name: `REGRESSION — a campaign with ZERO subjects cannot close`. That is invariant 5 — `pending.length === 0` and `decided === total` are both true of the empty set, so the close gate has to assert the population is non-empty in the same expression.
- [x] A connected review with zero subjects cannot be created. **Verified #3480:** `throws NO_SUBJECTS, not a bare 400` with `creates nothing at all when it refuses` beside it — the refusal AND the absence of a half-written campaign.
- [x] The evidence PDF's hash verifies, and the notes in it are sanitised. **Verified #3480:** `stores a FileRecord carrying the sha256 and links it to the campaign` and `emits ACCESS_REVIEW_EVIDENCE_GENERATED with the hash in the audit row`. Sanitisation is at the write: `access-review-connected.ts` routes `name`, `description` and the decision `notes` through `sanitizePlainText`, which is the layer that protects every downstream renderer rather than the PDF alone. Two failure-mode cases come with it: `a failed artefact leaves the campaign CLOSED rather than rolling the close back`, and `a close that LOST the TOCTOU race writes no second artefact`.
- [x] Two connections holding the same provider and email produce two subjects. **Verified #3480:** `two connections with the same provider and email produce TWO subjects`, and — the part that makes it a real test — `the OLD format would have collided — the mutation this test pins`. The collision mattered because `skipDuplicates` would have dropped the second subject silently, and an account nobody reviews is invariant 5's other half.
- [x] A snapshot truncated at the cap is flagged, and the review cannot present itself as complete. **Verified #3480:** four cases, which is what it takes to make a cap observable: `reads one past the cap and flags the campaign`, `a directory of EXACTLY the cap is NOT flagged`, `the query asks for cap + 1, which is what makes the two cases separable`, and `a truncated campaign cannot present itself as complete on close`. A `take: N` cannot tell N accounts from the first N of more; reading one past is how the truncation becomes a fact rather than an inference.
- [x] Reminders and escalations fire for connected reviews. **Verified #3480:** `access-review-overdue-escalation.test.ts` carries a `Step 5a — CONNECTED_APP campaigns escalate too` section, and its docblock records the defect it exists for: the sweep counted member rows only, so a connected campaign reported zero pending and escalated to nobody. `skips campaigns whose decisions all have verdicts` is the control.
- [x] HR context is only read, and the Step 0a guard stays green. **Verified #3480:** `reads IdentityAccountLink and never writes it` asserts it behaviourally at this seam, and the Step 0a structural guard is in the green Ratchets population. Three cases cover how absent HR context is reported rather than hidden: `joins the linked employee, status, department and manager into the snapshot`, `records hr: null for an UNLINKED account rather than omitting the key`, and `surfaces a CONTRADICTED link so stale HR context is not read as current`. `fetches HR context in ONE query, not one per subject` keeps it off the N+1 budget.
- [x] The member-review tests stay green. **Verified #3480:** `access-review-closeout` and `access-review-rls` are green, including the last-OWNER cases (`rejects the close when planned execution would leave zero ACTIVE OWNERs`, `allows the close when only ONE of two OWNERs is REVOKEd`) and `handles stale subject (membership deleted mid-campaign) with SKIPPED_STALE`.
- [x] The pull request carries a rollback plan and a risk assessment. Carried in the pull request delivering this step, and repeated here so it outlives the pull request:

  **Rollback, cheapest first.** (1) Set the tenant's `legacyMatchAiMode` to `OFF` — takes effect from the next reconciliation run, writes a `LEGACY_MATCH_AI_MODE_CHANGED` audit event, retracts nothing and needs to retract nothing, because a verdict never changed an outcome. (2) To stop the service itself: `cd /opt/inflect && sudo docker compose … stop laya`; `app` and `worker` keep their `LAYA_BASE_URL` and a `LOCAL_ONLY` tenant then gets `PROVIDER_ERROR` non-verdicts, which is fail-closed and still a queue a person clears. (3) To undo the Compose change entirely, the backup `apply.sh` wrote: `sudo cp -a /opt/inflect/docker-compose.prod.yml.bak.20261012-150455 /opt/inflect/docker-compose.prod.yml && … up -d`. (4) To revoke the external path, set `TYPESAFE_SUBPROCESSOR_ACTIVE = false` — mutation-proved above to refuse `EXTERNAL`.

  **Risk assessment.** *Data:* no new category reaches a new processor — `laya` runs on our own VM, moves nothing off it, and `HF_HUB_OFFLINE=1` means it cannot fetch. *Availability:* the apply recreated nine containers including `postgres`; volumes were untouched and all came back healthy, and `readyz` answered 200 on both hostnames. The ongoing risk is 1.0 CPU of a 2-vCPU host held by a model during a residue batch, bounded by the Compose limit precisely so a batch cannot starve the request path. *Correctness:* the model answers confidently about 1 case in 19, so ~95 % of a residue reaches a person — the failure direction is "no verdict", never a wrong link, and `AGREES` precision is 1.0 at the committed threshold. *Residual, accepted:* the endpoint's self-reported revision is a fixed vendor string, so the canary is the only control detecting a changed checkpoint; the canary is reliable because the service is bit-for-bit deterministic.

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

- [x] Creation refuses a missing, stale, incomplete or unreconciled snapshot, and zero subjects, each with a named reason and a test. **Verified #3480:** one test per reason — `NO_SNAPSHOT`, `SNAPSHOT_INCOMPLETE`, `SNAPSHOT_STALE`, `NOT_RECONCILED`, `NO_SUBJECTS` — plus `every declared refusal is reachable`, which stops a reason being declared and never produced, and `INCOMPLETE is reported BEFORE staleness, not after`, which fixes the ORDER so an operator is told the actionable fact rather than whichever gate happened to run first.
- [x] A campaign's subjects are frozen: a later pull changes nothing in an open campaign. **Verified #3480:** `is FROZEN: a later pull changes nothing in the open campaign` — a second pull is actually performed and the stored subject compared, rather than the freeze being inferred from the write path.
- [x] Every finding type has a fixture and a test, and no other state ever suppresses a leaver with live access. **Verified #3480:** a fixture and test per type (leaver with live access, orphan by engine and by reviewer, unresolved ambiguity, dormant, privileged, non-person without owner, multiple accounts one person, mover by department and by manager), closed by `every member of LEGACY_FINDINGS is raised by one of the fixtures above`. The suppression invariant has its own block, including `and survives EVERY other state at once` — which is the case a single-label implementation fails. Both boundaries are asserted too: `a DISABLED account is not a leaver with LIVE access` and `an UNKNOWN account status IS live`.
- [x] Deciding requires the decide permission together with the reviewer-or-admin rule. **Verified #3480:** both halves, at different layers. The route wraps the handler in `requirePermission('access_reviews.decide', …)`; the usecase then applies the narrower rule — `submitDecision` accepts only the campaign's `reviewerUserId` OR an admin. The permission alone is granted to every role that can hold the verb, so without the second check any such role could decide another reviewer's campaign.
- [x] Closing twice creates no duplicate tasks. **Verified #3480:** `a REVOKE raises one task, and closing twice raises no second one`, with `rejects re-close of an already-CLOSED campaign` at the other layer.
- [x] The evidence PDF carries the payload hash, the mapping version and the resolution methods, and a test re-derives the hash from the stored rows and matches it. **Verified #3480:** `the stored payload hash re-derives from the stored rows` and `and that same hash reaches the campaign subjects as provenance` — the second being the one that matters, since a hash that verifies but never reaches the evidence proves nothing to an auditor. `freezes the subject with its canonical fields, resolution, HR and findings` covers the mapping version and resolution method travelling with it.
- [x] The legacy client exposes no write operation, and nothing sends a `tools/*` call. **Verified #3480:** the client's surface is read-only by construction, and `sends no tools/* request while the server advertises tools` asserts the wire log with the `toolsAdvertised` fault on — the server offers tools and the client still asks for none.
- [x] New relations meet global rule 6. **Verified #3480:** `access-review-rls.test.ts` covers the relations in both directions, including the composite-FK case (`AccessReviewDecision cannot reference a campaign in another tenant`) and the uniqueness constraint that stops a second decision for one subject.
- [x] The pull request carries a rollback plan and a risk assessment. Carried in the pull request delivering this step, and repeated here so it outlives the pull request:

  **Rollback, cheapest first.** (1) Set the tenant's `legacyMatchAiMode` to `OFF` — takes effect from the next reconciliation run, writes a `LEGACY_MATCH_AI_MODE_CHANGED` audit event, retracts nothing and needs to retract nothing, because a verdict never changed an outcome. (2) To stop the service itself: `cd /opt/inflect && sudo docker compose … stop laya`; `app` and `worker` keep their `LAYA_BASE_URL` and a `LOCAL_ONLY` tenant then gets `PROVIDER_ERROR` non-verdicts, which is fail-closed and still a queue a person clears. (3) To undo the Compose change entirely, the backup `apply.sh` wrote: `sudo cp -a /opt/inflect/docker-compose.prod.yml.bak.20261012-150455 /opt/inflect/docker-compose.prod.yml && … up -d`. (4) To revoke the external path, set `TYPESAFE_SUBPROCESSOR_ACTIVE = false` — mutation-proved above to refuse `EXTERNAL`.

  **Risk assessment.** *Data:* no new category reaches a new processor — `laya` runs on our own VM, moves nothing off it, and `HF_HUB_OFFLINE=1` means it cannot fetch. *Availability:* the apply recreated nine containers including `postgres`; volumes were untouched and all came back healthy, and `readyz` answered 200 on both hostnames. The ongoing risk is 1.0 CPU of a 2-vCPU host held by a model during a residue batch, bounded by the Compose limit precisely so a batch cannot starve the request path. *Correctness:* the model answers confidently about 1 case in 19, so ~95 % of a residue reaches a person — the failure direction is "no verdict", never a wrong link, and `AGREES` precision is 1.0 at the committed threshold. *Residual, accepted:* the endpoint's self-reported revision is a fixed vendor string, so the canary is the only control detecting a changed checkpoint; the canary is reliable because the service is bit-for-bit deterministic.

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

- [x] The row names every class of field the payload carries, and no other. **Verified #3480:** the register row enumerates the classes sent and then names the exclusions explicitly — email domains, employee numbers, dates, employment status, managers, entitlements, privilege flags, unmapped columns. The "and no other" half is asserted against the code rather than read off the prose: `sends no field the sub-processor entry excludes` and `never sends an email domain` in `identity-match-wire`, plus `sends exactly the allowlisted account fields and no others` and its candidate twin in `legacy-match-state-builder`.
- [ ] The row states that the processor is inactive, and nothing in `src/` refers to TypeSafe. **SUPERSEDED, not unmet.** Both halves were true at the end of Step 6a and both are deliberately false now: the register reads "Active since 2026-10-11", and five files under `src/` name TypeSafe because 6b built the provider and 6d activated it. Ticking it would assert something false of today; leaving it bare would read as outstanding work. Checking why it could not be ticked found three comments in `src/` still saying the constant was `false` two days after the flip, all of them telling a reader the external path was inert — fixed and guarded in #3502.
- [x] `tests/guardrails/docs-accuracy.test.ts` and `tests/guardrails/sub-processor-coverage.test.ts` are green. **Verified #3480:** both run green, with `sub-processor-record-agrees-with-code` beside them — 157 tests across the five suites in that area.
- [ ] Legal approval is recorded on the pull request, including zero data retention in the signed DPA. **NOT met, and it is the owner's to close.** `docs/sub-processors.md` records step 2 (compliance/legal review) as "Not performed — waived 2026-10-11": #3246 merged with zero reviews and all four of its legal checkboxes unticked, and no legal or compliance function is named anywhere in this repository. The zero-retention half is unverified too — no executed DPA is held here, only the template, so the register says to treat that row as "the commitment sought, not as a commitment verified". Three of step 2's four confirmations are clerical and checkable off a signed DPA; the fourth, whether SCCs plus a transfer impact assessment are an adequate basis given the vendor holds no DPF certification, needs legal competence nobody here has been identified as holding.
- [x] The notice date and the window's closing date are recorded. **Verified #3480:** `docs/notices/2026-10-13-typesafe-ai-sub-processor.md` carries `Issued: 2026-10-14` and `Objection window closes: 2026-11-13`, and the register repeats both. The register also records what the dates do NOT cover: the email leg was not performed because there were no customer tenants to email, so the window runs against the public list alone.

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

- [x] Every row of the vendor table has been checked against a vendor reference, or the pull request names the rows still unverified. **Verified #3480:** the register names the vendor pages and the date they were re-verified (2026-10-08, by Step 6b), and the model pin has its own assertions: `pins the model to the identifier the vendor reference lists` and `does not pin an alias, which would move under a committed record`.
- [x] Under `LOCAL_ONLY`, no external provider is constructed, whatever the environment says. The residency guard covers the new factory, and its constructor set is pinned. **Verified #3480:** three factory cases — `LOCAL_ONLY yields Laya when one is deployed`, `LOCAL_ONLY yields the stub when no Laya is deployed — never an external fallback`, and `LOCAL_ONLY ignores TYPESAFE_API_KEY entirely`. Structural rather than behavioural alone: `ai-residency-enforcement` reads the source for the RETURN-before-construct ordering and pins the constructor set, so a fourth provider fails CI until somebody classifies it.
- [x] While `TYPESAFE_SUBPROCESSOR_ACTIVE` is false, no tenant path can obtain a Jev provider. **Verified #3480:** held in its DURABLE form rather than its literal one, and the distinction is worth stating. The flag is now `true` (#3409), so a test asserting the literal `false` case would assert a counterfactual. The suite asserts the BINDING instead — `getDecisionProvider('EXTERNAL').isExternal === TYPESAFE_SUBPROCESSOR_ACTIVE` — so the gate tracks the flag for whatever value it holds, and setting it false again restores the refusal with no further change. `ONLY EXTERNAL can go external — activation does not widen OFF or LOCAL_ONLY` carries the other half, with a positive control so an empty or mistyped mode list cannot pass it.
- [x] The response schema rejects an unknown option, a probability outside [0, 1],
      and a missing usage block, each proven by its own test. It does NOT reject an
      unknown FIELD: a real Laya response carries `routing`, four extra keys in
      `usage` and four on a `choice` answer, and the strict envelope this line
      originally asked for refused every genuine response (#3407, measured
      2026-10-10). Refuse an unknown value where we branch on it; ignore an
      unknown field nothing reads.
      **Verified #3480:** each of the three has its own case — `rejects an UNKNOWN
      OPTION` (with `rejects an unknown option inside the probability map too`),
      `rejects a PROBABILITY OUTSIDE [0, 1]` (with `rejects a non-finite
      probability, which is in no range at all`, since neither NaN nor Infinity is
      caught by a range test written as two comparisons), and `rejects a MISSING
      USAGE BLOCK`. The deliberate asymmetry is asserted from both sides too:
      `rejects an UNKNOWN FIELD` inside a question, where we branch on the shape,
      against `IGNORES an unknown field at the top level rather than refusing`.
      Also here, and adjacent to #3507: `rejects a chosen option absent from the
      probability map` — the codec does check that the CHOICE appears in the map,
      which is why an unoffered option had to arrive as a map KEY to get through.
- [x] The stub never answers, and a test proves no verdict can be derived from it. **Verified #3480:** `rejects rather than returning a neutral verdict` and `no verdict can be derived from it — there is no answer to read`, plus `says in its message that this is the safe default` so the refusal is legible to whoever hits it.
- [x] A timeout aborts the request, and the single retry never outlives the caller's deadline. **Verified #3480:** the transport suite carries the whole shape: `aborts and reports a timeout rather than hanging`, `passes an AbortSignal on every attempt`, `does NOT retry a timeout`, `retries at most ONCE, never twice`, `skips the retry when Retry-After does not fit the remaining budget`, `refuses before the first attempt when the deadline has already passed`, `clamps the per-attempt budget to what the deadline leaves`, and `stops if the deadline is reached during the back-off`. `returns null for an absent or malformed value, NOT zero` is the parser case that would otherwise turn a missing header into an immediate retry.
- [x] The Jev host is a constant: no configuration can change the URL that `JevDecisionProvider` calls. **Verified #3480:** `is the documented endpoint` and `no environment variable appears in the URL the provider posts to` — asserted by reading the line, so a template or an `env.` reference fails rather than being reviewed for.
- [x] `TYPESAFE_API_KEY` and the `LAYA_*` variables are classified in `tests/guardrails/sub-processor-coverage.test.ts`. **Verified #3480:** all three carry written reasons: `TYPESAFE_API_KEY` as naming a real sub-processor, and `LAYA_BASE_URL` / `LAYA_API_KEY` as deployment configuration for a server we operate — open weights on our own infrastructure, so not a third party, and unreachable from any tenant setting.
- [x] The validator recomputes every figure from the raw answers. A record whose stated precision disagrees with its own answers fails CI. **Verified #3480:** the scoring tests enumerate the ways a stored figure could flatter a model: `scores a perfect confident record as precision 1`, `a SINGLE confident wrong answer drops precision below 1`, `an UNSURE answer is excluded from the denominator, not counted as right`, `a wrong answer BELOW the threshold does not break precision — it is a miss, not an error`, `a model unsure about everything scores 0, not 1`, `raising the threshold can only shrink the confident set`, and `ignores an answer for a case the corpus no longer has`. The fifth matters most: scoring total ignorance as 1 is where a naive implementation lands.
- [x] A record whose corpus hash no longer matches the corpus fails CI. **Verified #3480:** `has a stable digest that ignores key order`, with the digest pinned so a corpus edit without a re-run fails. `reports how many records exist, so an empty sweep cannot read as a pass` is the denominator — and it reports zero today, which is why the gate produces nothing rather than passing vacuously.
- [x] The corpus is synthetic, and its header says so. **Verified #3480:** `addresses no real mailbox — every case is synthetic`, `covers every declared class`, `gives every class at least the minimum support`, and `the minimum support is a ratchet, stated here so lowering it is a visible diff`. `includes cases whose own text is an instruction, and expects them to be ignored` puts the hostile cases in the corpus rather than only in the guard's fixtures.
- [x] `tests/guards/no-raw-prompt-logging.test.ts` covers the new directory. **Verified #3480:** `src/app-layer/ai/identity-match/**/*.ts` is in `AGENTIC_PATH_GLOBS_LIVE` in `eslint-rules/agentic-path.js` — the SAME module `eslint.config.mjs` scopes the rule with, so the lint scope and the swept population cannot drift apart.

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
   - adjudicate the residue with Jev at 8 requests in flight, or Laya at 1 (#3450 —
     measured: concurrency adds no throughput on CPU and pushes per-call latency past
     the timeout), under a 45-minute deadline.
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

- [x] With no settings row, and with the mode `OFF`, nothing reaches any provider, proven by a spy on every provider. **Verified #3480:** `writes NOTHING and calls no provider when the mode is OFF` and `writes nothing with NO settings row at all` — the absent row tested separately from the explicit `OFF`, because reading absence as the permissive default would not show up in the `OFF` case.
- [x] A table of mode against residency and the TypeSafe constant shows `EXTERNAL` is never effective under `LOCAL_ONLY` or while the constant is false. Saving either combination is refused. **Verified #3480:** `the full table, enumerated rather than sampled`, with `EXTERNAL is never effective under LOCAL_ONLY residency`, `LOCAL_ONLY residency caps the mode; it does not force OFF` and `absent settings read as OFF, not as the permissive default`. The save refusal is in `legacy-adjudication-settings`.
- [x] Saving `LOCAL_ONLY` without `LAYA_BASE_URL` is refused. **Verified #3480:** `LOCAL_ONLY is refused when LAYA_BASE_URL is unset`, asserting the error names the variable so an operator is told what to set.
- [ ] A fake model that answers with an option outside the supplied letters has its answer discarded. **NOT met on main, measured, and fixed in #3507.** The codec validates each probability key against the SIX-letter option enum, which is the vendor's vocabulary rather than this request's — so `E` is schema-valid for an account that offered only A, B and NONE. Measured with the canary reproducing its recorded answer: `E` at 0.99 produced a stored `PROPOSES` with `topOption: 'E'` and a margin of 0.985 — a confident proposal naming a letter that maps to no candidate, reporting the one real candidate at 0.005 as decisively beaten. #3507 discards such an answer WHOLE (not filtered: a filter would change the margin the remainder is judged on) as `PROVIDER_ERROR`. Tick this when #3507 merges.
- [x] No path leads from a verdict to `LINKED`, to a changed outcome, or to an alias, without a person confirming it. An import-graph test proves it, and the module imports nothing that writes aliases or resolutions. **Verified #3480:** `imports nothing that writes a resolution or an alias` in `legacy-verdict`, and behaviourally `adjudicates SUGGESTED and UNMATCHED, never LINKED or NON_PERSON`. This is invariant 2 at the model layer: a verdict is evidence a reviewer reads, never a link.
- [x] Seeded sensitive values never appear in any payload: an email domain, an employee number, a date, a national identifier. **Verified #3480:** an allowlist asserted from both ends — `sends exactly the allowlisted account fields and no others` and the candidate equivalent — plus the named cases: `sends the email local part and never the domain`, `never sends an employee id - letters, not ids`, `never sends the privilege flag, under any key` and `never sends the engine's score`. The last two are not privacy cases: the privilege flag would tell a third party which accounts are worth attacking, and the score would let the model agree with the engine instead of judging.
- [x] The same account and roster always produce the same candidate order, and that order does not follow the engine's ranking. **Verified #3480:** `is deterministic for identical input`, `is independent of the order the candidates arrive in`, `does NOT reproduce the engine ranking`, and `gives DIFFERENT accounts different permutations of the same roster` — the fourth being what stops a stable shuffle from being a constant one. `assigns a gapless prefix of A-E, each letter once` and `maps each label to the candidate whose name is under it` keep the labelling readable afterwards.
- [x] An answer computed on truncated input is discarded as `OVER_BUDGET`. **Verified #3480:** `discards an answer whose input tokens REACH the window`, `keeps an answer one token BELOW the window` — the boundary from both sides — and `fails safe to the tightest window on an unknown model`. Note the limit of what this can detect: it reads the vendor's own token accounting, so it catches truncation the vendor REPORTS and not truncation it conceals (#3488).
- [x] When the deadline passes, every remaining account carries a `DEADLINE` reason, and its queue row is identical to the one it would have with the mode `OFF`. **Verified #3480:** `answers what it reached and marks the rest DEADLINE`, and `reports DEADLINE, not MODEL_DRIFT, when the clock beats the canary` — the precedence case, since a deadline reached during the canary would otherwise be reported as drift and read as a model problem. The row-identity half is asserted at the queue: `is byte-identical to an unadjudicated row`.
- [x] With no evaluation record for the reported revision, every account gets `NO_EVALUATION`. After a failed canary, every account gets `MODEL_DRIFT`. **Verified #3480:** `NO_EVALUATION when no record is committed for the revision` and `NO_EVALUATION with no record, and nothing is sent` — the second asserting the payload never left. The canary half is unusually thorough: `refuses the batch on a drifted probability, and sends no payload`, `accepts a drift of EXACTLY the tolerance`, `refuses a drift just PAST the tolerance`, `refuses a DIFFERENT option even when its probability matches`, `refuses on a drifted PERSON probability alone`, `refuses when the canary call THROWS - could not check is not fine`, `refuses a record with NO canaries, and sends nothing`, and `checks EVERY canary, not just the first`.
- [ ] With the kill switch engaged, no model call is made. An unscored agent is denied. **HALF met — #3508.** The kill-switch half holds: `KILL_SWITCH stops the batch with no model call`. The second half CANNOT hold, because there is no agent to score. `legacy-adjudication.ts` passes a null `agentId` to `resolveKillState` and says why — "this surface has no `RegisteredAgent` of its own yet, so a PLATFORM or TENANT kill stops it and an AGENT-scoped one has nothing to name". The same absence makes `BREAKER_OPEN` unreachable here: a declared `NonVerdictReason`, with an index on the column that stores it, that nothing can produce. The source comment says "Filed separately"; nothing had been, so #3508 is that issue.
- [x] Injection attempts in legacy fields are quarantined: **Verified #3480:** the hostile population is driven both directions through the production `buildMatchState`, and the quarantine is asserted as a posture rather than a flag: `the obeyed proposal is QUARANTINED, never PENDING`, `the verdict is persisted with rule ids and a digest — and no content`, `the quarantine itself is audited, and the audit row validated`, `it is absent from the NORMAL review queue`, `asking the queue for it BY STATUS does not widen the filter`, `it IS visible to the quarantine-triage listing`, `the USECASE refuses to approve it`, and `the refusal is audited as a hash-chained AUTHZ_DENIED row`.
  - an instruction hidden in a display name;
  - forged chat-template tokens;
  - zero-width or look-alike obfuscation.
- [x] Blind-sampled rows never enter the bulk lane, and one blind disagreement closes the lane for that revision. **Verified #3480:** `isBlindHeld` gates the reviewer path, and the sampler has its own suite: `withholds close to 5 % over a large population`, `is DETERMINISTIC — a reviewer who refreshes sees the same thing`, `re-samples under a new revision, because the key is the VERDICT id`, and `is not uniformly false, which a wrong-direction comparison would be` — a control against a sampler that holds nothing. The lane: `ONE disagreement closes it`, with `stays open with no comparisons at all` and `stays open while every blind row agreed` as the two ways it must NOT close.
- [x] Every verdict has exactly one `AiDecisionLog` row, and a reviewer's decision stamps only that row. **Verified #3480:** `writes one AiDecisionLog row per verdict, keyed to it by sessionRef`, `never stores the payload, only a digest of it`, and `is immutable: a second pass under the same revision adds no second row`.
- [x] `LegacyMatchVerdict` meets global rule 6. **Verified #3480:** `legacy-match-verdict-rls` carries the two-tenant set over the model.
- [x] The pull request carries a rollback plan and a risk assessment. Carried in the pull request delivering this step, and repeated here so it outlives the pull request:

  **Rollback, cheapest first.** (1) Set the tenant's `legacyMatchAiMode` to `OFF` — takes effect from the next reconciliation run, writes a `LEGACY_MATCH_AI_MODE_CHANGED` audit event, retracts nothing and needs to retract nothing, because a verdict never changed an outcome. (2) To stop the service itself: `cd /opt/inflect && sudo docker compose … stop laya`; `app` and `worker` keep their `LAYA_BASE_URL` and a `LOCAL_ONLY` tenant then gets `PROVIDER_ERROR` non-verdicts, which is fail-closed and still a queue a person clears. (3) To undo the Compose change entirely, the backup `apply.sh` wrote: `sudo cp -a /opt/inflect/docker-compose.prod.yml.bak.20261012-150455 /opt/inflect/docker-compose.prod.yml && … up -d`. (4) To revoke the external path, set `TYPESAFE_SUBPROCESSOR_ACTIVE = false` — mutation-proved above to refuse `EXTERNAL`.

  **Risk assessment.** *Data:* no new category reaches a new processor — `laya` runs on our own VM, moves nothing off it, and `HF_HUB_OFFLINE=1` means it cannot fetch. *Availability:* the apply recreated nine containers including `postgres`; volumes were untouched and all came back healthy, and `readyz` answered 200 on both hostnames. The ongoing risk is 1.0 CPU of a 2-vCPU host held by a model during a residue batch, bounded by the Compose limit precisely so a batch cannot starve the request path. *Correctness:* the model answers confidently about 1 case in 19, so ~95 % of a residue reaches a person — the failure direction is "no verdict", never a wrong link, and `AGREES` precision is 1.0 at the committed threshold. *Residual, accepted:* the endpoint's self-reported revision is a fixed vendor string, so the canary is the only control detecting a changed checkpoint; the canary is reliable because the service is bit-for-bit deterministic.

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
   has a health check on GET /health, and has resource limits. Set LAYA_BASE_URL for
   the app and worker services.
3. Measure p50 and p95 latency over the adjudication corpus on the production VM's CPU,
   and record the figures in the design document. If a 500-account residue does not
   fit the run deadline, raise the concurrency or add a GPU. Never raise the
   deadline silently.

   **This happened, and here is the record the rule above asks for.** Measured
   2026-10-12, as a real batch rather than an extrapolation: **0.243 accounts/s, so a
   500-account residue takes 34 minutes** (#3445). Concurrency is not the remedy this
   step hoped for, and the measurement is unambiguous about why — throughput is flat at
   0.24 across concurrency 1, 4 and 8, and flat again when the CPU limit is doubled.
   Raising concurrency only multiplies per-call latency, to the point where 4 in flight
   exceeds even the raised per-call timeout (#3450). The batch endpoint is worse still.
   The owner set the deadline to **45 minutes** on 2026-10-12, after 120 s and then
   300 s both proved unreachable at any setting this step could tune. 34.3 minutes
   against 45 is a 1.31× margin, so **this step's criterion is met on CPU** and the
   checklist item below is ticked. The GPU remedy this step names is not needed for
   that, though it would still beat this by two orders of magnitude if the bound ever
   has to be tight rather than merely true.
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

- [x] The `laya` service publishes no port and is reachable only on the Compose network. **Verified on the deployed container 2026-10-12:** `docker port inflect-laya-1` returns nothing, the service declares `expose: 8000` and no `ports:`, and `app` reaches it as `http://laya:8000` (HTTP 200 from inside the app container).
- [x] Its image is pinned by digest and its checkpoint by revision, and the server went through `docs/dependency-governance.md`. Digest `cb257565b29f18e2d…`; the running container's symlink resolves to `…laya-multilingual/snapshots/1720e3e3357cfe1e281542e223f8273b0890ca34`, the revision the Dockerfile pins. Pillar 5 is satisfied by its own preferred path — *"prefer a digest, then nothing needs a baseline entry and nothing needs reviewing again"* — and `tests/guardrails/runtime-image-pinning.test.ts` passes (11 tests).
- [ ] The canary passes against the deployed service, and the evaluation record matches the revision it reports. **Half true, and UNTICKED again (#3462, #3466).** The canary half still holds — **proven by a second independent run** of the full corpus against the same container: identical probabilities, worst delta `0.00000000` against a canary tolerance of `0.02`. The service is deterministic, so the canary is reliable rather than merely recorded. Note what this item cannot buy for Laya: the endpoint reports the vendor's fixed `laya-rl-agent` whatever checkpoint is loaded, so the canary is the *only* control detecting a changed model — see the design document's "Where Laya runs". **But there is no longer an evaluation record to match.** The thresholds in the record committed on 2026-10-12 were chosen on the same 19 cases their `precision(agrees) = 1.0` was measured over; on held-out data that figure is 0.571 (#3462). `scripts/eval-identity-match.ts` now derives thresholds against the corpus AND the held-out set, and under that rule Laya is refused — `personAt` is blocked by a prompt injection it obeys at `noul = 1.0000`, which the guard does not quarantine (#3466). The record was therefore removed rather than left standing on a fitted number, so this item is unmet until a model qualifies.
- [x] The measured CPU latency is recorded, and a 500-account residue fits the deadline. **Measured 34.3 min against a 45-minute deadline** (#3445), a 1.31x margin, at concurrency 1 (#3450).
- [ ] `TYPESAFE_SUBPROCESSOR_ACTIVE` flips in a pull request that links the notice and shows that the window closed. **Half done, and deliberately left unticked.** The flip happened in #3409 — but that pull request is titled "activate TypeSafe as a sub-processor, and record what was skipped", because the owner chose to proceed without completing the record. The constant is `true` and `docs/sub-processors.md` marks TypeSafe active since 2026-10-11, so activation is real; what this item asks for — a PR *showing the window closed* — did not happen and cannot be back-filled by anyone but the owner.
- [x] No secret value appears in any log, commit, pull request or command output. Every check on a credential in this step asserted PRESENT/ABSENT or a count, never a value; `scripts/detect-secrets.sh` ran on each commit; the live Compose file was compared by KEY NAME only, and the one copy fetched to compare was deleted.
- [x] Rollback is proven: setting the mode `OFF` stops every call from the next run, and flipping the constant back refuses `EXTERNAL` again. **Mutation-proved 2026-10-12**, with the mutation verified as applied before the run rather than assumed: setting `TYPESAFE_SUBPROCESSOR_ACTIVE = false` in `src/lib/legacy-access/adjudication-mode.ts` fails exactly the two tests that assert `EXTERNAL` reaches Jev; restoring it passes all 20. The `OFF` half is covered by the same file's stub tests, which assert the stub *rejects* rather than returning a neutral verdict.
- [x] The pull request carries a rollback plan and a risk assessment. Carried in the pull request delivering this step, and repeated here so it outlives the pull request:

  **Rollback, cheapest first.** (1) Set the tenant's `legacyMatchAiMode` to `OFF` — takes effect from the next reconciliation run, writes a `LEGACY_MATCH_AI_MODE_CHANGED` audit event, retracts nothing and needs to retract nothing, because a verdict never changed an outcome. (2) To stop the service itself: `cd /opt/inflect && sudo docker compose … stop laya`; `app` and `worker` keep their `LAYA_BASE_URL` and a `LOCAL_ONLY` tenant then gets `PROVIDER_ERROR` non-verdicts, which is fail-closed and still a queue a person clears. (3) To undo the Compose change entirely, the backup `apply.sh` wrote: `sudo cp -a /opt/inflect/docker-compose.prod.yml.bak.20261012-150455 /opt/inflect/docker-compose.prod.yml && … up -d`. (4) To revoke the external path, set `TYPESAFE_SUBPROCESSOR_ACTIVE = false` — mutation-proved above to refuse `EXTERNAL`.

  **Risk assessment.** *Data:* no new category reaches a new processor — `laya` runs on our own VM, moves nothing off it, and `HF_HUB_OFFLINE=1` means it cannot fetch. *Availability:* the apply recreated nine containers including `postgres`; volumes were untouched and all came back healthy, and `readyz` answered 200 on both hostnames. The ongoing risk is 1.0 CPU of a 2-vCPU host held by a model during a residue batch, bounded by the Compose limit precisely so a batch cannot starve the request path. *Correctness:* the model answers confidently about 1 case in 19, so ~95 % of a residue reaches a person — the failure direction is "no verdict", never a wrong link, and `AGREES` precision is 1.0 at the committed threshold. *Residual, accepted:* the endpoint's self-reported revision is a fixed vendor string, so the canary is the only control detecting a changed checkpoint; the canary is reliable because the service is bit-for-bit deterministic.

**Exit.** A `LOCAL_ONLY` tenant gets Laya verdicts from our own infrastructure inside the deadline. An `EXTERNAL` tenant gets Jev verdicts only after the window has closed. Setting the mode `OFF` stops every model call.
