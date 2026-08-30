# JML joiner — directory account provisioning

> **Status: living design** — the joiner is a ladder setting with no runtime behind it; this document specifies the DRY_RUN rung that must ship before any account is ever created.

Companion to the shipped leaver rails. Where a shape already exists on the leaver side, this
document names it and mirrors it; where the joiner must diverge, it says so and gives the reason.

---

## Current state (true today)

### What exists

The joiner is a **stored enum and four consumers**. There is no job, no dispatch, no schedule,
no usecase, no writer, no refusal vocabulary.

| Where | What | Cite |
| --- | --- | --- |
| Schema | `identityJoinerMode IdentityWriteMode @default(DISABLED)` and `identityJoinerDryRunSince DateTime?` on `TenantSecuritySettings` | `prisma/schema/auth.prisma:1268`, `:1275` |
| Ladder usecase | `IdentityDirection = 'leaver' \| 'joiner'`; `FIELDS.joiner` maps to those two columns; `getIdentityWritePolicy` returns a joiner branch defaulting to `DISABLED` | `src/app-layer/usecases/identity-write-policy.ts:29`, `:50`, `:76-78` |
| Admin route | `PUT` body accepts `direction: z.enum(['leaver','joiner'])`; `GET` reports `honoured.joiner` | `.../admin/identity-write-policy/route.ts:30`, `:74` |
| Ladder UI | renders both directions; shows a warning notice when `!honoured.implemented` | `WriteLadderClient.tsx:56`, `:164-168`, `:254` |
| Metric label | `recordIdentityWriteOutcome` already types `action: 'disable' \| 'enable' \| 'create'`, description already reads "joiner/leaver path" | `src/lib/observability/integration-metrics.ts:235`, `:240` |
| Copy | `writeLadder.notImplemented` | `messages/en.json:5154` |

That is six files, not four — the schema columns and the i18n string are also part of the surface.

### The rung is already settable, and `implemented: false` is discarded

**The premise that the joiner "cannot be set to DRY_RUN today" is false, and the reason it is
false is itself a defect worth fixing in Phase 1.**

- `setIdentityWriteMode` has no joiner-specific gate. It calls `describeRefusal` and writes
  `FIELDS[direction]` (`identity-write-policy.ts:144-147`, `:148-160`).
- `describeRefusal` returns `null` for `DISABLED → DRY_RUN`: same-mode at `:89`, narrowing at
  `:99`, multi-rung at `:102`, dwell at `:110`. Nothing else refuses
  (`identity-write-policy.ts:86-121`).
- The UI's widen button is `disabled={Boolean(state.blockedReason) || saving}`
  (`WriteLadderClient.tsx:192`). It never reads `honoured.implemented`, and never reads
  `aboveClamp` either (`:139`).

So the route computes `honoured.joiner.implemented: false` correctly at `route.ts:74` and the only
consumer renders a banner beside a live button. **A tenant can climb the joiner ladder to
`AUTOMATIC` today, one rung a week, and nothing reads the value.** That is this subsystem's
signature failure — a value computed correctly then discarded downstream — sitting in the joiner's
own four files.

Two consequences for Phase 1:

1. `identityJoinerMode` / `identityJoinerDryRunSince` may already hold non-`DISABLED` values with
   a `dryRunSince` clock that has long since satisfied `DRY_RUN_MIN_DAYS = 7`
   (`identity-write-policy.ts:40`). **Read what is stored before shipping** and decide whether
   pre-existing joiner ladder state is honoured or reset.
2. This is why `MODE_ABOVE_CLAMP` recording a row is load-bearing rather than stylistic.

### Why the joiner is not being built yet

**The leaver has never completed an unattended scheduled run.** The clamp's own refusal text says
so: *"Wiring the pass and granting it unattended authority are separate decisions, and no tenant
has yet watched a single pass"* (`identity-leaver-pass.ts:422-424`).

The seven-day observation argument does not transfer, for a reason specific to the joiner:

- The leaver's DRY_RUN is a **real evaluation**. `resolveDirectoryWriter` returns a snapshot
  reader over stored `ConnectedIdentityAccount` rows (`integrations/identity-writer-factory.ts:364-371`), and
  every rail above it — protection, self-lockout, already-disabled, write-target — decides against
  observed state. The artefact is comparable against what IT actually did.
- The joiner has **no DRY_RUN rung at all**, and building one is not free: there is nothing to
  read. A creation has no prior account, so there is no snapshot to evaluate against. The joiner's
  dry run is necessarily a *planner*, and a planner can only certify what it can check without a
  socket — which, as [What a dry run cannot know](#what-a-dry-run-cannot-know) sets out, excludes
  two of the six operator decisions.

So the honest sequencing is: **leaver observed in the field first, joiner DRY_RUN rung second,
creation third.** Shipping a joiner whose dry run silently promises what the live path would refuse
would spend the seven days certifying a fidelity the rung does not have.

---

## Roadmap (future direction)

### The six settled decisions

Settled 2026-08-20. Restated as constraints. **Not open for re-litigation** — where a decision was
taken against recommendation, this design carries its stated cost rather than reversing it.

**1 — Identifier.** `first.last@domain`; on collision append a deterministic token derived from the
Workday worker id (`john.smith-4f2a`). **Never a counter** — a lost-response retry re-counts and
yields `john.smith3` for the same person.

*Carried cost.* The worker id is not stable by construction: `externalId = row.employeeId ||
row.workerId || workEmail` (`workday/roster.ts:96`) is a fallback chain, and MANUAL employees have
no external id at all. And `fullName` is overwritten on every HRIS run
(`usecases/hris-sync.ts:136`). Determinism holds *given the same inputs*; nothing guarantees the
inputs are the same. See [Idempotency](#idempotency) — this is why the anchor must not be the
derived name.

*Carried cost, second half: there is no name to split.* `Employee` has no given/family fields — a
single `fullName String` (`personnel.prisma:233`) — so `first.last` can only be produced by
**tokenising a display string**. And that string is itself a fallback chain: Workday writes
`fullName: (row.preferredName || row.legalName || workEmail).trim()` (`workday/roster.ts:99`), so
the deriver can be handed `john.smith@acme.com` as a "name" — or a mononym, or a name carrying a
suffix, or a legal name that is not the one the person is known by. Two binding consequences:

- **A new refusal, `REFUSED_NAME_UNDERIVABLE`, beside `REFUSED_IDENTIFIER_UNSTABLE`** — for a
  display string that does not yield exactly two usable tokens, or that is the work email itself.
  Refuse; never guess a split. A wrong split is a wrong human-readable identity that a person then
  carries for years, and decision 1's collision token cannot repair it because the token only
  disambiguates a name that was already right.
- **Record `nameSource: PREFERRED | LEGAL | EMAIL_FALLBACK`** on the decision row. `EMAIL_FALLBACK`
  is derivable at pass time (`fullName` normalises equal to `workEmail`), which is the arm that must
  refuse. `PREFERRED` vs `LEGAL` is **not** recoverable from the stored row — the roster flattens
  both into one column — so if that distinction is wanted in the seven-day artefact, the normaliser
  has to carry it forward at sync time. Say which of the two you are shipping; do not record a field
  the pass cannot actually populate.

**2 — Credential.** Entra Temporary Access Pass; AD gets a random, never-persisted, must-change
password. **REQUIRED REFUSAL: if TAP policy is disabled, refuse.** Never silently fall back to
setting a password.

*Carried cost.* Nothing in `src/` reads TAP today (verified: zero hits). Reading the
authentication-methods policy needs `Policy.Read.All`, which is **not** among the three permissions
the connector asks for — `User.Read.All`, `Directory.Read.All`, `AuditLog.Read.All`
(`entra-id/index.ts:165`). This is a **third per-tenant operator gate**, and the connector's own
copy states the mechanism: *"client-credentials tokens carry exactly what an administrator has
already consented, so an existing connection keeps failing every disable until that consent is
granted."*

**3 — Entitlements.** Explicit per-tenant department→security-group map; licences via Entra
**group-based licensing**. Never call Graph `assignLicense` directly.

**4 — When to fire.** **On the start date** — taken against a three-days-before recommendation.

*Carried cost, and it shapes the whole design.* Every failure is a **day-one failure**. So: fire
early, retry inside the window, surface immediately. The upside is real — it kills the TAP-expiry
problem, so decisions 2 and 4 cohere. But see
[Trigger, schedule and the day-one constraint](#trigger-schedule-and-the-day-one-constraint) for
the timezone question this leaves open, which is the part of decision 4 that cannot be honoured
without one more answer.

**5 — Unmapped department.** Fall back to a **configured default group** — taken against
refuse-to-create.

*Cost stated and accepted:* a typo'd or new department is indistinguishable from a mapped one. The
three mitigations that preserve the choice are binding, not optional:
surface every fallback use **by name** — *both* names, the unmapped department string verbatim
**and** the group it fell back to (`groupId` + `groupName`); **refuse if no default is configured**
(`NO_DEFAULT_GROUP`); keep the default lowest-privilege. A row that records only the
department says a fallback happened but not *to what*, which is the mitigation stated and not
implemented.

**6 — Per-run cap: 5 creations.** An anomaly detector, not a rate limit. With group-based licensing
this caps licence spend too.

*Carried cost.* Counted **per UTC day across runs**, not per invocation — decision 4's intra-day
retries would otherwise permit 5× the cap while every log line looked deliberate. And note the
numeric collision: `SHARE_RULE_FLOOR = 5` (`identity-write-breaker.ts:82`), which makes the
leaver's share rule structurally dead at this cap. See [The rails](#the-rails).

**Inherited.** Provisioning gates behind `admin.tenant_lifecycle` (OWNER-only) — provisioning is
more privileged than disabling. No new permission key; this is the key already on the ladder route
(`route.ts:34`, `:79`).

---

### Phase 1 — the DRY_RUN rung

**Deliverable: a joiner pass that decides everything and writes nothing to any directory, records
a durable artefact per run, and takes a reservation.**

`JOINER_MAX_MODE = 'DRY_RUN' as const` in `usecases/identity-joiner-pass.ts` — a **source
constant, not config**, mirroring `LEAVER_MAX_MODE` (`identity-leaver-pass.ts:78`) and enforced at
gate 1 as the leaver does at `:406`. Raising it must be a diff somebody reviews.

The route's `honoured` block flips to `joiner: { maxMode: JOINER_MAX_MODE, implemented: true }`,
**importing the constant** rather than re-typing the literal. The route already imports
`LEAVER_MAX_MODE` (`route.ts:27`) and hard-codes the joiner's (`:74`); that literal-vs-import
difference is exactly what lets the route and the pass drift.

**Also in Phase 1, because the rung is meaningless without them:**

- Fix the discarded `honoured.implemented` — the widen button must consult it
  (`WriteLadderClient.tsx:192`).
- Triage pre-existing stored joiner ladder state (see Current state).
- Add `identity-joiner-dispatch` **and** `identity-leaver-dispatch` to the dispatcher guard
  (see [Trigger, schedule…](#trigger-schedule-and-the-day-one-constraint)).
- Build the unsettled-reservation reader **with a caller** (see [Idempotency](#idempotency)).
- **The identifier derivation is ONE exported pure function with NO `mode` parameter**, called by
  the dry-run path and the live path alike, with a test asserting both call sites reach it. This is
  the same reasoning the rung already applies to *importing* `JOINER_MAX_MODE` rather than re-typing
  the literal: a second spelling is a second answer. The repo's own precedent is
  `identity-disable-account.ts:521` — *"`target` is passed in rather than recomputed. `resolveWriteTarget`
  is pure and cheap, so a second call would be correct — and it would still be a second evaluation of
  a safety rail, which is the thing this subsystem refuses to have anywhere else."* A `mode`
  argument is exactly how the dry run's identity and the live path's identity begin to disagree, and
  the whole point of the rung is that they cannot.

#### Why the reservation sits ABOVE the dry-run branch

This is the design's most deliberate divergence from the leaver, and it exists because of a defect
in the leaver's own placement.

`beginWrite` has exactly one caller — `identity-disable-account.ts:649` — and it sits **below** the
DRY_RUN early return at `:635-646`. `listUnsettledWrites` has **no production caller** (its only
caller repo-wide is `tests/unit/identity-write-journal.test.ts:178`), and
`recordIdentityWritesUnsettled` is imported at `identity-disable-account.ts:44` and **never
called** (zero call sites in the file). So the capture-before-write rail and its operator sweep are
both invisible for the entire clamped life of the leaver, and
`notifications/leaver.ts:484` ships copy telling an operator that `listUnsettledWrites` "is how the
row is found" — pointing at a surface with no caller and no route.

The joiner must not repeat this. **The reservation is taken above the dry-run branch, in state
`PLANNED`, and its reader has a caller from day one.**

The two are not in conflict once you see what each row *means*. A journal row is a capture of
destroyed state, and the leaver is right that *"a DRY_RUN did not replace anything, so a capture of
what it 'replaced' would be a lie a restore could read"* (`identity-disable-account.ts:636-638`). A
reservation is a claim on an **identity**, and a dry run genuinely does choose one. Recording it is
true.

**And this is the rung's whole justification:** it is what makes identifier drift visible. If the
derived identity changes between two dry runs for the same person, the second refuses
`IDENTITY_DRIFTED` — seven days before it could have created two accounts.

---

### Phase 2 — creation

Not specified in detail here; it is gated on Phase 1's artefact and on the open questions below.
What Phase 2 must decide, flagged now because each is a real cost:

**The writer seam — settled: a separate `DirectoryProvisioner`, and do NOT widen `DirectoryWriter`.**
`DirectoryWriter` declares only `provider`, `selfAccountIds`, `readState` and `disable`
(`identity-disable-account.ts:183-216`), and its docblock says it is *"deliberately tiny"*
(`:180-181`). Nothing in the repo can create a user, mint a credential, or assign a group. Add a
separate `DirectoryProvisioner`, resolved by the same factory, sharing `WriterRefusal` and the
connection-resolution refusals but **not** the write surface.

The decisive reason is not the charter — it is that **the snapshot arm cannot be shared, even in
DRY_RUN.** `createSnapshotWriter.readState` throws `DirectoryWriteError` with
`definitivelyNotApplied: true` when the account is not in the last enumeration
(`integrations/identity-writer-factory.ts:171-181`: *"the last complete sync did not see this
account, so there is nothing to report on"*). For a leaver that is right — absence is an anomaly,
and the live Entra writer resolves the same case as an account that cannot be disabled because it is
not there. **For a joiner, absence is the SUCCESS case.** It is precisely what "this identifier is
free" looks like. A joiner reaching through `DirectoryWriter.readState` would raise a provider error
for every legitimate candidate, and the seven-day artefact would be a page of throws where it should
be a page of plans. The collision read therefore needs its own shape — which is the same conclusion
the charter argument reaches, by a route that does not depend on taste.

Widening would also force `createSnapshotWriter` to grow three more loud-throwing stubs beside its
existing one (`integrations/identity-writer-factory.ts:218-225`) — three more surfaces whose only
job is to fail correctly.

**And whichever seam is built, "resolveDirectoryWriter reused verbatim" is not available** — it
returns a snapshot *reader* at DRY_RUN (`:364-371`), and that return sits **above** `mergeConnection` (`:375`), so a
dry run never merges connection config at all.

**Creation is three writes, not one.** A disable is one PATCH. A create is user + credential +
group, so `PARTIAL_NO_CREDENTIAL` and `PARTIAL_NO_GROUP` are real terminal states with no leaver
analogue. Sequence so the recoverable half is last: create the account blocked, mint the TAP,
assign the group, then enable. A failure at any step leaves an account nobody can sign into
(recoverable) rather than one anyone can sign into with no entitlements (not observable).

**The consent coupling, which must be decided rather than inherited.** `WRITE_ROLES` is
`['User.EnableDisableAccount.All', 'User.ReadWrite.All', 'Directory.ReadWrite.All']`
(`entra-id/writer.ts:215-219`). Creating a user requires one of the latter two — **both members of
that list**. So any consent sufficient to *create* is, by this repo's own list, sufficient to
*disable*, and `hasWriteRole` stops objecting. The least-privilege argument at `writer.ts:206-210`
does not survive the joiner, and the only remaining separator is the single per-connection
`writesEnabled` boolean (`writer.ts:659-684`), which can no longer say *which* direction was asked
for. Either add a per-direction writes flag, or state plainly that enabling joiner writes grants
standing disable authority at the credential layer. **Silence here decides it by omission.**

---

### The rails

#### The rule: every refusal records a row

**Every terminal state writes one `IntegrationExecution` row — including both ladder refusals.**
This is a deliberate divergence from the leaver, which returns before `safeRecordRefusal` for
`MODE_DISABLED` (`identity-leaver-pass.ts:402-404`) and `MODE_ABOVE_CLAMP` (`:406-426`), reasoned
at `:219-222`.

That asymmetry is defensible over a seven-day watch and is **not** defensible where the failure
means a person cannot start work. Under the leaver's rule, a tenant accidentally left at `DISABLED`
produces an empty page indistinguishable from a dead worker, on the one morning someone is sitting
at a desk without an account.

**The leaver's objection is answered, not overridden.** Candidate assembly is three DB reads and
opens no socket, so it runs *before* the ladder gate — which means a `MODE_DISABLED` row carries
`starters: 3` and is the most actionable row on the page, not a vacuous observation row. Exactly
**one** terminal row per pass, chosen by informativeness:

- `starters == 0` → `NO_STARTERS`, whatever the mode.
- `starters > 0` and mode `DISABLED` or above the clamp → that ladder refusal, **carrying the
  count**.

This also settles the precedence question that assemble-then-ladder otherwise leaves unspecified.

Note the leaver's cheapest-first rationale is specifically about **directory traffic** — *"a tenant
in DISABLED mode must not generate directory traffic to discover that it is in DISABLED mode"*
(`identity-disable-account.ts:290-293`). Joiner assembly generates none, so the ordering argument
does not carry across.

#### Pass-level refusals

| Code | Meaning |
| --- | --- |
| `MODE_DISABLED` | Joiner writes off for this tenant. **Records a row when candidates exist** (diverges from leaver). |
| `MODE_ABOVE_CLAMP` | Stored above `JOINER_MAX_MODE`. Records a row for the same reason. Load-bearing on ship day, since tenants may already sit above it. |
| `NO_STARTERS` | Nobody has a `startDate` in the UTC window. The boring daily row that proves the pass ran. Mirrors `NO_TERMINATED_WORKERS` (`identity-leaver-pass.ts:441`). |
| `ROSTER_NOT_FRESH` | The 04:00 `hris-sync` has not completed for this UTC day, so `startDate` / `department` are yesterday's. |
| `DIRECTORY_NOT_FRESH` | The most recent 03:00 `identity-sync` for this connection did not return **`PASSED`**, so the collision denominator is stale *or truncated*. Defined on the status, **not** on "ran today": a `PARTIAL` sync did complete, and completion is not the property this rail needs — see [Absence fails open](#absence-fails-open). **Separate code** because the operator fixes a different connection. |
| `LINK_COVERAGE_TOO_LOW` | Too few ACTIVE employees hold a fresh, uncontradicted link, so "has no account" is not yet evidence of anything. See [the absence-fails-open note](#absence-fails-open) below. |
| `TARGET_TOPOLOGY_UNOBSERVED` | No fresh on-prem observation exists across this connection's accounts, so the create has no substitute for the leaver's write-target rail. See [there is no write-target rail for a create](#there-is-no-write-target-rail-for-a-create). |
| `NO_DEPARTMENT_MAP` | No department→group map configured at all. |
| `NO_DEFAULT_GROUP` | Decision 5's required refusal: a fallback is only safe when the fallback has a name. |
| `CREDENTIAL_POLICY_DISABLED` | Decision 2's **required refusal**. TAP policy is off. There is no password arm in the interface to fall back to. |
| `CREDENTIAL_POLICY_UNCONSENTED` | The policy probe returned 403 — the connection lacks `Policy.Read.All` (`entra-id/index.ts:165`). **Distinct from unobserved**, naming the missing permission. |
| `CREDENTIAL_POLICY_UNOBSERVED` | No probe has run for this connection yet. Clears itself overnight. |
| `BATCH_OVER_CAP` | More than 5 creations proposed (decision 6). Whole batch refused, never trimmed. |
| `WRITER_${WriterRefusal}` | The factory's union reused verbatim — `UNSUPPORTED_PROVIDER \| NO_CONNECTION \| AMBIGUOUS_CONNECTION \| SECRETS_UNREADABLE \| WRITES_NOT_ENABLED \| WRITER_REFUSED` (`integrations/identity-writer-factory.ts:71-107`), prefixed as the leaver does at `:340`. |

**Note which of those six are reachable at DRY_RUN.** `NO_CONNECTION` (`:319-325`) and
`AMBIGUOUS_CONNECTION` (`:326-338`) sit **above** the DRY_RUN return; `SECRETS_UNREADABLE`
(`:377-382`) and `WRITES_NOT_ENABLED` (`:403-405`) sit **below** it and cannot fire in the only
rung that exists. Do not present all six as uniformly available.

**One conditional on that, from the collision-probe decision.** If the joiner takes the pass-time
probe (see [What a dry run cannot know](#what-a-dry-run-cannot-know)), its DRY_RUN arm has to merge
connection config in order to hold a token — so `SECRETS_UNREADABLE` **becomes** reachable for the
joiner exactly where it is not for the leaver, and the sentence above stops being true of both
directions. `WRITES_NOT_ENABLED` stays unreachable either way, because no writer is ever
constructed.

The three-way split on the credential probe copies a fix the write-target rail already made:
`NEVER_OBSERVED` was separated from `PROVIDER_CANNOT_OBSERVE` precisely because merging them
produced advice that could not be taken (`identity-write-target.ts:268-297`). Without the
`UNCONSENTED` arm, every existing Entra connection sits at "wait for tonight's sync, it clears
itself" **forever**.

#### Per-candidate outcomes

| Code | Meaning |
| --- | --- |
| `PLANNED` | DRY_RUN decided everything, wrote nothing to the directory, and took a `PLANNED` reservation. Mirrors `DisableOutcome: 'DRY_RUN'` (`identity-disable-account.ts:645`) with the reservation difference that is the point of the rung. |
| `CREATED` | The directory confirmed the create. |
| `ADOPTED_EXISTING` | A conflict resolved to an account carrying our correlation id. **Never folded into `CREATED`** — see below. |
| `ALREADY_PROVISIONED` | The worker holds a fresh, uncontradicted link for this provider. Idempotency, not a failure. **Checked last, not first.** |
| `ACCOUNT_OBSERVED` | An account matching the intended identity exists in the roster but is not linked to this worker. Distinct from `ALREADY_PROVISIONED` because the operator action differs — fix the link, do not create. **A statement about one namespace only** — see [the collision check](#the-collision-check-reads-one-namespace-and-it-is-not-the-one-a-create-collides-in). |
| `NO_CONFLICT_OBSERVED` | The negative of the row above: the last complete enumeration held no account under the derived address. **Never rendered as "available"**, and never abbreviated to it in copy — one is a statement about what was looked at, the other a promise about the directory. Carries `namespacesChecked`. |
| `RESERVED_ELSEWHERE` | Another reservation already owns this identity. |
| `IDENTITY_DRIFTED` | The reservation's stored derivation inputs no longer match the Employee row. Refuses rather than re-deriving, because re-deriving is how one person gets two accounts. |
| `REFUSED_NO_START_DATE` | `Employee.startDate` is null (`personnel.prisma:240`). **A live path, not defensive** — `deriveEmploymentStatus` returns `ONBOARDING` from the status *string* alone at `employment-status.ts:90`, with no date, so an ONBOARDING employee with a null start date is reachable in real data. |
| `START_DATE_UNPARSEABLE` | The stored value is an Invalid Date. Exists because the persisted column bypasses the guard: `startDate` is a bare `new Date(row.hireDate)` (`workday/roster.ts:105`, `hris/index.ts:243`) while the status rule routes the same string through `parseVendorDate`, which returns null on garbage *specifically so it falls through* (`employment-status.ts:51-55`). |
| `REFUSED_IDENTIFIER_UNSTABLE` | The collision token has no stable source — a MANUAL employee (`externalId` null by design) or a `workEmail`-derived `externalId` (`workday/roster.ts:96`) that moves on a domain change. |
| `REFUSED_NAME_UNDERIVABLE` | `first.last` cannot be produced from the only name the schema holds. `Employee` has a single `fullName String` (`personnel.prisma:233`) and Workday fills it from `preferredName \|\| legalName \|\| workEmail` (`workday/roster.ts:99`), so the deriver can be handed an email address, a mononym, or a string that yields no clean two-token split. **Refuse; never guess.** Carries `nameSource: PREFERRED \| LEGAL \| EMAIL_FALLBACK` — see decision 1's carried cost for which arms are recoverable at pass time. |
| `IDENTIFIER_COLLIDES_PROTECTED` | `first.last` resolves to an `isProtected` account (`personnel.prisma:88`) or a writer `selfAccountId` (`identity-disable-account.ts:192-211`). **Never route around a protection rail with the collision token.** Decision 1's token is for ordinary collisions. |
| `REFUSED_TAP_UNAVAILABLE` | TAP could not be minted for this user. Never a password fallback. |
| `FAILED` | The provider **proved** nothing was created. A positive claim, only on proof — mirroring `DirectoryWriteError.definitivelyNotApplied`, whose default is `false` so a writer must opt *in* to claiming the directory is unchanged (`identity-disable-account.ts:227-231`). |
| `INDETERMINATE` | The call did not report back. The reservation stays unsettled and enters the must-look queue. **Not re-attempted** — for a create, retrying is the dangerous action. |

**`ADOPTED_EXISTING` is never folded into `CREATED`.** The repo already made this call and wrote
down why: `recordOutboundWrite` types `action: 'created' | 'adopted' | 'updated' | 'conflict' |
'failed'` (`integration-metrics.ts:143-149`), and its docblock says a rate that exceeded the create
rate would mean the correlation lookup had stopped matching and duplicates were being made —
*"Collapsing it into `created` would hide exactly that"* (`:137`).

**`ALREADY_PROVISIONED` is checked LAST**, inverting the leaver's ordering. `ALREADY_DISABLED`
precedes the write-target rail (`identity-disable-account.ts:612-618` before `:631`), and for a
disable that is right. For a create in DRY_RUN, the only evidence is a `ConnectedIdentityAccount`
table that by construction cannot know about anything created since 03:00 — so checking it first
turns an unobservable state into a clean skip.

#### The collision check reads one namespace, and it is not the one a create collides in

A roster match is **necessary and nowhere near sufficient.** This is the widest gap between what the
dry run can say and what a create would actually meet, and it is not closed by any amount of care in
the derivation.

**Entra.** Create-time uniqueness is enforced on `userPrincipalName` — and, separately, on
`mailNickname` and across `proxyAddresses`. The column the roster stores is
`email = u.mail || u.userPrincipalName || ''` (`entra-id/index.ts:111`): **mail wins.** So for every
account whose SMTP address differs from its UPN, the stored value comes from a namespace the create
does not collide in. It errs in both directions — a free-looking address whose UPN is taken (the
create fails on the morning it matters), and a taken-looking address whose UPN is free (a candidate
refused for nothing).

**Active Directory.** The provider requests `sAMAccountName` (`active-directory/index.ts:67`) and
then uses it only as a display value and a last-resort fallback:
`email: upn || firstString(entry.mail) || (sam ? sam : '')` (`:324`). **The sAMAccountName is
persisted nowhere** — `ConnectedIdentityAccount` carries `externalUserId`, `email` and `displayName`
and no third identifier (`personnel.prisma:17-19`). It is also the namespace *most* likely to
collide, because the ≤20-character limit **manufactures** collisions the UPN namespace does not
have: two long surnames truncate to the same string.

**Do not filter the collision read on `status`.** The deprovision reconcile updates rows **in
place** — `updateMany({ where: { … status: { not: 'DEPROVISIONED' }, syncedAt: { lt: passStartedAt } },
data: { status: 'DEPROVISIONED', syncedAt: now } })` (`usecases/identity-sync.ts:367-375`) — and
nothing ever deletes them. A `status: 'ACTIVE'` filter would therefore call *free* a UPN still held
by a soft-deleted object sitting in Entra's recycle bin, which is one of the cases a real create
rejects. Read every row for the connection, whatever its status.

So, three rules:

- **The negative verdict is `NO_CONFLICT_OBSERVED`, never "available."** Copy, API field and UI
  label all use the observed form. The moment an operator reads "available" they have been told
  something the pass did not check.
- **Every decision row carries `namespacesChecked: ["email"]`** — a literal list, so widening it
  later is a visible diff and an old artefact cannot be re-read as having promised more.
- **Normalise with the reconciler's own rule**, not a second one: `emailKey` trims, lowercases, and
  maps empty to null (`identity-account-link.ts:93-96`). A private normaliser here is how the
  collision check and the link matcher come to disagree about the same address — and a disagreement
  between those two is exactly the [account the leaver can never disable](#open-questions).

`namespacesChecked` is also the honest bound on the headline number: *"would have created 34
accounts"* is unverified against the namespace that would have rejected them. That is the item that
decides whether the rung probes — see
[What a dry run cannot know](#what-a-dry-run-cannot-know).

#### The breaker does not transplant

Decision 6's cap cannot reuse `checkDisableBlastRadius` (`identity-write-breaker.ts:109`).

- Its constants are disable-specific: `MAX_DISABLES_PER_RUN = 50` (`:69`), `MAX_DISABLE_SHARE =
  0.1` (`:72`), `SHARE_RULE_FLOOR = 5` (`:82`), and every message string says "disable".
- **The share rule is structurally dead at a cap of 5.** It requires `proposed > SHARE_RULE_FLOOR`
  (`:140`), which is `proposed > 5` — and `proposed > 5` is already refused one branch earlier.

So `checkCreateBlastRadius` is a **one-line absolute cap in the breaker's clothing**, and the design
should say so plainly rather than let the next reader assume the share rule is protecting something.
It lives as a second exported function in `identity-write-breaker.ts` beside its sibling — one
breaker module, so the two rules cannot drift and neither becomes a second breaker by placement.

The whole-batch-refusal posture is inherited unchanged, for the module's own stated reason:
trimming *"performs part of a probably-wrong action AND hides the anomaly behind a number that
looks deliberate"* (`:36-37`). Also inherited: `population <= 0` refuses, because *"an unknown
denominator is not the same as a safe one"* (`:118-125`) — which means **the joiner must define its
denominator**, and that is an open question below.

#### Absence fails open

The rail with no leaver analogue, and the highest-consequence one.

The leaver acts on **presence** — it must find an existing account, so a stale link table refuses
`NO_FRESH_LINKS` (`identity-leaver-pass.ts:456-473`) and the failure is that nobody gets disabled.
The joiner acts on **absence**: it reads the same emptiness as *"everyone needs an account."*

`IdentityAccountLink` was empty in the field until `reconcileLinksAfterSync` was wired
(`jobs/identity-sync.ts:74-80` states this). **The dangerous state is the default state, not an
edge case.**

So link coverage is a **precondition, not a per-candidate filter** — a per-candidate check would
refuse each candidate individually and read as thirty small problems rather than one broken
premise. This is the direct mirror of the breaker's unknown-denominator refusal.

**And the same inversion applies to the ROSTER, not only to the link table.** The directory
enumeration is bounded: `MAX_USERS = 5000` (`entra-id/index.ts:64`), and a still-present `nextLink`
returns `complete: url === null` — i.e. `false` — with the comment *"the enumeration is KNOWN-PARTIAL
and must not drive deprovisioning"* (`entra-id/index.ts:355-358`). The sync job already honours that,
skipping the link reconcile on anything that did not return `PASSED`
(`jobs/identity-sync.ts:119-122`).

For the **leaver**, partiality removes CANDIDATES: fewer accounts observed, fewer disables proposed,
and the failure is that somebody keeps access a day longer. It fails safe.

For the **joiner**, partiality removes **EVIDENCE OF CONFLICT** — and the absence of evidence is
read, by construction, as "this identifier is free". A truncated enumeration is therefore not a
quieter pass; it is a pass biased toward creating. Which is why `DIRECTORY_NOT_FRESH` is defined on
`status === 'PASSED'` rather than on "a sync ran today": a `PARTIAL` sync *did* complete, on time,
and is precisely the state that must refuse.

#### There is no write-target rail for a create

The leaver's highest-value rail has **no joiner analogue, and it cannot be given one by copying.**
`resolveWriteTarget` is decided per ACCOUNT and reads that account's own observed
`onPremisesSyncEnabled` (`usecases/identity-write-target.ts:52`, `:202`). A joiner has no account
yet, so the rail has **no input at all.** And the obvious substitute is ruled out by the module's own
header (`:4-27`), which spends its opening paragraphs arguing that a tenant-level topology *setting*
is the wrong axis — *"A hybrid estate holds BOTH cloud-only and directory-synced accounts inside ONE
Entra tenant: `onPremisesSyncEnabled` is a per-USER flag"* — and closes with *"Config loses to
observation, always."*

What survives that argument, and is computable at DRY_RUN with no socket, is the **observed
distribution** across the connection's own accounts:

- `onPremSyncedShare` — the share of this connection's `ConnectedIdentityAccount` rows with
  `onPremisesSyncEnabled === true`;
- `onPremObservedAt` — the newest `onPremStateObservedAt` behind that share, gated through the
  **exported** `isObservationFresh` (`usecases/identity-write-target.ts:177-187`), the same function
  the leaver uses rather than a copy of its rule;
- `targetBasis: NO_ACCOUNT_TO_OBSERVE` — recorded on every joiner decision row, stating in the
  artefact that the leaver's per-account basis was structurally unavailable here.

That distribution is **evidence, not a verdict.** A connection whose accounts are overwhelmingly
on-prem-synced is an AD-Connect-authoritative estate, and a cloud user created through Graph there is
a **permanent orphan** the on-prem directory will never own: no AD object, no source of authority,
and the leaver's own write-target rail will later refuse to disable it because Graph is not where it
is mastered. That is a worse outcome than a refused create, and it is invisible on the day it
happens.

At minimum, therefore, a **named refusal** — `TARGET_TOPOLOGY_UNOBSERVED`, in the pass-level table
above — so the case cannot ship as silence. Whether a high `onPremSyncedShare` refuses outright, or
warns and records, is an operator decision; what is not optional is that the number is computed,
persisted, and rendered beside every joiner verdict.

#### The gate-placement rule, and the incident that produced it

State it as a rule, because the leaver already paid for it:

> **Every gate that decides whether a create happens sits ABOVE the DRY_RUN return, in the usecase,
> evaluated from data the dry run has. A gate inside a provider writer is by construction a gate the
> dry run cannot honour.**

The incident. The live Entra writer's pre-flight tested `onPremisesSyncEnabled === false`, which
refused the `null` that Graph actually sends for a cloud-only tenant — *"the ordinary, permanent
state of every user in a cloud-only tenant. That made the live path inert for those directories
while the snapshot writer used in DRY_RUN, which never reaches this check, happily reported 'would
disable' for the same accounts"* (`entra-id/writer.ts:1016-1025`). Its own conclusion is the reason
this is a rule and not a preference: *"A dry run that disagrees with the live path is worse than one
that refuses: the seven-day observation window exists precisely to let an operator compare the
two."*

The mechanism generalises past that one bug, and that is the part worth carrying: **the divergent
gate lived BELOW the dry-run return, in code the dry run never executes.** No test could have caught
it from the dry-run side, because from the dry-run side the gate does not exist.

**Corollary for the leaver, and why the joiner cannot inherit the tolerance.** The leaver retains
exactly two such gates — `onPrem === true` (`entra-id/writer.ts:1005`) and
`onPremStateObserved !== true` (`:1026`) — and they are tolerable **only** because both of their
inputs are mirrored into the snapshot capture, deliberately and with the reason written down
(`integrations/identity-writer-factory.ts:193-212`: *"PARITY WITH THE LIVE CAPTURE, and it is
load-bearing even though nothing reads it here yet"*). A create's gates — credential policy, group
existence, licence headroom, directory quota — **have no such mirror**, and several of them are not
mirrorable at all because nothing observes them. So for the joiner the rule is absolute: if a
condition can refuse a create, it is evaluated in the usecase, from stored or probed data, above the
DRY_RUN branch. A `DirectoryProvisioner` that refuses internally is a provisioner whose dry run is a
different program.

---

### Idempotency

**A disable is idempotent for free; a create is not.** The Entra writer states it outright:
`{"accountEnabled": false}` is *"an absolute set, not a delta, so applying it twice is applying it
once. The unsafe part was never the repetition — it was REPORTING"* (`entra-id/writer.ts:1406-1409`).

Every retry-safety mechanism the leaver ships keys on `externalUserId` — which, for a create, does
not exist until the write succeeds. Two hard blocks:

- `beginWrite` rejects an empty `priorState` (`identity-write-journal.ts:90-96`, because *"an empty
  capture cannot be told apart from 'nothing to capture'"*) **and** rejects a blank
  `externalUserId` (`:97-99`). A create has neither, and faking either defeats the exact check.
- `IdentityWriteJournal.externalUserId` is NOT NULL, there is no `employeeId` column, and **no
  unique constraint on the model** — `personnel.prisma:399-404` carries four plain `@@index` entries
  and no `@@unique`.

So the claim needs a new column, a new unique index and a migration. It is not free, and it is the
whole defence against a duplicate human.

**The action enum, at least, needs no migration.** `IdentityWriteAction` already lists
`CREATE_ACCOUNT` and `ASSIGN_GROUP` alongside the three disable-side verbs
(`identity-write-journal.ts:37-42`) — someone reserved them. The missing pieces are the anchor column
and its unique index, not the vocabulary; one clause here so the next reader does not go looking for
an enum change that is already made.

#### Use the anchor the repo already ships

**Follow the ServiceNow prior art rather than inventing a parallel reservation keyed on the derived
name.** `servicenow/outbound.ts:9-16` is the exact four-step order:

1. mapping already carries a remote id → UPDATE
2. otherwise **ask the remote whether our correlation id exists → ADOPT it**
3. only then CREATE, **stamped with the correlation id**
4. record the id

Its docblock names step 2 as *"the whole fix. Without it the window between a successful POST and a
recorded id is a duplicate factory"* (`:18-20`). And `servicenow/correlation.ts` makes the argument
this design would otherwise have to rediscover: a local unique constraint *"makes the MAPPING
idempotent. Only a correlation id the REMOTE side can be queried by makes the WRITE idempotent"*
(`:26-28`), derived *"only from identity that is stable across retries… No timestamp, no attempt
counter, no random — anything that varies per attempt makes every retry a fresh record, which is
the defect wearing the fix's clothes"* (`:32-35`).

**Anchor on `(tenantId, provider, 'Employee', employeeId)`** — a cuid no roster edit changes.
Anchoring on the derived `first.last@domain` instead would force three rules this design would then
have to invent: persist-and-never-re-derive, an `IDENTITY_DRIFTED` refusal for `fullName` churn
(`hris-sync.ts:136` overwrites it every run), and a `createdDateTime` window heuristic to decide
whether a conflicting account is ours — which manufactures a **seventh operator decision** (how
wide is the adopt window?) that exists only as an artefact of the anchor choice.

**The honest cost, which must be weighed in writing rather than skipped.** The Entra sync's
`$select` set is `id,displayName,userPrincipalName,mail,accountEnabled,userType,onPremisesSyncEnabled`
(+ `signInActivity`) — `entra-id/index.ts:72-75`. **No `employeeId`, no extension attribute.** So a
correlation stamp costs either a `$select` widening or a dedicated `$filter` read at adopt time,
and whether Entra offers a suitable writable-and-queryable attribute is **unverified**. If it does
not, fall back to the name-anchored reservation and say in one paragraph what was checked.

#### A conflict is evidence, not an error

`PROVEN_UNAPPLIED_STATUS` deliberately excludes 409, and the reason is written down: *"a conflict
can reflect state that a partial application produced"* (`entra-id/writer.ts:604`, set at
`:614-616`). **That is exactly right for a PATCH and exactly inverted for `POST /users`**, where
"an object with this userPrincipalName already exists" is the strongest available evidence that our
own earlier attempt landed.

So the joiner must not *classify* the conflict — it must **read back and adopt**, mirroring
`settleLostResponse` (`writer.ts:1256-1300`) rather than inventing a parallel mechanism. Do not
reuse `PROVEN_UNAPPLIED_STATUS` for creates without re-deriving it; it is a claim about PATCH
semantics.

#### The dispatch id is a guarantee; dedupe is best-effort

Use `dispatchJobId('identity-joiner-pass', \`${tenantId}:${provider}\`, BUCKET)` — the same shape as
`identity-leaver.ts:97-101`. It survives BullMQ's three-segment rule **because it goes through the
helper**, which normalises colons rather than rejecting them (`fan-out.ts:104`).

**The four-segment bug is already fixed** (`fan-out.ts:95-105` carries its own history — *"it
looked healthy from the outside: the schedule was registered, the worker was up, and a MANUAL
trigger — which passes no jobId — worked perfectly"*). The joiner does **not** inherit it. The live
hazard is the guard denominator, below.

And the jobId is explicitly not the guarantee, by the repo's own written rule: `schedules.ts:25-33`
says `removeOnComplete` makes a completed jobId reusable and *"any new scheduled job that must
never double-fire MUST carry its own durable idempotency key, not lean on the jobId."* The joiner
is the textbook case.

`attempts: 1` in `JOB_DEFAULTS` (`jobs/types.ts:825`), mirroring the leaver's entry and reasoning
(`jobs/identity-leaver.ts:8-21`). **Premise correction worth carrying:** decision 1 rests on "the
queue retries 3×", which is the *queue default* (`jobs/queue.ts:53`) and is false for every
identity job today. `JOB_DEFAULTS` is `Record<JobName, …>` (`types.ts:768`), so an entry is
type-required — **but the type forces an entry, not the right value.** A copy-pasted `attempts: 3`
compiles. Say so in the entry's comment; the conditional claim is the backstop that survives
someone ignoring it.

Retry is a **re-dispatch of an idempotent pass**, never a queue retry.

---

### Trigger, schedule and the day-one constraint

**Trigger on `Employee.startDate` (`personnel.prisma:240`), never on `status`.**

`deriveEmploymentStatus` returns `ONBOARDING` only while `hireDate > now`
(`employment-status.ts:77-78`). A date-only vendor string parses to UTC midnight, so by the 04:00
`hris-sync` on the start day the worker has already fallen through to `ACTIVE`. **A status-keyed
query works in a dry run written the day before and returns nothing on the day it matters.**

**Slot: 06:00 UTC.** The reason is ordering, not occupancy — 05:00 holds three dispatchers
(`schedules.ts:116`, `:159`, `:280`) and 06:00 holds three too, so occupancy distinguishes nothing.
The sound reasons:

- **after** `identity-sync` at 03:00 (`schedules.ts:110`), which refreshes the collision denominator
  and would carry the credential probe;
- **after** `hris-sync` at 04:00 (`schedules.ts:135`), which writes the `startDate` the pass reads;
- **before** `notification-dispatch` at 07:00 (`schedules.ts:15`), so a day-one refusal reaches an
  inbox the same morning — which is what decision 4 actually demands.

**Not** gated on the link reconcile, and that is the load-bearing asymmetry. The leaver gates on
link freshness because freshness *is* its completeness gate; the joiner asserts an account does
**not** exist, so a lagging link table is evidence pointing the wrong way.

#### The timezone question decision 4 cannot be honoured without

`Employee.startDate` is a bare `DateTime` (`personnel.prisma:240`) written from the vendor's
`hireDate` (`workday/roster.ts:105`), and **there is no tenant timezone anywhere in the schema**
(verified: zero `timezone` columns across `prisma/schema/*.prisma`). The only zone in the system is
the deployment-wide `NOTIFICATIONS_TZ`.

So one UTC firing hour means a US starter is provisioned the evening before, locally, while an APAC
starter is provisioned mid-afternoon on day one. **Decision 4 said fire early in the day; the design
cannot say early in *whose* day without one more answer.** Either accept UTC-day semantics as a
stated cost, or make a second same-day dispatch a **coverage** mechanism for the eastern half rather
than a retry.

This also interacts with decision 2: an Entra TAP at default lifetime (60 minutes) issued at 06:00
UTC is dead before a starter west of UTC-3 arrives. Decision 4 was chosen partly to kill the
TAP-expiry problem; a UTC-fixed slot partly re-opens it.

#### The dispatcher guard has a hole, and the joiner would land in it

`tests/guards/fan-out-bucket-matches-schedule.test.ts:41-51` lists **six** dispatchers.
**`identity-leaver.ts` is not among them** — and it is the only file in `src/app-layer/jobs/` that
calls `dispatchJobId` without a guard row (verified: seven job files call it; six are listed).

So the guard whose entire subject is dispatcher hygiene does not cover the dispatcher that shipped
the four-segment bug — its bucket, its `jobId` presence and its `fanOut` routing are all unchecked
while the file reads as comprehensive. **This is a sweep whose denominator is its own key.** A
joiner dispatcher lands outside it by default too.

**Fix in the same diff: add both rows, and derive the population from the job files that CALL
`dispatchJobId`** — not from `SCHEDULED_JOBS` names ending in `-dispatch`, which would pull in
`notification-dispatch` (`schedules.ts:15`), a job that calls neither primitive and would turn the
guard red.

If a sub-daily cadence survives the timezone decision, it costs more than a guard row: a new bucket
constant in `fan-out.ts`, a row in the guard's `BUCKET_MS` table (`:30-33`), an edit to its
constant-pinning assertion (`:181-188`), and **two `SCHEDULED_JOBS` entries** — the guard's cron
parser accepts only `*`, `*/N` and a fixed integer, and throws on a list or range (`:88`).

Other ratchets a new schedule must satisfy: `tests/regression/infrastructure-guards.test.ts:143`
pins the scheduled-job name set (unit + guards + guardrails all go green while this goes red), and
`tests/guardrails/runtime-wiring-coverage.test.ts:53` requires the job to be scheduled or listed in
`ON_DEMAND_JOBS`. **Run a bare `npx jest`, not the three usual roots.**

#### Index triage

`Employee` sits in `LIST_MODELS_TENANT_INDEX_SUFFICIENT` with the written reason *"listEmployees
filters by tenantId (+status) — covered by `@@index([tenantId, status])`"*
(`tests/guardrails/schema-index-coverage.test.ts:394`). A `startDate`-window `findMany` **falsifies
that reason**, and no `startDate` index exists (`personnel.prisma:256-258`). Add
`@@index([tenantId, startDate])` and move the entry to `LIST_QUERY_INDEXES` **in the same diff**,
per that guardrail's no-stale-entries rule.

**And `Employee` is only half of it — the collision read needs an index too.**
`ConnectedIdentityAccount` carries `@@unique([tenantId, connectionId, externalUserId])` plus
`@@index([tenantId, provider])`, `@@index([tenantId, status])` and `@@index([tenantId, connectionId])`
(`personnel.prisma:124-127`) — **nothing on `email`.** An email-keyed lookup is therefore a scan of
the whole connection roster, once per candidate, against a table bounded at 5000 rows per Entra
connection. Add `@@index([tenantId, connectionId, email])`.

That model is *already* in `LIST_MODELS_TENANT_INDEX_SUFFICIENT`, with the reason *"personnel
provider reads all accounts for a tenant (offboarded-access join) — covered by
`@@index([tenantId, status])`"* (`tests/guardrails/schema-index-coverage.test.ts:400`). A joiner
collision `findMany` **falsifies that reason** exactly as the `startDate` window falsifies
`Employee`'s, so the same move applies: new composite index, entry relocated to `LIST_QUERY_INDEXES`,
same diff. Layer C-completeness will not raise it for you — the model is triaged already, which is
the quieter failure mode: a stale reason reads as coverage.

---

### What a dry run cannot know

Stated honestly, because a rung that certifies a fidelity it does not have is worse than no rung.

**In DRY_RUN the factory returns a snapshot reader and opens no socket**
(`integrations/identity-writer-factory.ts:364-371`), and that return sits *above* `mergeConnection` (`:375`), so
the dry run never merges connection config either. Consequently:

1. **TAP policy state — unknown.** Decision 2's required refusal needs a Graph read of the
   authentication-methods policy. A TAP-disabled tenant's seven-day artefact would report "would
   create" for every candidate, and every one would refuse on the day it went live. **This is the
   DRY_RUN/live mismatch the rung exists to prevent, reproduced inside it.**
2. **Group existence — unknown.** Entra's sync hardcodes `groups: []` (`entra-id/index.ts:148`), as
   do Okta and Google Workspace; only Active Directory populates them. So for the flagship provider
   there is **no stored evidence** that a configured group id exists, is a security group, or is
   licence-assigning. A dry run reporting "would add to Sales-Staff" is asserting something it did
   not check.
3. **Live identity collision — unknown.** The check reads `ConnectedIdentityAccount`, written only
   by the 03:00 sync (`identity-sync.ts:172`). The predicted identity is systematically optimistic
   by up to ~27 hours.
4. **Licence-pool headroom — unknown.**

**Three ways to resolve, and the design must pick in writing.** Options 1 and 2 answer (1) and (2).
**Neither transfers to (3)**, which is why there is a third — and (3) is the one the headline number
depends on.

- **Option 1 — probe at 03:00, where the Graph token already lives.** The sync records TAP
  capability and group existence with an `observedAt` stamp, and the joiner consumes it through the
  **exported** `isObservationFresh` (`identity-write-target.ts:177-187`) — the same function, not a
  copy, for the reason `LINK_FRESHNESS_MS` is an alias rather than a literal
  (`identity-leaver-pass.ts:80-89`). Above DRY_RUN the probe is re-made live, and the stored read is
  marked the way the snapshot writer marks its own (`staleEvidence: true`,
  `integrations/identity-writer-factory.ts:212`). *Note the group read is covered by the existing
  `Directory.Read.All` consent; the TAP policy read is not.*
- **Option 2 — do not probe.** Then say plainly that the artefact cannot predict
  `TAP_POLICY_UNAVAILABLE`, and gate promotion out of DRY_RUN on a separate one-shot operator-run TAP
  check rather than on elapsed days.
- **Option 3 — a read-only probe at pass time, for the collision only.** `GET /users?$filter=
  userPrincipalName eq '…'` plus a `mailNickname` check, under the `User.Read.All` the connection
  already holds (`entra-id/index.ts:165`). **No new consent**, and the token minted carries no write
  role, so it still cannot be mistaken for evidence that `User.EnableDisableAccount.All` was granted.

**Why option 1 does not transfer to (3).** A stamp taken at 03:00 is the right shape for a
tenant-level POLICY, which is stable for weeks — and the wrong shape for identifier AVAILABILITY,
which is volatile within hours. Decision 4 puts our pass and the IT admin creating an account by hand
on the *same clock*: both act on the morning someone starts. A 27-hour-old collision read is not a
slightly stale answer, it is an answer about a different directory. Stale-but-marked works for TAP;
for the collision it would be marked, stale, and still the number the operator reads.

**The choice: take option 3 for the collision, and pair it with option 1 for (1) and (2).** The
honest cost has to be stated rather than skipped, because it retires a property the factory's module
header makes a sustained case for: *"no consent is needed to observe, no Graph token is minted…
and never opens a socket"* (`integrations/identity-writer-factory.ts:18-31`). That argument is sound
for the leaver **because deciding not to write was most of its work** — the snapshot answers
"already disabled?", and the rails above it answer the rest. For the joiner, **the read IS the
decision.** A rung that cannot check the one namespace a create is rejected in is not observing the
live path; it is observing a different one.

Three consequences to accept with it:

- The probe runs **after** the cap check, so it is bounded at ≤5 GETs per connection per pass
  (decision 6). A batch already refused `BATCH_OVER_CAP` is refused without probing, and its
  candidates record the collision field as *not checked* rather than `NO_CONFLICT_OBSERVED`.
- A pass-time probe needs the connection secrets, and `mergeConnection` sits **below** the DRY_RUN
  return (`integrations/identity-writer-factory.ts:375`). So the joiner's resolution arm must merge
  config in DRY_RUN where the leaver's does not — another reason the seam is a separate
  `DirectoryProvisioner` and not a widened writer. `SECRETS_UNREADABLE` consequently **is** reachable
  at joiner DRY_RUN, unlike the leaver's; `WRITES_NOT_ENABLED` still is not, because no writer is
  constructed.
- Only Entra gets it in Phase 1. AD's real namespace is `sAMAccountName`, which this product does not
  store and the LDAP read would have to ask for separately.

**If the answer is still "do not probe"** — a defensible call, and it is the operator's — then the
section must say so in these words: *the collision line is snapshot-only*, every verdict carries the
enumeration's `observedAt` beside it, and the headline count is labelled as a plan against
yesterday's directory rather than a prediction about tomorrow's.

**Either way, every pass row carries a `predictionLimits` block naming what could not be checked**,
and the passes page renders it. Without that, the seven days certify a fidelity the rung does not
have.

`predictionLimits` also carries a second field, `unmodelledRefusals`, naming the class that can
**never** be observed and is only ever discovered by attempting: directory object quota,
restricted-management administrative units, blocked-word and UPN-policy rejections, and conditional
access on app-created objects. This is the same posture the Entra writer already takes for disables:
its 403 discriminator enumerates four causes Graph answers identically — an unconsented permission, a
privileged-role target, a restricted-management administrative unit, a blocked service principal —
and states outright that *"the body cannot tell (a) from (b)/(c), and the difference decides what the
operator should DO"* (`entra-id/writer.ts:78-95`). Naming the unmodelled class is not
hedging; it is the difference between an artefact that says "34 would be created" and one that says
"34 passed every check we can make", followed by the list of checks nobody can make from here.

**One more thing the batch-level probe cannot inherit as precedent.**
`EntraIdDirectoryWriter.preflight()` (`entra-id/writer.ts:777`) is the natural model — its docblock
says it turns 1000 doomed writes into one refusal — but it has **no caller**, and it is unreachable
through the seam anyway: `WriterResolution.writer` is typed `DirectoryWriter`
(`integrations/identity-writer-factory.ts:118-121`), which does not declare it. It is a shape to
adopt, not a precedent to inherit.

---

### Observability

**Durable record.** One terminal `IntegrationExecution` row per pass, `automationKey =
${provider}.joiner_pass`, written by **one** helper mirroring `writeExecutionRow`
(`identity-leaver-pass.ts:262-286`). Excluded from the tenant-wide automated-checks list for the
leaver's two stated reasons (`:104-113`): it is not a control check, and that page is reachable with
`controls.view` while this authority is OWNER-only.

Status is `NOT_APPLICABLE` for every refusal, `PARTIAL` only for a truncated decision list, `PASSED`
only for a pass that decided a real population — the ternary at `:197`, which exists because a
breaker-refused batch was being written `PASSED` and rendered **"Ran — complete"** beside an empty
refusal cell. **The returned status and the persisted status come from the same expression**
(`:556-568`), which is the fix for the sync that returned `PARTIAL` while persisting `PASSED`.

**Identifier discipline.** `resultJson` decisions are keyed by `employeeId` — never by the derived
identity, never by a directory identifier. `IntegrationExecution` is not encrypted at rest and its
rows outlive the pass (`identity-leaver-pass.ts:126-136`). Free-text reasons go through
`redactDirectoryIdentifiers` (`:157`). **The same discipline applies to the reservation row**, which
is where the derived identity lives — read under an authorised tenant-scoped query, not in
`resultJson`.

The unmapped department **string** is recorded verbatim; it is tenant configuration, not a person,
and it is decision 5's required by-name mitigation — the one field whose absence makes a typo'd
department indistinguishable from a mapped one.

**And beside it, the group that was actually chosen:** `groupSource: MAPPED | DEFAULT_FALLBACK`
together with the resolved `groupId` and `groupName`. Decision 5's mitigation is "surface every
fallback **by name**", and a decision row carrying `groupSource: DEFAULT_FALLBACK` and an unmapped
department — but no group — reports that a fallback happened without saying what the person was put
into. Both directory identifiers here are tenant configuration rather than personal data, so they sit
in `resultJson` under the same discipline as the department string; the derived *identity* still does
not.

**The anti-discard rule.** The array of who was refused and why is **persisted**, not summarised
into counts. The brief's own example — a reconciler computing unresolved accounts whose caller
logged counts and dropped the array — has since been **fixed**: `recordLinkReconcileOnExecution`
persists `unresolved` with per-account reasons and a `unresolvedTruncated` flag
(`jobs/identity-sync.ts:135`, `:176`, `:221`, `:231`). The joiner inherits the fixed shape.

**Metrics.**

- `identity.write.outcome{provider, action:'create', outcome}` — **already exists** and already
  types `'create'` (`integration-metrics.ts:233-243`). Nothing new.
- Reuse `recordOutboundWrite`'s `created | adopted | updated | conflict | failed` vocabulary
  (`:143-149`) rather than minting a parallel one beside it. The one genuinely new series is
  **`conflict_unresolved`** — a conflict whose read-back did not confirm our account, i.e. *"we may
  have created a duplicate, or somebody else did."* That is the alertable one.
- `identity.joiner.pass{provider, outcome}` — new, mirroring `recordLeaverPassOutcome`
  (`:335-353`), emitted on **every** terminal path including `mode_disabled`, for the reason its
  docblock gives: a flat non-zero rate is the only signal the scheduler is alive.

**Surfaces.** `GET /api/t/:slug/admin/identity-joiner-passes`, gated `admin.tenant_lifecycle`, as a
**sibling** path — not nested under `admin/integrations`, whose first-match-wins prefix resolves to
the weaker `admin.manage`. And `GET /api/t/:slug/admin/identity-provision-reservations`, **the
surface the leaver never got** — with a caller from day one, emitting its count as a gauge even when
zero, because *a counter that only appears during an incident is indistinguishable from one that
stopped being emitted*.

**Notification.** Diverges from `planLeaverNotifications`, which routes DRY_RUN to nobody
(`notifications/leaver.ts:344-345`). A joiner DRY_RUN refusal for someone starting **today** is
actionable precisely because it is a dry run — decision 4 made every failure day-one, so a report
read on day 8 is not a surface.

**The dedupe entity must be `employeeId`.** Copying one line loses four of five alerts: `entityId =
journalRef ?? input.linkId ?? \`${ctx.tenantId}:${input.provider}\`` (`notifications/leaver.ts:461`),
and the outbox key is `{tenantId}:{type}:{email}:{entityId}:{YYYY-MM-DD}` (`enqueue.ts:82`). A
joiner candidate has no link and, in DRY_RUN, no journal row — so **every failed joiner in a tenant
would share one entity id and the outbox would suppress all but the first**, counting the rest as
`suppressed`, which reads as dedupe working. Five failed hires, one email.

---

### Open questions

#### Needing an owner answer

1. **Is the joiner's population empty by construction?** *(blocking — one look at a real Workday
   report answers it)* Both HRIS providers **drop** rows with no work email — BambooHR filters
   (`hris/index.ts:245`), Workday returns null with the comment *"the whole personnel graph is keyed
   on it"* (`workday/roster.ts:90-95`) — and `Employee.workEmail` is NOT NULL and unique
   (`personnel.prisma:234`, `:256`). **If pre-hires carry no work email until IT creates the
   mailbox, the joiner has no candidates ever**, and it would present exactly like the leaver's
   silent-nothing. Verify before any code is written.

2. **Which address is authoritative, and does the derived identity have to equal
   `Employee.workEmail`?** The reconciler matches **exact normalised email**, `Employee.workEmail` ↔
   `ConnectedIdentityAccount.email`, via `emailKey` (`identity-account-link.ts:94-97`), and Entra's
   sync writes `email = u.mail || u.userPrincipalName` (`entra-id/index.ts:111`). If decision 1's
   collision path mints `john.smith-4f2a@` while `workEmail` still says `john.smith@`, **no link
   ever forms, and the joiner would create an account the leaver can never disable.** Three options
   — refuse on divergence (declines decision 1's collision arm, so it would be a *new* decision);
   let the joiner write the link from its own claim (a **second writer** on `IdentityAccountLink`,
   whose only writer today is `reconcileIdentityAccountLinks` via `jobs/identity-sync.ts:56`); or
   accept the gap. **Reject in writing the tempting fourth option** — updating `Employee.workEmail`
   would make the next HRIS upsert miss its `tenantId_workEmail` key (`hris-sync.ts:134`) and mint a
   **duplicate employee row**.

3. **Timezone semantics for decision 4.** UTC-day, or a second dispatch as eastern-half coverage?
   See above. Decides whether decision 4 is honoured or quietly broken for half the estate.

4. **Does `writesEnabled` split per direction?** Granting create-consent grants disable authority at
   the credential layer (`entra-id/writer.ts:215-219`). Per-direction flag, or accept the coupling?

5. **Should MANUAL employees be joiner candidates?** `createEmployee` sets no `syncedAt`
   (`usecases/personnel.ts:75`), so any roster-freshness gate excludes every manually-entered
   pre-hire — and they also have no stable collision-token source. Including them is the only path
   for a tenant with no HRIS.

6. **Cap of 5 — per run or per UTC day?** Decision 6 says per run; with any intra-day retry that is
   up to 5× the cap. Per-day preserves the anomaly-detector meaning.

#### Needing investigation before the design closes

- **Does Entra expose a writable, queryable attribute for a correlation stamp?** Decides whether the
  ServiceNow anchor is available or the design falls back to a name-keyed reservation. The sync's
  `$select` carries none today (`entra-id/index.ts:72-75`).
- **Does Graph return 409, or 400 with `Request_BadRequest` / `ObjectConflict`, for a duplicate
  UPN — and does the body name the property?** The design deliberately does not depend on this (the
  read-back decides), but the answer determines whether the common path can skip a read.
- **What defines "the 04:00 sync completed today"?** `IntegrationConnection` has **no `lastSyncAt`
  column**. Derive from the newest `PASSED` `IntegrationExecution`, or from
  `max(Employee.syncedAt)`? Pick one and state it, rather than letting two callers derive it
  differently — that is how `LINK_FRESHNESS_MS` ended up an alias rather than a copy.
- **The joiner's breaker denominator.** Starters in window? Active employees? `population <= 0`
  refuses (`identity-write-breaker.ts:118-125`), so this cannot be left undefined.
- **Where does the department→group map live?** `TenantSecuritySettings` Json inherits the OWNER
  gate; `IntegrationConnection.configJson` sits beside the writer that consumes it and survives two
  connections per provider. Note the protection flag chose the **row** over connection config
  (`identity-account-protection.ts:9-19`), which argues for neither.
- **Where does the TAP reach a human on the start morning?** Decisions 2 and 4 together mean a
  credential must reach a person within hours. The manager's mailbox is the obvious answer and is a
  credential in an email. Gates every rung above DRY_RUN.
