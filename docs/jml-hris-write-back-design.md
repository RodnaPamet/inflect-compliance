# JML HRIS write-back — the outbound work-email write

> **Status: living design** — the product has never written a byte to an HRIS. This document is the
> design record for the capability that does: after Entra mints a joiner's work email, the product
> writes that email BACK into the customer's HR system of record. Nothing described under
> [Roadmap](#roadmap-future-direction) is built. What is built, and what it forecloses, is under
> [Current state](#current-state-true-today).

Companion to [`jml-joiner-design.md`](./jml-joiner-design.md), which names this capability as one of
three the joiner is blocked on and settles some of its vocabulary. Where that document already
decided something, this one adopts the decision by name rather than re-deriving it. Where this
document goes further — the idempotency conditional, the breaker denominator, the ladder question —
it says so.

**Citation convention.** Every `file:line` below was re-derived by grep against `f31514057` on
**2026-09-13**, and re-derived a second time the same day after adversarial review. Each citation
carries enough of the symbol name to be re-found after the next drift; the line number is a
convenience, the symbol is the evidence. Two citations in this lane's brief had already drifted, and
both are corrected in the next section — **a drifted citation is not evidence that a claim moved.**
When you edit this file, re-derive what you touch.

**Quotation convention, because this document got it wrong once.** A span set in italic quote marks
is the source text word for word, with three declared exceptions: markdown emphasis markers inside
it are dropped, a nested double quote is rendered as a single one, and an elision is marked `…`.
Anything that is a summary of a source, or a hypothetical, is written **without** quote marks and
says so. The first draft of this file violated that. It marked the phrase *a later read observed the
intended end state* as a quotation of `identity-write-journal.ts` — a string that exists nowhere in
this repo, spliced from that function's docblock (which says *"OBSERVED the intended end state"*)
and a runtime `detail` literal about a different act (*"a later read observed the account
disabled"*). The underlying claim was true and the line number was right; the quotation was
manufactured, and quotation marks are a claim of their own. It is corrected in
[Decision 4](#decision-4--a-rejection-is-proven-a-transport-failure-is-not-and-a-200-is-neither).
Every other quoted span in this file has since been matched against its source by script, and the
few that were not word-perfect — a lower-cased first letter, backticks added inside a quotation, a
sentence truncated without an ellipsis — were corrected rather than re-labelled.

---

## Current state (as of writing — PARTLY SUPERSEDED)

> **Phase 0 shipped on 2026-09-17 (#2549) and this section predates it.** Everything below
> describing `r.id` as unrequested, `externalId` as a three-step fallback, and the row id as
> "missing" was true when written and is not true now: `id` is requested explicitly, the middle
> term is deleted, and the handle persists to `Employee.hrisRecordId`.
>
> The `hris/index.ts:259` / `:267` citations throughout this section point at lines the change
> itself moved. They are left in place rather than silently re-pointed, because this section is a
> record of the reasoning at a moment — re-deriving them would make it look like the analysis was
> done against today's code, which it was not. Read them as historical.
>
> What is NOT superseded: the argument. Why a payroll number and an email are both unusable as an
> update subject, and why the handle needed its own column rather than repointing `externalId`, is
> the reasoning Phase 0 acted on.

### The two outbound POSTs in the HRIS providers, re-derived

The brief for this work cited these as `workday/token.ts:122` and `hris/index.ts:226`. The first is
exact. The second has drifted by 31 lines. **The claim did not move; the line did** — the body at
`:257` is the same BambooHR roster read the brief describes, and there is no third POST in either
provider.

| Call | Cite | What it is |
| --- | --- | --- |
| Workday OAuth2 token exchange | `workday/token.ts:122` (`method: 'POST'` inside `postToken`) | A credential request to the tenant token endpoint. Writes nothing to the HRIS. |
| BambooHR roster read | `hris/index.ts:257` (`method: 'POST'` inside `fetchBambooRoster`) | A POST whose **body is a field list** (`hris/index.ts:259`) and whose **response is the roster**. A read wearing a POST, because BambooHR's custom-report endpoint takes its projection in the body. |

Derivation: `grep -rn "method: *['\"]\(POST\|PUT\|PATCH\|DELETE\)" src/app-layer/integrations/` returns
17 hits across the whole integrations tree; exactly two are under `providers/workday/` or
`providers/hris/`, and they are the two above.

**So the brief's motivating fact holds: no byte has ever been written to an HRIS.**

One adjacent correction, because it changes what prior art is available. The *repo* is not
write-naive — ServiceNow, SharePoint, GitHub, Entra and Google Workspace all have outbound writers
in that same grep. What is absent is specifically an **HRIS** write. The consequence is useful: the
ServiceNow writer is real prior art for outbound idempotency, and the Entra writer is real prior art
for the credential shape. Neither has to be invented here.

### The subject of this write does not exist in our data model

This is the finding that governs the whole design, and it is not in the brief.

The operator's flow, quoted verbatim in the joiner design (`jml-joiner-design.md:229-231`), is:
*"Joiner is created in HRIS without email … The work email created through Entra is written back to
HRIS."* A person with no work email is dropped **three independent times**, at three different
layers, before they could ever become a row this product can act on:

| Layer | Code | Cite |
| --- | --- | --- |
| BambooHR provider | `.filter((e) => e.workEmail)` | `hris/index.ts:276` |
| Workday roster normaliser | `if (!workEmail) return null;` | `workday/roster.ts:117` |
| `hris-sync` usecase | `if (!e.workEmail) continue;` | `usecases/hris-sync.ts:241` |

And the storage layer forecloses it structurally: `Employee.workEmail` is `String` — **NOT NULL** —
(`prisma/schema/personnel.prisma:235`) and `@@unique([tenantId, workEmail])` (`:257`) makes the work
email the *identity* of an employee row. The sync upserts on that composite key
(`usecases/hris-sync.ts:243`).

**The work email is not a field on the person. It is the person's primary key.**

That has a second consequence, which is the one that bites. The only pairing a sync ever creates
between an HRIS employee and a directory account is `EMAIL_EXACT` — the enum's own comment calls it
*"The only method a sync creates on its own"* (`prisma/schema/enums.prisma:1565-1566`, the comment on
`EMAIL_EXACT` inside `enum IdentityLinkMethod` at `:1564-1572`), and the sole creation site in `src/`
writes that literal (`usecases/identity-account-link.ts:212`). `EXTERNAL_ID` and `MANUAL` exist in
the enum and are created **nowhere** — `grep -rn "'EXTERNAL_ID'" src/` returns no `matchMethod`
assignment.

So the correspondence this write-back needs is circular:

> To write the email into the HRIS, we must know which HRIS record belongs to this Entra account.
> The only mechanism the product has for knowing that is the work email — which is the thing the
> write-back exists to create.

The write-back cannot be reached through the link table. It must be driven from whatever object
holds the pre-hire *before* they are an `Employee`, and that object does not exist today. Deciding
what it is belongs to the joiner's "capability 1" and is explicitly **not settled here**; this
document assumes only that the driving object carries an addressable HRIS record id.

### The handle needed for the write is not reliably in the read

Even granting a pre-hire object, the write needs an address. On BambooHR today:

- The report requests ten fields, and `id` is **not one of them**:
  `['workEmail','firstName','lastName','status','department','jobTitle','supervisorEmail','hireDate','terminationDate','employeeNumber']`
  (`hris/index.ts:259`).
- The mapper nonetheless reads it: `externalId: r.employeeNumber || r.id || r.workEmail`
  (`hris/index.ts:267`) — a three-step fallback whose middle term is a field nobody asked for.

`employeeNumber` is a customer-entered payroll field, not BambooHR's row id. So for every existing
BambooHR-sourced `Employee`, `externalId` is either a payroll number or an email address, and
**neither addresses an update API**. Workday is the same shape one level up:
`const externalId = row.employeeId || row.workerId || workEmail` (`workday/roster.ts:118`), drawn
from a *customer-authored* RaaS report template, so what that column actually holds is per-tenant.

This is the first implementation task and it is a read-path change with no write in it.

### A guard already forbids this pass from touching `Employee`

`tests/guards/employee-status-single-write-seam.test.ts:240` (the test *"writes an
Employee row from two files only"*) censuses every `.ts` under `src/` for a write to an `Employee`
row and asserts **exact equality** against two files — `usecases/personnel.ts` and
`usecases/hris-sync.ts` (`:250`). Its comment states the posture plainly: *"A third writer is a
finding to fix, never an entry to add — there is deliberately no allowlist."*

So a write-back pass that wanted to record its own result on the employee row **fails CI on the
first line that does it**. Combined with [the correspondence problem](#the-subject-of-this-write-does-not-exist-in-our-data-model),
this is what settles the shape: the write-back's state lives in `IdentityWriteJournal` and
`IntegrationExecution`, never on `Employee`, and the pre-hire it acts on is not an `Employee` row.
That is an existing rail agreeing with the conclusion, not a coincidence.

(The guard also carries its own vacuity control at `:231` — *"scans a real population (the scan
itself is not vacuous)"*, asserting `expect(sources.length).toBeGreaterThan(500)` at `:234`. The
ratchet that classifies *this* file has no equivalent floor, and the gap is wider than "missing
inside the per-file loop": its two cross-walk halves only check each other, so emptying **both**
populations at once — `listDocs()` returning `[]` and the parsed classification returning
`{ docs: {} }` — takes `tests/guardrails/docs-accuracy.test.ts` from 134 tests to 6, and all 6 pass.
Measured 2026-09-13 by patching both functions and re-running. Emptying only `listDocs()` *does*
redden `every classified entry exists on disk`, which is why the one-sided control looks sufficient.
Recorded because it is real, not because this document fixes it — it is a pre-existing property of
that ratchet and out of this lane's scope.)

### What the leaver has, that this must inherit or explicitly decline

| Piece | Where | Status today |
| --- | --- | --- |
| Ladder + rungs | `LADDER` `lib/identity/write-ladder.ts:48`; `coerceStoredMode` `:103`; `isAboveClamp` `:144` | Shipped, server-free module |
| Direction union | `type IdentityDirection = 'leaver' \| 'joiner'` `write-ladder.ts:149` | **Closed, two members** |
| Per-tenant storage | `identityLeaverMode` / `identityJoinerMode` `prisma/schema/auth.prisma:1329`, `:1330`; dwell stamps `:1336`, `:1337`; `FIELDS` map `usecases/identity-write-policy.ts:65` | **Exactly two mode columns** |
| Source-constant clamp | `LEAVER_MAX_MODE = 'AUTOMATIC'` `usecases/identity-leaver-pass.ts:130`, enforced `:883` | Shipped |
| Dwell | `DRY_RUN_MIN_DAYS = 7` `identity-write-policy.ts:58`, compared inside `describeRefusal` (`:122`) at `:188` | Shipped |
| Journal, capture-before-write | `beginWrite` `usecases/identity-write-journal.ts:89` | Shipped |
| Blast-radius breaker | `checkDisableBlastRadius` `usecases/identity-write-breaker.ts:141`, call site `identity-disable-account.ts:1287` | Shipped |
| Hash-chained audit | `auditDirectoryWrite` `usecases/identity-disable-account.ts:1124` | Shipped |
| Outcome enum | `DisableOutcome` `identity-disable-account.ts:61`; rendered via `OUTCOME_VARIANT` `LeaverPassesClient.tsx:156` | Shipped |
| Rejection vs transport | `DirectoryWriteError.definitivelyNotApplied` `identity-disable-account.ts:324`, read by `provenNotApplied` `:334` | Shipped |
| Per-connection write opt-in | `writesEnabled` field `entra-id/index.ts:184`, enforced `entra-id/writer.ts:688` | Shipped, Entra only |

### Three closed unions that a write-back is not a member of

Each is a schema or type change before it is a feature.

1. `enum IdentityWriteAction` (`prisma/schema/enums.prisma:1604`) — `DISABLE_ACCOUNT`,
   `ENABLE_ACCOUNT`, `CREATE_ACCOUNT`, `ASSIGN_GROUP`, `REMOVE_GROUP`. All five are **directory**
   verbs. Mirrored as a TS union at `usecases/identity-write-journal.ts:37`.
2. `recordIdentityWriteOutcome`'s `action` parameter is `'disable' | 'enable' | 'create'`
   (`lib/observability/integration-metrics.ts:246-250`).
3. `IdentityDirection` (`write-ladder.ts:149`), with `DIRECTION_IMPLEMENTED` keyed by it (`:175`),
   the admin route iterating `['leaver','joiner']` (`identity-write-policy/route.ts:61`) and the
   client doing the same (`WriteLadderClient.tsx:298`).

The journal's `provider` column is a plain `String` (`prisma/schema/personnel.prisma:371`), so it
already accepts `'bamboohr'` without a migration.

### The target connection is already pinned, and the reason names this work

`assertSoleEnabledHrisConnection` (`usecases/integrations.ts:185`) refuses a second enabled HRIS
connection per tenant, and its docblock gives this feature as the reason:

> *"One authoritative HRIS per tenant is the product intent. The joiner design writes an
> Entra-generated work email BACK to the HRIS, which needs a single system of record to write into;
> a second authoritative roster is not a feature this product is trying to have."*
> — `usecases/integrations.ts:155-158`

So a write-back never chooses among connections. Its limit is stated in the same docblock: the guard
fires on a write, so a tenant that **already** holds two enabled HRIS connections is not repaired by
it. A write-back must still handle finding two, and must refuse rather than pick.

### The credential we hold is read-shaped, and we said so to the customer

- **BambooHR.** One API key, Basic auth with the key as username (`hris/index.ts:253-255`), against
  `https://api.bamboohr.com/api/gateway.php/{subdomain}/v1/...` (`:255`). The setup form describes
  it to the admin as **"A read-only BambooHR API key."** (`hris/index.ts:229`). There is no OAuth
  flow and no scope string — a BambooHR key's permissions are a property of the key, invisible from
  a stored value. And `liveValidation = false` (`hris/index.ts:220`): the Test button checks field
  presence and makes no call.
- **Workday.** OAuth2 authorization-code with refresh, scope set as a source constant
  `WORKDAY_SCOPES = ['staffing']` (`workday/token.ts:42`). `liveValidation = true`
  (`workday/index.ts:89`) — the Test button does a real token exchange. The roster read is RaaS: *"a
  report an administrator publishes in their own tenant … There is no fixed `/employees` endpoint"*
  (`workday/roster.ts:1-8`), with the path as per-connection config (`workday/index.ts:98`).

**A report surface cannot accept a write.** Workday's write-back is therefore a second integration,
not a second method on this one.

The Entra precedent for what a write costs a customer is exact, and it is two independent gates:

> *"Additionally requires an administrator to consent the application permission
> User.EnableDisableAccount.All — the three read permissions above do not permit a write."*
> — `entra-id/index.ts:184`

plus the per-connection `writesEnabled` boolean that the writer's constructor refuses without
(`entra-id/writer.ts:688`).

### The roster read is allowed to be incomplete

This matters for the breaker, below. `ListEmployeesResult` carries a `complete` flag, set on
BambooHR by `const complete = rows.length <= MAX_EMPLOYEES` (`hris/index.ts:265`); Workday pages with
a resume token and `WORKDAY_MAX_PER_RUN = 5_000` (`workday/roster.ts:35`); and `hris-sync` has a
first-class `PARTIAL` status for a truncated-but-resumable pass (`usecases/hris-sync.ts:69`).

So "how many HRIS records are there" is a number the product routinely does not have.

---

## Roadmap (future direction)

### Decision 1 — BambooHR first

**Settled: BambooHR.** The evidence is about distance-to-an-attempted-write, in this repo and in the
customer's tenant, not about which vendor's API is better:

| | BambooHR | Workday |
| --- | --- | --- |
| Read surface | REST resource under a gateway base URL (`hris/index.ts:255`) | RaaS custom report, path is per-connection config (`workday/roster.ts:1-8`) |
| Distance to a write | Same client, same Basic auth header, different path and method | An entirely different API surface, with no client in this repo |
| Credential change for the customer | Issue/repermission one API key and paste it in | A new scope on `WORKDAY_SCOPES` (`workday/token.ts:42`), which is read **only** by `buildWorkdayAuthorizeUrl` (`workday/token.ts:99`, reading it at `:108`) — so every existing connection must be taken back through the consent flow by hand |
| Address for the write | BambooHR row id — obtainable by adding one field to `hris/index.ts:259` | A Worker WID, which the RaaS template may or may not emit (`workday/roster.ts:118`) |

**A correction to a claim this document made in draft, because the code contradicts it.** It is
tempting to say a `WORKDAY_SCOPES` change *invalidates* existing tokens. It does not.
`refreshWorkdayToken` sends `{ grant_type: 'refresh_token', refresh_token }` and **no `scope`
parameter at all** (`workday/token.ts:170`), and `WORKDAY_SCOPES` appears in exactly one other place
— the authorize URL (`workday/token.ts:108`). So every existing Workday connection keeps refreshing
indefinitely, holding the **old** scope set, with nothing anywhere reporting that it is now
insufficient.

That is worse than invalidation, not better. An invalidated token fails loudly at the next sync. A
silently under-scoped one works perfectly for the roster read it already does and fails only at the
first write attempt, as a 403, per candidate, long after somebody ticked a box. Whatever ships for
Workday must therefore treat scope as **unobservable from stored state** and prove it by attempting
something — the same conclusion BambooHR's opaque API key forces, reached by a different route.

**The counter-evidence, recorded rather than argued away.** BambooHR is the *weaker* provider on
verification: `liveValidation = false` (`hris/index.ts:220`) against Workday's `true`
(`workday/index.ts:89`). The provider we are most able to write with is the one we are least able to
prove we can reach. That does not reverse the ordering, but it does add a requirement: **the
BambooHR write path must carry its own live credential preflight.** It cannot lean on the Test
button, because the Test button proves nothing.

**What this decision rests on, which is not verified.** That BambooHR exposes an employee-update API
at the same gateway base, accepting the same Basic auth. That is a claim about a third-party API and
there is **no call site in this repo to show for it**. It is the single assumption the ordering
depends on, and it should be confirmed against a real tenant before anyone estimates this work. If
it is false, Decision 1 inverts and most of the rest of this document is unaffected.

### Decision 2 — not a new `IdentityDirection`, and not a separate ladder

**Settled: the write-back inherits the joiner's rung.** No third `IdentityDirection` member, no third
pair of columns on `TenantSecuritySettings`, no new dwell.

The argument is not economy of migrations. It is that a separately-settable write-back makes
reachable a configuration that is **strictly worse than both of its neighbours**: joiner at
`AUTOMATIC` with write-back at `DISABLED` creates real Entra accounts the HRIS will never know about
— which is precisely the orphan the joiner design names as the failure to design first
(`jml-joiner-design.md`, "The failure mode to design FIRST"), and which lands in the *leaver's*
blast radius months later when nobody can match the account to disable it.

This codebase has already paid for that shape once. `PROPOSE` was deleted because *"the rung above
yielded strictly less than the rung below"* (`write-ladder.ts:27`, in the deletion docblock at
`:24-38`). Re-introducing it as a second axis rather than a fourth rung does not make it a different
mistake.

What this direction **does** need, all of it additive:

| Change | Where | Kind |
| --- | --- | --- |
| `WRITE_BACK_WORK_EMAIL` on `IdentityWriteAction` | `prisma/schema/enums.prisma:1604` + `usecases/identity-write-journal.ts:37` | Additive Postgres enum value — the safe direction. `write-ladder.ts:60-70` records why *removing* one is not. |
| `'writeback'` on the metric's `action` union | `lib/observability/integration-metrics.ts:246-250` | A new label **value**, not a new label key; existing series are unaffected. |
| `writeBackEnabled` on the BambooHR connection config, default off, refused in the client constructor | new, mirroring `entra-id/index.ts:184` + `entra-id/writer.ts:688` | Per-connection opt-in |

Name the action narrowly (`WRITE_BACK_WORK_EMAIL`) rather than generically (`UPDATE_ATTRIBUTE`), so
the enum keeps naming **acts** rather than shapes. A generic member is an invitation to route the
next unrelated write through it, and the journal's value is that every row is a specific act.

### Decision 3 — idempotency is a conditional on the field's live value

Two hazards, and only one of them is ServiceNow's.

**Duplicate records: not a hazard here, given the right address.** The write-back is an UPDATE to an
existing HRIS row; it creates nothing. ServiceNow needed a deterministic correlation id because its
write was a *create* and *"the unique constraint makes the MAPPING idempotent. Only a correlation id
the REMOTE side can be queried by makes the WRITE idempotent"*
(`servicenow/correlation.ts:26-27`). An update addressed by the remote's own row id is already in
that second category. **This is conditional on the address being the HRIS row id and not a field
match** — an update addressed by email would be addressed by the value it is writing, which is
unaddressable by construction. That is why the missing `id` at `hris/index.ts:259` is not a detail.

**Clobbering a human's correction: the real hazard.** The conditional:

> Write `workEmail = <minted>` **only if** the HRIS record's current work-email field is empty, **or**
> already equals `<minted>` exactly (case-normalised).

- **Empty** → the expected pre-hire state. Write.
- **Equal** → already done. No-op; settle `APPLIED` with outcome `WRITEBACK_NOOP`. This is what makes
  a retry, a redeploy or a replayed job safe.
- **Anything else** → a human or another system got there first. **Refuse. Never overwrite.** Outcome
  `REFUSED_HRIS_DIVERGED`.

Two constraints on that comparison, both of which are easy to get wrong:

1. **Compare against a value read in the same pass, immediately before the write.** Not against
   `Employee.workEmail` — that is our mirror and is only as fresh as the last nightly sync — and not
   against a `priorState` captured on an earlier attempt.
2. **The capture must be non-empty even when the finding is an absence.** `beginWrite` rejects an
   empty `priorState` (`identity-write-journal.ts:92-93`), and the reason it gives is exactly this
   case: *"An empty capture cannot be told apart from 'nothing to capture'"*. For a pre-hire the
   field being empty **is** the finding, so the capture is
   `{ workEmailBefore: null, hrisRecordId, observedAt, provider }` — a record that we looked and
   found nothing, not a record that we did not look.

**The limit of this conditional, stated rather than hidden.** Whether the HRIS can enforce it
server-side (an `If-Match`, a version token, a conditional update) is **unknown**. If it cannot —
which is the working assumption — then read-then-write leaves a TOCTOU window one request wide. The
conditional narrows the clobber window; it does not close it. What actually closes it is not
technical: the write fires only for a person whose account the product created in the same pass, in
a window where no human has yet had a reason to type an email into that field. That is a real
mitigation and it is also an assumption about customer behaviour, so it belongs in writing.

### Decision 4 — a rejection is proven; a transport failure is not; and a 200 is neither

The mechanism exists and is inherited verbatim: `DirectoryWriteError` with `definitivelyNotApplied`,
**default false** (`identity-disable-account.ts:324-332`), read by `provenNotApplied` (`:334`). Its
rule: true only for an HTTP 400/401/403/404 with a response body or an LDAP result code; false for
ETIMEDOUT, ECONNRESET, EPIPE, an abort, a 408, any 5xx, and anything unrecognised.

| The HRIS says | Classification | Outcome |
| --- | --- | --- |
| 400 + body — validation, malformed address, field constraint | Proven not applied | `WRITEBACK_FAILED` |
| 401 / 403 — the key cannot write | Proven, **and it is a property of the credential, not the candidate** | `REFUSED_CREDENTIAL`, decided once for the batch |
| Timeout, reset, 5xx, abort | Not proven either way | `WRITEBACK_INDETERMINATE` |
| **200, but the field was read-only** | **Not proven applied** | See below |

The permissions case belongs in the batch **preflight** seam (`DirectoryWriter.preflight?()`,
`identity-disable-account.ts:307`), whose documented contract is precisely this: throw a
`DirectoryWriteError` with `definitivelyNotApplied: true` to refuse the batch once, rather than
spending a journal row, an audit row and an action-required email per candidate on the same sentence
about the same misconfigured connection. One divergence from the leaver: there, `preflight` is
optional. **Here it is mandatory**, because BambooHR's `liveValidation = false`
(`hris/index.ts:220`) means nothing else in the product has ever proven the credential works.

**The genuinely new rail: a read-back.** A customer can make an HRIS field read-only, and an API that
accepts the request and silently drops the field returns 200. The leaver never faces this — its
`disable()` contract is *"Resolves on success, throws on refusal"*
(`identity-disable-account.ts:266`, the docblock on the `disable` declaration at `:267`) and Entra's
204 is taken as truth. Here it cannot be.

> **A 200 is not evidence the value landed.** `WRITEBACK_CONFIRMED` requires the write **and** a
> read-back that observes the value. A 200 without a confirming read-back is `WRITEBACK_INDETERMINATE`,
> not `APPLIED`.

`jml-joiner-design.md` already defines `WRITEBACK_CONFIRMED` as *"The HRIS accepted the work email
and a read-back confirmed it"* (`jml-joiner-design.md:625`); this adopts that definition rather than
coining another.

**And one improvement on that document.** It says `WRITEBACK_INDETERMINATE` is *"Not re-attempted — a
retry against an un-queryable write is how one person gets two contact rows"*
(`jml-joiner-design.md:627`). The reasoning is right and the conclusion is too narrow: the write is
**not** un-queryable, because the read-back exists. So the correct automatic follow-up is a **read,
not a re-write**. The reconciler re-reads the field and, if the value is there, promotes the row
through the existing `settleIndeterminateAsApplied` (`identity-write-journal.ts:527`), whose docblock
limits it to exactly this case — *"Only ever promotes INDETERMINATE (or a stranded PENDING) to
APPLIED, and only when the caller has just OBSERVED the intended end state."* (`:520-522`). A
re-write is still never automatic.

One part of it does **not** transfer unchanged. The settled row's `detail` text is written for the
directory — *"Reconciled: a later read observed the account disabled, so the earlier write landed."*
(`:556`) — a literal that names the leaver's act. A write-back reconciler needs its own sentence, or
the journal grows rows that read as account disables.

### Decision 5 — the credential, and what happens to connections that lack it

**The scope the write needs that the read does not.** For BambooHR there is no scope string; the
answer is a property of the key. Today the product asks for a key it labels **read-only**
(`hris/index.ts:229`), so:

- **Every existing BambooHR connection holds a credential we told the customer to make read-only.**
  None of them can perform this write, and none may be silently expected to.
- The upgrade is not a consent flow — there isn't one. It is a human editing permissions or issuing
  a new key in *their* HRIS and re-entering it here.
- A key's permissions **cannot be checked from the stored value**. The only test is an attempted
  write. Hence the mandatory live preflight in Decision 4.

So `writeBackEnabled` carries more weight here than `writesEnabled` does for Entra. For Entra the
flag records "an administrator consented"; here it records "a human asserts this key can write" — an
assertion the product must then verify itself.

**Existing connections: nothing changes for them, and nothing may.** `writeBackEnabled` is absent or
false, the client refuses, and the pass reports `HRIS_WRITEBACK_UNAVAILABLE` (the name
`jml-joiner-design.md` already gives it) — **refusing before the Entra account is created**, because
the orphan is made by creating first and discovering this second. Roster sync is untouched.

**A cost to name.** A write-capable BambooHR key is strictly more dangerous at rest than a read-only
one, and it lives in `IntegrationConnection.secretEncrypted`. Asking every joiner customer to upgrade
their key is a real security ask, and it should be scoped as narrowly as BambooHR permits — which
this document cannot determine.

### The six leaver pieces, one at a time

#### 1. Write-mode ladder direction — **needs the ladder, declines a new direction**

Settled in Decision 2. One consequence deserves its own statement, because it is where a dry run
could quietly become theatre:

**`DRY_RUN` means something narrower here than it does for the leaver, and the report must not
overclaim.** The leaver's dry run computes a real decision about a real account with no side effects.
But the joiner's own `DRY_RUN` means no Entra account is created — so there is no minted email to
write back, and a write-back dry run is a hypothesis about a hypothesis. What it *can* honestly
report, per pre-hire, is checkable and worth having:

- the HRIS record is addressable (a row id is known);
- its work-email field is currently empty;
- the credential preflight passes.

That is the report to build. A dry run that says "would write `john.smith@acme.com`" is inventing the
left-hand side of its own claim.

#### 2. Source-constant clamp — **needs its own, not the joiner's**

`LEAVER_MAX_MODE` is a source constant so that narrowing it is *"the brake you reach for at 05:05
after a pass did something you did not expect"* (`identity-leaver-pass.ts:905-906`, in the bullet at
`:903-910`). The write-back touches a **different vendor** with a **different** failure mode, and an
incident in the HRIS write must be stoppable without also stopping account creation. So:
`HRIS_WRITEBACK_MAX_MODE`, initial
value `DRY_RUN`, checked at the top of the pass with `isAboveClamp` (`write-ladder.ts:144`) —
**ordinal, never `mode !== CLAMP`**, for the reason spelled out at `identity-leaver-pass.ts:928-936`:
with the clamp anywhere but the top rung, the inequality refuses tenants that are *below* it.

Order of operations matters. `write-ladder.ts:160-174` warns against creating a clamp constant before
a pass reads it — *"a clamp constant with no pass reading it is a fourth thing to keep in sync"*. The
constant lands in the same change as the pass, not ahead of it.

#### 3. Write journal — **needs it, essentially unchanged**

`beginWrite` works as-is once the enum gains its member. The leaver's justification — the journal is
frequently the only surviving copy of what a record was — applies here in a different shape and is
not weaker for it: a row recording that on a given date this BambooHR record's work-email field was
empty and that the product put a specific value into it is the only artefact that tells a value the
product filled apart from one HR filled, during an access review months later. (That is a
description of the row this design would write, not a quotation — no such row exists yet.) The
non-empty-capture rule (`identity-write-journal.ts:92-93`) is handled in Decision 3.

**What it does not need: a revert verb.** The journal's read half already notes that `DirectoryWriter`
declares no `enable()` deliberately. Here the point is sharper — the prior state is *empty*, and
re-applying emptiness to a work-email field is a **destructive act, not a restore**. So the journal
for this direction is read-only evidence. `findRestorableState`
(`identity-write-journal.ts:410`) should not be wired to it.

#### 4. Blast-radius breaker — **needs one; cannot reuse `checkDisableBlastRadius`**

The numerator is fine. The breaker's hard-won invariant is *"AN ACT, NEVER A STANDING STATE … this
number must be able to go DOWN"* (`identity-write-breaker.ts:88` and `:96`, in the docblock at
`:88-109`) — the defect that latched a tenant's leaver path shut forever. A write-back numerator
satisfies it naturally: once written, the
field is non-empty and the record drops out of the candidate set.

**The denominator is the problem.** `BreakerInput.population` must come from a *confirmed-complete*
enumeration, measured the same way as the numerator (`identity-write-breaker.ts:114-127`), and a
population of 0 with a non-zero batch is refused outright because *"an unknown denominator is not the
same as a safe one"* (`:154-156`). But the HRIS roster read is routinely incomplete by design —
`complete` is a flag (`hris/index.ts:265`), Workday pages across runs (`workday/roster.ts:35`), and
`hris-sync` has a `PARTIAL` status for it (`usecases/hris-sync.ts:69`).

> **Settled:** the write-back's denominator is the roster count **only from a pass whose `complete` is
> true.** A `PARTIAL` roster read produces **zero** write-backs that run, reported as
> `REFUSED_UNMEASURED`.

That is stricter than the leaver, deliberately. A wrongly-disabled account is restorable from the
journal; a wrong email written into a customer's system of record is corrected by hand, in their
system, by someone who does not know we did it.

Caps: a joiner wave of more than a handful in one pass is a bad feed, not a hiring spree.
`MAX_WRITE_BACKS_PER_RUN = 10` is a **starting value and a guess**, not a derived number — say so at
the constant, the way `MAX_DISABLES_PER_RUN = 50` (`identity-write-breaker.ts:69`) documents its own
reasoning. The share rule and its small-tenant floor (`:72`, `:82`) can be carried over unchanged if
the denominator rule above holds.

#### 5. Hash-chained audit event — **needs it, with one unresolved field**

Mirror `auditDirectoryWrite` (`identity-disable-account.ts:1124`) and inherit all four of its
hard-won details rather than rediscovering them:

- `appendAuditEntry`, **not** `logEvent` — a scheduled pass runs as `SYSTEM_PRINCIPAL`, which is not a
  real `User.id`, and `AuditLog.userId` is FK-constrained; `logEvent` would throw, be swallowed, and
  record nothing while looking like it worked (`:1109-1117`).
- `actorType: 'SYSTEM'`, not `'JOB'` — this column is hashed into the chain and streamed to customer
  SIEMs, and a fourth value is a parsing change for a consumer we cannot see (`:1154-1159`).
- The whole call inside one `try` — an audit sink being down must not un-happen a write that already
  landed (`:1119`).
- Free text scrubbed on the way in: `sanitizePlainText` plus `redactDirectoryIdentifiers`
  (`lib/security/redact-directory-identifiers.ts:34`).

**Unresolved, and not invented here.** The leaver's row is `entity: 'IdentityAccountLink'` with
`entityId: candidate.linkId` (`identity-disable-account.ts:1160-1161`). A pre-hire has **no link** —
that is the whole finding of [the correspondence problem](#the-subject-of-this-write-does-not-exist-in-our-data-model)
— and pointing it at `Employee.id` is also wrong, because the pre-hire is not an `Employee` yet
(`hris-sync.ts:241`). The safe interim is to key the row to the `IntegrationConnection` and carry the
journal id in `detailsJson`, which is already where `journalId` lives
(`identity-disable-account.ts:1173`). This should be revisited once the joiner settles what a
pre-hire is.

Second, smaller open point: the leaver uses `category: 'access'` / `operation: 'permission_changed'`
(`identity-disable-account.ts:1165`, `:1167`). Writing an email into an HR record is arguably a data
change, not an access change. The recommendation is to **keep `category: 'access'`**, because the
value being written is the
identifier that grants access everywhere else in this product — it is the link key itself
(`enums.prisma:1564-1567`). The counter-argument is real and is recorded so the next reader does not
have to reconstruct it.

#### 6. Outcome enum, legible on an admin page — **needs it**

`DisableOutcome` (`identity-disable-account.ts:61`) is the model, and legibility actually happens in
`OUTCOME_VARIANT` (`LeaverPassesClient.tsx:156`), where `DRY_RUN` is `info` rather than `success`
because *"a green tick against a decision that never happened is the single most misleading thing
this page could render"* (`:152-154`, in the docblock at `:150-155`).

| Outcome | Meaning | Tone |
| --- | --- | --- |
| `WRITEBACK_CONFIRMED` | Written **and** read back. The only state in which the two systems are known to agree. | success |
| `WRITEBACK_NOOP` | The field already held exactly this value. The safe re-run. | neutral |
| `WRITEBACK_FAILED` | The HRIS **proved** it did not take the write. | warning |
| `WRITEBACK_INDETERMINATE` | No proof either way, including a 200 with no confirming read-back. | error |
| `DRY_RUN` | Addressable, field empty, credential preflight passed. Nothing written. | info |
| `REFUSED_MODE` | Rung below `AUTOMATIC`, or above `HRIS_WRITEBACK_MAX_MODE`. | warning |
| `REFUSED_NO_HANDLE` | No addressable HRIS row id. **Expected to be the most common refusal on BambooHR today** (`hris/index.ts:259` vs `:267`). | warning |
| `REFUSED_HRIS_DIVERGED` | The field holds a different value; a human got there first. | warning |
| `REFUSED_CREDENTIAL` | Preflight proved the key cannot write. Batch-level, once. | warning |
| `REFUSED_UNMEASURED` | The roster read was `PARTIAL`, so the breaker had no denominator. | warning |

And carry the leaver page's own lesson: a bare code is not legible. That page has a **basis** column
because `outcome` alone does not support the decision an operator is being asked to make, and because
a reader counting which of forty identical refusals are operational otherwise has to read forty
labels (`LeaverPassesClient.tsx:597-603`). `REFUSED_NO_HANDLE` needs the same treatment — *why* there
is no handle (field absent from the report, `employeeNumber` only, manual employee) is the fact a
reader scans for.

### What this direction does **not** need, and why

| Leaver rail | Verdict |
| --- | --- |
| `selfAccountIds` / self-lockout refusal (`identity-disable-account.ts:263`) | **Not needed.** That rail exists because disabling the account a connection authenticates AS stops the product. A BambooHR API key is not a worker row; writing an email into a worker record cannot revoke the key — even if the key's owner is themselves in the roster. |
| `findRestorableState` / a revert verb (`identity-write-journal.ts:410`) | **Not needed, and must not be added.** The inverse of this write is blanking a work-email field. See piece 3. |
| A separate seven-day dwell | **Not needed.** It rides the joiner's, per Decision 2. |
| `DirectoryWriter` as the seam (`identity-disable-account.ts:235`) | **Not reused.** That interface is `readState` / `disable` / `preflight` over a *directory* account. The write-back needs `readField` / `writeField` / `preflight` over an HRIS record. Same shape, different contract; forcing it into `DirectoryWriter` would put a non-directory verb into `WRITABLE_IDENTITY_PROVIDERS` and into the leaver's writer factory. |

### Phasing

**Phase 0 — make the handle exist. No writes. SHIPPED 2026-09-17 (#2549).** BambooHR's row `id` is
requested explicitly, `r.id` is out of `externalId`'s fallback chain, and the value persists to
`Employee.hrisRecordId`. Nothing reads that column yet — it is provenance until Phase 2 gives it a
consumer.

The line references this phase used to carry are deliberately gone. They pointed at
`hris/index.ts:259` and `:267`, which the change itself moved; a citation that survives the work it
describes is a citation nobody re-derived.

**Phase 1 — credential and vocabulary. No writes.** `writeBackEnabled` on the connection; the live
preflight; the enum member, TS union and metric label; the DRY_RUN report of Decision 1's narrow
form; `HRIS_WRITEBACK_MAX_MODE` landing with the pass that reads it.

**Phase 2 — the write.** Conditional write with read-back, journal capture-before-write, hash-chained
audit, breaker with the complete-roster denominator, outcomes rendered on the passes page.

Phase 2 must not ship before the joiner settles what a pre-hire is. It has no subject until then.

### Open questions — unresolved, and deliberately not resolved by assertion

1. **Does BambooHR expose an employee-update API at the same gateway base, with the same Basic auth?**
   Not verifiable from this repo; there is no call site to show. Decision 1 rests entirely on it.
2. **Is `r.id` ever populated today — i.e. does BambooHR return it unrequested?** STILL OPEN, and
   narrower than it was. Phase 0 now requests `id` explicitly and routes it to `hrisRecordId`, so the
   question no longer governs whether `externalId` is safe; it governs only how to describe what
   earlier syncs wrote into that column. There is still no BambooHR tenant to check against.

   **What an OrangeHRM instance did and did not settle.** #2548 built a connector against an HRIS
   whose HR side we control, and it was pointed at a live `orangehrm/orangehrm:5.9` on 2026-09-17.
   That answers nothing about BambooHR's API — a different vendor's payload is not evidence about
   this one, and it would be the same assertion-in-place-of-measurement this section exists to refuse.

   What it *does* establish is that the shape this design assumed is not universal. On OrangeHRM the
   list response carries the write-back handle (`empNumber`) and **does not carry the work email at
   all**, at any `model` — proved by A/B, since the same employee's `/pim/employee/{id}/contact-details`
   returns an address the list row omits. So "handle present, identity field absent" is a real shape,
   and a design that assumes one roster read yields both is assuming something at least one vendor
   does not do. See #2587.
3. **Can the write be made conditional server-side?** If there is an `If-Match` or version token, the
   TOCTOU window in Decision 3 closes. If not, it only narrows.
4. **Does a BambooHR 200 mean the field landed, when the customer has restricted that field?** The
   read-back exists because the assumption is no. If the API reports per-field rejection, the
   read-back can be dropped and the design simplifies.
5. **What is the right audit `entity` for a person who is not yet an `Employee` and has no
   `IdentityAccountLink`?** Interim answer in piece 5; a real answer waits on the joiner.
6. **Is Workday's `externalId` (`workday/roster.ts:118`) ever a Worker WID?** It is
   `row.employeeId || row.workerId || workEmail` over a customer-authored report template, so the
   answer is per-tenant. This may be the deeper reason Workday is second.
7. **Does the operator's flow tolerate the pre-hire being invisible until write-back succeeds?** This
   design assumes the pre-hire is represented outside `Employee`. If the answer is instead "relax
   `Employee.workEmail` to nullable", that is a migration on a NOT NULL column carrying a unique
   constraint (`prisma/schema/personnel.prisma:235`, `:257`) and a substantially larger project than
   this one.

### What would falsify this design

- **BambooHR has no employee-update API** → Decision 1 inverts to Workday-first; Decisions 2–5 and
  the six pieces are unaffected.
- **The operator says pre-hires do carry a placeholder email in the HRIS** → there is no write-back,
  only a correction. The conditional in Decision 3 changes from "empty or equal" to "equal or
  placeholder", and the three no-email drops stop mattering.
- **A customer's HRIS makes the work-email field read-only as a matter of course** → the capability
  is not viable for that tenant at any rung, and `HRIS_WRITEBACK_UNAVAILABLE` must be a supported
  steady state rather than an error, with the joiner refusing to create rather than orphaning.
- **A rung is added above `AUTOMATIC`** → `HRIS_WRITEBACK_MAX_MODE` sorts below it with no diff to
  any file here, exactly as `write-ladder.ts:160-174` warns for the leaver.
