# Audit procedures for IAM and agent controls

Catalogue version **1**. This document is the procedure catalogue for the
agentic auditor (UC4 in [`docs/agentic-iam-roadmap.md`](agentic-iam-roadmap.md)).
It defines eight audit procedures. Each one names its control identifiers, its
population as a table and a filter, how its sample is drawn, the attributes it
tests, the raw rows its re-performance recomputes, what counts as an exception,
and what makes it INCONCLUSIVE. This version proposes library v1 as procedures
1 to 5. Procedures 6 to 8 are catalogued and are later.

**Status: adopted for this repository; internal audit's approval and the
provider's agreement are open.** The provider is the managed-service provider
whose IAM practice runs the use cases
([`docs/agentic-iam-managed-service.md`](agentic-iam-managed-service.md)). The
repository owner's merge of this file's pull request is the repository owner's
sign-off, and it adopts catalogue version 1 for this repository. The merge does
not supply the acts of external parties. Neither internal audit's approval nor
the provider's agreement of version 1 is recorded on issue #3663, and each is
recorded there when given. While both are open, library v1 is proposed to
internal audit and the provider, and no procedure here is a definition either
of them has approved or agreed.

Procedures 1 to 5 run on `main` as handlers on the control-test runner, as the
registered auditor agent (step `3c`, #3676;
`src/app-layer/services/audit-procedures/`), and each run writes one
workpaper. Procedures 6 to 8 have no handler. The gaps the catalogue depends
on are listed at the end, each with the step that builds it.

## Ownership and approval

This catalogue binds whoever operates it to the rule below, which is decision 3
of [`docs/agentic-iam-roadmap.md`](agentic-iam-roadmap.md). Step `3b` (#3675)
put three parts of it on `main`: the line-of-defence value on a membership, the
auditor independence check, and the workpaper record. Step `3c` (#3676) put the
auditor agent's handlers on `main`, and step `3d` (#3677) internal audit's
sampling of the workpapers.

- **The second line of defence is to own and operate the auditor agent.** It
  registers the agent, decides its grants and its policy card, holds its kill
  switch, and sets the procedure parameters each workpaper records. On `main`
  the parameters are stored on the procedure's control-test plan, and only a
  person who owns the auditor agent the plan names may set, change or remove
  that plan's procedure, or pause, archive, unschedule or delete the plan:
  every other caller, an API key and an agent included, is refused
  `AUDIT_PROCEDURE_PLAN_OWNER_ONLY`. The auditor may hold Inflect's read tools
  and `propose_finding` and nothing else.
- **Internal audit is to approve this catalogue and to sample the auditor's
  workpapers.** A sampled workpaper must be re-checked by a person in internal
  audit, never by the auditor agent's owner. On `main` a daily sweep draws the
  workpapers with a keyed sample at the tenant's rate (every workpaper in the
  pilot; only internal audit changes the rate) and assigns each to an ACTIVE
  member whose line of defence is THIRD and who does not own the auditor agent,
  or records it UNASSIGNED with a reason and assigns it the day somebody is
  eligible. That member alone re-performs it and answers CONCURRED, DISSENTED or
  INDETERMINATE, once, in stable dissent codes, which also sets the workpaper's
  review stamp; internal audit sees every assignment. A dissent becomes a
  finding proposal that a person other than the dissenter decides. The
  re-performance agreement rate is reported in the agent governance pack with
  its definition (`usecases/audit-workpaper-sample-review.ts`,
  `jobs/audit-workpaper-sample-review.ts`).
- **The auditor is not the auditee.** The auditor agent's owner must be second
  line and must own none of the agents the procedures examine. On `main` an
  OWNER declares each member's line of defence (FIRST, SECOND, THIRD or not
  declared), and an undeclared line never satisfies the check. An agent is
  refused as an auditor, at registration, at an amend that makes it one, and at
  every move to ACTIVE, unless its owner is an ACTIVE SECOND-line member who
  owns no other non-auditor agent that is not RETIRED. A later change that
  breaks the rule raises a finding against the auditor and does not suspend it,
  and an auditor that is not independent can record no workpaper.
- **The repository owner's merge is the sign-off.** The repository owner's
  merge of the pull request that adds or changes this file adopts that version
  for this repository, and auto-merge on green is the repository owner's
  standing authorisation for that merge (the repository owner's decision of
  2026-10-17). Internal audit is to approve the catalogue and the provider is
  to agree it, and the merge supplies neither: each is an act of its own, recorded on
  the version's step issue (#3663 for version 1) when given. Neither is
  recorded for version 1, so both are open.
- **The procedure text is Inflect-original.** The provider's methodology
  reference for each procedure is recorded by name only, and none of the
  provider's text is reproduced. The repository holds no provider methodology
  reference names, so every reference is open: the provider supplies it, and it
  is recorded on issue #3663 when given. The
  reference column below states that for each procedure.
- **Control identifiers are identifiers only.** No ISO/IEC or SOC 2 control
  text is reproduced here. Each identifier is one this repository's framework
  catalogue carries: ISO/IEC 27001:2022 Annex A from
  `prisma/fixtures/iso27001_2022_annexA.json`, SOC 2 from
  `src/data/libraries/soc2-2017.yaml`, OWASP agentic risks from
  `src/data/libraries/owasp-agentic-top10.yaml`, ISO/IEC 42001 from
  `src/data/libraries/iso-42001.yaml`, NIS2 from
  `prisma/fixtures/nis2-control-templates.json` and the EU AI Act from
  `src/data/libraries/eu-ai-act.yaml`.

The SOC 2 catalogue here carries one criterion per series, two for CC1 (CC1.1,
CC1.2, CC2.1 and so on to CC9.1), so the logical-access procedures cite
**CC6.1**. CC6.2 and CC6.3 do not exist in this catalogue;
`src/app-layer/usecases/legacy-evidence-controls.ts` records the same
substitution for the legacy recertification evidence.

A change to a procedure is a pull request to this file. It raises the catalogue
version, the repository owner's merge of that pull request adopts the new
version, and internal audit's approval and the provider's agreement of it are recorded on
its step issue when given, as for the first version. A procedure id is never
renamed and never reused.

## The library

| # | Procedure id | Procedure | Library | Control identifiers | Provider methodology reference |
|---|---|---|---|---|---|
| 1 | `iam.leaver_timeliness` | Leaver timeliness | **v1** | ISO/IEC 27001:2022 A.5.16, A.5.18, A.6.5 · SOC 2 CC6.1 · NIS2 Art. 21(2)(i) | Open: the provider supplies it, recorded on #3663 when given |
| 2 | `iam.recertification_completeness` | Recertification completeness | **v1** | ISO/IEC 27001:2022 A.5.18 · SOC 2 CC6.1 · NIS2 Art. 21(2)(i) | Open: the provider supplies it, recorded on #3663 when given |
| 3 | `iam.time_bounded_access_expiry` | Time-bounded access expiry | **v1** | ISO/IEC 27001:2022 A.5.15, A.5.18 · SOC 2 CC6.1 · OWASP ASI03 | Open: the provider supplies it, recorded on #3663 when given |
| 4 | `iam.privileged_access` | Privileged access | **v1** | ISO/IEC 27001:2022 A.5.18, A.8.2, A.8.5 · SOC 2 CC6.1 · NIS2 Art. 21(2)(i), Art. 21(2)(j) | Open: the provider supplies it, recorded on #3663 when given |
| 5 | `agent.authority_conformance` | Agent authority conformance | **v1** | OWASP ASI02, ASI03 · ISO/IEC 27001:2022 A.5.15, A.8.2 · ISO/IEC 42001 A.9.4 · SOC 2 CC6.1 | Open: the provider supplies it, recorded on #3663 when given |
| 6 | `agent.stop_control` | Stop control | later | OWASP ASI08, ASI10 · ISO/IEC 27001:2022 A.5.26 · ISO/IEC 42001 A.6.2.6 | Open: the provider supplies it, recorded on #3663 when given |
| 7 | `agent.approval_quality` | Approval quality | later | OWASP ASI09 · EU AI Act Art.14 · ISO/IEC 27001:2022 A.5.3 · ISO/IEC 42001 A.9.2 | Open: the provider supplies it, recorded on #3663 when given |
| 8 | `assurance.evidence_sufficiency` | Evidence sufficiency | later | ISO/IEC 27001:2022 A.5.35, A.5.36 · ISO/IEC 42001 7.5, 9.2 · SOC 2 CC4.1 | Open: the provider supplies it, recorded on #3663 when given |

This version proposes library v1 as exactly procedures 1 to 5: the five in the
scope of step `3c` (#3676), which runs them on the existing control-test
runner. Procedures 6 to 8
are later for a stated reason each, given in their sections. The procedure id
is the stable key a workpaper, a finding proposal and the reliance package of
step `4d` cite.

## How every procedure runs

The rules in this section bind all eight procedures. A procedure section states
only what differs.

### Period

A period is a UTC calendar month (`YYYY-MM`, as `monthlyPeriod` in
`src/lib/agentic/evidence-artefact.ts` labels one) or a UTC calendar quarter
(`YYYY-Qn`). The start is inclusive and the end exclusive. Each procedure states
which it uses. A procedure runs only for a period that has ended.

The quarter is the recertification interval this product already uses:
`QUARTERLY` is 90 days in `src/app-layer/jobs/automation-runner.ts`, and
`MAX_GRANT_DAYS` in `src/app-layer/integrations/providers/entra-id/entitlement.ts`
is 90 for the same reason.

### Population

Every population is named as rows in a table for this tenant, a filter, and
explicit inclusions and exclusions, in the style of `METRIC_DEFINITIONS` in
`src/lib/agentic/report-definitions.ts`. Each procedure also states its moment:
`OVER_WINDOW` (rows that fall inside the period) or `AS_OF_GENERATION` (rows as
they stand when the procedure runs).

The handler reads the population once, one row past a cap of 5,000 units. A read
that returns more than 5,000 is truncated, and a truncated population is never
sampled. The cap and the read-one-past rule are the ones
`src/app-layer/usecases/access-review-legacy.ts` uses for `MAX_SUBJECTS`.

The population is then **frozen**: its unit ids are sorted, and the workpaper
records the count and a SHA-256 over the procedure id, the period label and the
sorted ids, one per line. The id list itself is kept with the workpaper's
evidence. A population that changes after the freeze does not change the
sample.

**The first sample is binding.** The first run that freezes a population and
draws a sample for a procedure and period fixes both. A later run for the same
procedure and period reads the population again and compares its count and
digest with the stored ones, and reports any difference as a fact on its
workpaper. It then reuses the stored id list and sample, and evaluates the
attributes afresh. A run that stopped at a precondition drew no sample and
fixes nothing. Without this rule a re-run would draw from a different
population, because `AS_OF_GENERATION` rows are read as they stand and
`OVER_WINDOW` rows can still be edited (an `Employee.endDate`, a proposal's
review).

### Sample

The sample is drawn with the sampler in `src/lib/agentic/proposal-sampling.ts`,
unchanged:

- **Keyed seed.** The seed is a per-tenant HMAC key derived with `deriveSubkey`
  (`src/lib/security/encryption.ts`) from the purpose string
  `inflect-audit-procedure-sample-v1:<tenantId>`. It is distinct from the ASI09
  sampler's `inflect-agent-proposal-sample-audit-v1` purpose, so an approval
  sample and an audit sample never share a key. The seed is never stored,
  rendered or logged, the rule `seedForTenant` in
  `src/app-layer/jobs/agent-proposal-sample-audit.ts` already follows.
- **Stated epoch.** The epoch is `<procedureId>@<periodLabel>`, for example
  `iam.leaver_timeliness@2027-03`. A procedure with two sub-populations draws
  each with the suffix `/<sub-population>`. The epoch is stored on the
  workpaper. The epoch is fixed by the period, not by the run date, and the
  first sample for a period is binding (see Population), so a re-run cannot
  look for a more favourable sample.
- **Rank, not threshold.** `selectSample` scores every unit with `sampleScore`
  (HMAC-SHA256 over the epoch, a NUL and the unit id) and takes the lowest
  scores. Whether a unit is drawn depends on every other unit in the frozen
  population, so at the time of an action nobody can tell whether the sample
  includes it.
- **Size.** `sampleSizeFor(n)`: 10% of the population, at least one and at most
  25. The second line may set a larger size, up to the whole population; the
  workpaper records the size used. Procedure 2 always tests the whole
  population, for the reason its section gives.

The sample is reproducible from three things: the seed, which the deployment
re-derives from the master KEK; the epoch on the workpaper; and the frozen id
list. The same three always give the same sample, because `selectSample` breaks
ties on the unit id and so orders the population totally.

The seed can be re-derived only under the master KEK in force when the sample
was drawn. `deriveSubkey` reads the current `DATA_ENCRYPTION_KEY` and has no
fallback to `DATA_ENCRYPTION_KEY_PREVIOUS`, so after a master-KEK rotation the
deployment derives a different seed. Each workpaper therefore records a seed
fingerprint: HMAC-SHA256 under the seed over the fixed label
`inflect-audit-procedure-seed-fingerprint-v1`. The label contains no NUL, so it
never equals the input of a unit's score. The fingerprint is not secret and
reveals neither the seed nor any score; it tells a verifier whether the seed
they hold is the one that drew the sample. Re-drawing a sample after a rotation
needs the previous key. Without it, the sampled-id list stored on the workpaper
is the authoritative record of the sample.

### Re-performance

A procedure re-performs from raw rows. It reads the rows that record what
happened and recomputes every figure it relies on. It never takes a stored
derived figure as evidence: not a `CheckResult`, not an
`IntegrationExecution.resultJson` count, not an evidence PDF's totals, not a
control test's `Examined:` line. Where a stored figure exists, the handler
recomputes it and reports any difference as a fact.

Population-level checks run over every unit of the frozen population.
Item-level attributes run over the sample.

### Item outcomes and the conclusion

Each sampled unit ends as one of three item outcomes, each with a stable code:

- **PASS**: every attribute that applies was met.
- **EXCEPTION**: at least one attribute was not met. The code names which.
- **UNTESTABLE**: an attribute that applies could not be evaluated from the
  rows. The code names why.

An attribute that does not apply to a unit (for example MFA on a provider that
never reports it) is recorded as not applicable with a reason. It is neither a
pass nor an exception, and the workpaper lists it as a scope limit.

The conclusion is decided in this order:

1. **INCONCLUSIVE**, and no sample is drawn, when a precondition fails. Every
   procedure has these preconditions: the population is not empty
   (`EMPTY_POPULATION`, recorded as vacuous); it is not truncated
   (`POPULATION_TRUNCATED`); the period has ended (`PERIOD_OPEN`); and every
   parameter the procedure needs is set (`PARAMETER_UNSET`). A procedure section
   adds its own. Procedures 1 and 6 run a population-level check that can FAIL
   even when the sampled population is empty, and each says when its
   population counts as empty.
2. **FAIL** when at least one sampled unit is an EXCEPTION, or a
   population-level check raised one.
3. **INCONCLUSIVE** when at least one sampled unit is UNTESTABLE
   (`ITEM_UNTESTABLE`).
4. **PASS** otherwise. A PASS is written as
   `populationCount > 0 && tested === sampleSize && exceptions === 0`, never as
   `exceptions === 0` alone, because that is also true of nothing.

An empty population can never pass. The three conclusions map one to one onto
`TestResult` (`PASS`, `FAIL`, `INCONCLUSIVE`). The runner's `isAttestingVerdict`
(`src/app-layer/usecases/control/test-plans.ts`) treats only PASS and FAIL as
attesting, so an INCONCLUSIVE run does not stamp `Control.lastTested`. This is
the disposition `agenticControlTestHandler` in
`src/app-layer/services/agent-control-tests.ts` already uses for an empty
population.

### Exceptions

Every exception becomes one finding proposal, raised by the auditor agent
through the `propose_finding` tool (`src/lib/mcp/tools/propose-tools.ts`). A
person decides each proposal. Nothing in a procedure closes, edits or resolves a
finding; a workpaper links findings and never closes one.

### What a workpaper records

One workpaper per procedure and period: the procedure id and catalogue version,
the period label, the population definition as written here, the population
count and digest, the epoch, the seed fingerprint, the sample size and the
sampled ids, the
parameters, each sampled unit's outcome code, the exceptions, the conclusion
with its basis code, and references to the evidence and finding proposals.

Every fact on a workpaper is a code, an identifier or a count. It carries no
names, no e-mail addresses, no tool arguments and no proposal payloads. This is
the digest discipline `src/app-layer/services/agent-control-tests.ts` states for
the agentic control tests, and for the same reason: a workpaper is evidence, and
evidence is kept long after the rows it describes.

The record is `AuditWorkpaper` (`prisma/schema/audit-workflow.prisma`), written
through `recordAuditWorkpaper` and checked against the contract in
`src/lib/agentic/audit-workpaper.ts`. Each run of a procedure for a period
writes one. The database holds the rules above: a PASS needs a non-empty
population, a drawn sample and no exception; the first workpaper that drew a
sample for a procedure and period fixes it, and a different sample is refused;
every column is fixed at insert apart from a review stamp set once. Findings are
linked through `AuditWorkpaperFinding`, which is insert-only, and nothing on the
workpaper's path writes a finding.

### Two facts about the runner a handler must respect

- `runnerHandlerRegistry` in `src/app-layer/jobs/control-test-runner.ts` holds
  one handler per automation type and throws on a second registration. The
  `INTEGRATION` slot is held by `agenticControlTestHandler`, which declines any
  plan whose `automationConfig` names none of its checks.
- On an automated FAIL the runner itself creates one `Finding` linked through
  the run's evidence. This catalogue raises one finding proposal per exception.
  Step `3c` decided how the two combine: a procedure handler returns
  `findingsRaisedAs: 'PROPOSALS'`, and the runner writes no `Finding` of its
  own for that run. A FAIL still stamps `Control.lastTested`.

---

## 1. Leaver timeliness: `iam.leaver_timeliness` (library v1)

Was every directory account of a person who left disabled within the leaver
window?

| | |
|---|---|
| Control identifiers | ISO/IEC 27001:2022 A.5.16, A.5.18, A.6.5 · SOC 2 CC6.1 · NIS2 Art. 21(2)(i) |
| Provider methodology reference | Open: the provider supplies it, recorded on #3663 when given |
| Period and moment | UTC calendar month · `OVER_WINDOW` |
| Unit | one `Employee` row |
| Parameter | `leaverWindowHours`: the longest acceptable time from `Employee.endDate` to the account being disabled. Set by the second line and recorded on the workpaper |

**Population.** Rows in `Employee` for this tenant with `status = TERMINATED`
and `endDate` inside the period. For each such employee, the accounts considered
are the `ConnectedIdentityAccount` rows reached through an `IdentityAccountLink`
on `employeeId` with `contradictedAt IS NULL`, together with any
`ConnectedIdentityAccount` whose `email` equals the employee's `workEmail`
ignoring case (the join the personnel check `offboarded_access_removed` in
`src/app-layer/integrations/providers/personnel/checks.ts` uses).

- **Includes:**
  - employees the HRIS feed marked `TERMINATED`, and employees the departure
    reconcile in `src/app-layer/usecases/hris-sync.ts` marked `TERMINATED`,
    whenever `endDate` is set;
  - accounts on every enabled identity connection (`okta`, `google-workspace`,
    `entra-id`, `active-directory`), whether or not Inflect can write to that
    directory. The timeliness obligation does not depend on who disables the
    account;
  - accounts with `isProtected = true`. Protection explains why the leaver pass
    skipped an account; it does not make lingering access timely.
- **Excludes:**
  - `TERMINATED` employees with `endDate IS NULL`. They cannot be placed in a
    period. The departure reconcile sets the status and leaves the end date
    as it was, so such rows exist; they are covered by the population-level check
    below rather than dropped, and that check can FAIL the procedure on its own;
  - `OFFBOARDING` employees, whose departure has not reached its end date;
  - accounts on connections with `isEnabled = false`, which no sync observes.
    Their count is a scope limit on the workpaper;
  - links with `contradictedAt` set, which no longer tie the account to the
    person. Their count is reported;
  - legacy-application accounts. No `LegacyAccount` is linked to an `Employee`
    through `IdentityAccountLink`; a leaver with live legacy access is a finding
    on the legacy recertification campaign (`src/lib/legacy-access/findings.ts`);
  - Inflect's own `TenantMembership` rows.

**Sample.** Keyed sample of employees, epoch `iam.leaver_timeliness@YYYY-MM`.

**Attributes tested.** For every account considered for a sampled employee:

| Id | Attribute | Raw rows read | Outcome when not met |
|---|---|---|---|
| L1 | The account is not `ACTIVE` | `ConnectedIdentityAccount.status` | EXCEPTION `LEAVER_ACCOUNT_ACTIVE` |
| L2 | The disable has a recorded time | `IdentityWriteJournal` with `action = DISABLE_ACCOUNT` and `outcome = APPLIED`, matched on `linkId`, or on `provider` and `externalUserId` when `linkId` is null; the time is `settledAt` | UNTESTABLE `DISABLE_TIME_UNKNOWN` when the account is disabled and no such row exists; UNTESTABLE `WRITE_OUTCOME_UNKNOWN` when the only row is `PENDING` or `INDETERMINATE` |
| L3 | The disable was inside the window | `settledAt − Employee.endDate ≤ leaverWindowHours` | EXCEPTION `LEAVER_DISABLED_LATE` |

**Population-level check.** Every `Employee` with `status = TERMINATED` and
`endDate IS NULL` whose considered accounts include one that is `ACTIVE` is an
exception, `LEAVER_ACCOUNT_ACTIVE_UNDATED`. A person HR has marked as gone and
who still holds an active account is an exception whatever the date.

This check runs on every run, whatever the dated population holds, and an
exception it raises makes the procedure FAIL even in a month with no dated
leaver. The population counts as empty (`EMPTY_POPULATION`) only when there is
no dated leaver **and** no undated leaver holds an `ACTIVE` account. This
matters because the departure reconcile in `hris-sync.ts` sets
`status = TERMINATED` and leaves `endDate` as it was, usually null: a tenant
whose departures arrive that way may have no dated leavers, and without this
rule its procedure would be
INCONCLUSIVE every month while a person HR has marked as gone still held an
active account.

**Re-performance.** Recomputes, from `Employee`, `IdentityAccountLink`,
`ConnectedIdentityAccount`, `IdentityWriteJournal` and `IntegrationExecution`,
whether each leaver's accounts were disabled and when. It does not read the
leaver pass's `IntegrationExecution.resultJson`, the personnel check's
`CheckResult`, or any count the leaver pass logged.

**Exception.** A leaver's account still `ACTIVE`; an account disabled later than
`leaverWindowHours` after `endDate`; or an undated leaver with an `ACTIVE`
account.

**INCONCLUSIVE when**, besides the common preconditions:

- an identity connection holding a considered account has no
  `IntegrationExecution` for that `connectionId` with
  `automationKey = '<provider>.sync'` and `status = PASSED`, completed within
  `OBSERVATION_FRESHNESS_MS` (two days,
  `src/app-layer/usecases/identity-write-target.ts`) of the run
  (`SYNC_NOT_FRESH`). An `ACTIVE` or non-`ACTIVE` reading from a stale mirror
  proves nothing;
- a sampled leaver is UNTESTABLE. The usual cause is an account disabled by a
  person in the directory: the mirror records that it is disabled, not when.

---

## 2. Recertification completeness: `iam.recertification_completeness` (library v1)

Was every population that must be recertified covered in the period by a
complete, closed campaign whose revocations took effect?

| | |
|---|---|
| Control identifiers | ISO/IEC 27001:2022 A.5.18 · SOC 2 CC6.1 · NIS2 Art. 21(2)(i) |
| Provider methodology reference | Open: the provider supplies it, recorded on #3663 when given |
| Period and moment | UTC calendar quarter · units `AS_OF_GENERATION`, campaigns `OVER_WINDOW` |
| Unit | one review population |
| Parameter | `remediationWindowDays`: how long after a campaign closes a revoked account may stay active. Set by the second line and recorded on the workpaper |

**Population.** The review populations of this tenant, one unit each:

- **memberships**: one unit, present when at least one row in
  `TenantMembership` for this tenant has `status = ACTIVE`;
- **each identity connection**: one unit per `IntegrationConnection` with
  `isEnabled = true` and `provider` in (`okta`, `google-workspace`, `entra-id`,
  `active-directory`) that holds at least one `ConnectedIdentityAccount` with
  `status = ACTIVE`;
- **each legacy application**: one unit per `IntegrationConnection` with
  `isEnabled = true` and `provider = 'legacy-mcp'` that holds at least one
  `LegacyAccessSnapshot` with `status = COMPLETE`.

A unit's **covering campaign** is the `AccessReview` with `deletedAt IS NULL`,
`status = CLOSED` and `closedAt` inside the period, with the latest `closedAt`,
whose decision rows reach the unit:

- memberships: `scope = ALL_USERS`, decisions in `AccessReviewDecision`;
- identity connection: `scope = CONNECTED_APP`, with at least one
  `AccessReviewConnectedDecision` whose `connectedAccountId` resolves to a
  `ConnectedIdentityAccount` of that connection;
- legacy application: `scope = LEGACY_APP`, with at least one
  `AccessReviewConnectedDecision` whose `subjectRef` starts with
  `<connectionId>:`.

- **Includes:** directories Inflect cannot write to (`okta`,
  `google-workspace`), because recertification does not depend on write-back;
  every legacy application with a complete snapshot.
- **Excludes:**
  - disabled connections, and connections holding no `ACTIVE` account: there is
    nothing to certify;
  - HRIS connections, which hold employees rather than access;
  - `ADMIN_ONLY` and `CUSTOM` campaigns as cover for the memberships unit.
    Neither covers the whole population. `ADMIN_ONLY` campaigns count towards
    procedure 4;
  - registered agents. Step `3a` (#3674) added the `AGENT` value to
    `AccessReviewScope`; catalogue version 1 does not test agent campaigns.

**Sample.** The whole population, drawn in keyed order with epoch
`iam.recertification_completeness@YYYY-Qn`. The units are bounded by the number
of connections, so a sample of 10% would usually test one unit and leave the
rest of the claim unexamined.

**Attributes tested.** For each unit and its covering campaign:

| Id | Attribute | Raw rows read | Outcome when not met |
|---|---|---|---|
| R1 | A covering campaign exists | `AccessReview` and its decision rows, as above | EXCEPTION `NOT_RECERTIFIED_IN_PERIOD` |
| R2 | The campaign is non-empty and fully decided: `subjectCount > 0 && decided === subjectCount`, where `decided` counts rows with `decision IS NOT NULL` and `decidedAt IS NOT NULL` | `AccessReviewDecision` or `AccessReviewConnectedDecision` rows of the campaign | EXCEPTION `CAMPAIGN_INCOMPLETE` |
| R3 | The campaign covered its whole population | `AccessReview.snapshotTruncated = false` | EXCEPTION `CAMPAIGN_TRUNCATED` |
| R4 | The campaign closed on time | `dueAt IS NULL` or `closedAt ≤ dueAt` | EXCEPTION `CLOSED_AFTER_DUE` |
| R5 | Nobody decided their own access | memberships: no row with `decidedByUserId = subjectUserId`; connected and legacy: no row whose `decidedByUserId` resolves to a `User` whose `email` equals `snapshotJson.email` ignoring case | EXCEPTION `SELF_REVIEW` |
| R6 | Revocations took effect | memberships: each `REVOKE` row's `TenantMembership` (`membershipId`) is absent or has a `status` other than `ACTIVE`, and each `MODIFY` row's membership has `role = modifiedToRole` (and `customRoleId = modifiedToCustomRoleId` when that is set); the `AuditLog` row with `action = ACCESS_REVIEW_DECISION_EXECUTED`, `entity = 'AccessReviewDecision'` and `entityId` = the decision is reported beside it, because its `detailsJson.after.outcome` (`EXECUTED`, `SKIPPED_STALE`, `SKIPPED_LAST_OWNER`) says what the close did; identity connection: each `REVOKE` row's `ConnectedIdentityAccount` is not `ACTIVE` today, provided the connection's latest sync with `status = PASSED` completed more than `remediationWindowDays` after `closedAt`; legacy: each `REVOKE` row's account (`snapshotJson.accountKey`) is not `ACTIVE` in the first `COMPLETE` `LegacyAccessSnapshot` of that connection completed more than `remediationWindowDays` after `closedAt` | EXCEPTION `REVOCATION_NOT_EXECUTED` for a membership, `REVOKED_ACCESS_STILL_ACTIVE` for a connected or legacy account; UNTESTABLE `NO_OBSERVATION_AFTER_CLOSE` when no such sync or snapshot exists |
| R7 | The close produced its evidence | `AccessReview.evidenceFileRecordId IS NOT NULL` | EXCEPTION `EVIDENCE_NOT_GENERATED` |

Two facts behind R2 and R6. `closeConnectedAccessReview` refuses a campaign with
zero decision rows and one with pending rows; `closeAccessReview`, the
membership close, refuses pending rows and has no zero-row guard of its own
(its creation refuses an empty scope). And on every scope `executedAt` is a
close-out stamp, not evidence that access changed. The membership close stamps
it on every decided row "regardless of outcome": that includes
`SKIPPED_STALE`, where the membership was already gone, and
`SKIPPED_LAST_OWNER`, where the last-owner trigger refused the change and the
membership is unchanged. On a connected or legacy campaign the revocation itself
is a remediation `Task` with no structured link back to the decision. So R6
checks the access's own state on every scope (the membership row, the
directory mirror, the legacy snapshot) and never the stamp.

**Re-performance.** Recounts subjects and decisions from the decision rows.
Re-reads account state from the mirror and the legacy snapshots. It does not
read the `snapshotCount` in the creation audit row, the `executed` count in the
close audit row, or the evidence PDF. A `MODIFY` decision on a connected or
legacy account is reported as a count: the change it asks for has no structured
field to compare.

**Exception.** A population with no complete closed campaign in the quarter, or
a covering campaign that was empty, partly decided, truncated, late,
self-reviewed or unexecuted, whose revocations did not take effect, or that
produced no evidence. Zero campaigns closed in a quarter in which populations exist is a
FAIL: it is the control not operating.

**INCONCLUSIVE when**, besides the common preconditions: a unit is UNTESTABLE,
usually because no sync or snapshot has completed since the remediation window
ended.

---

## 3. Time-bounded access expiry: `iam.time_bounded_access_expiry` (library v1)

Did every time-bounded grant Inflect made end when it said it would?

| | |
|---|---|
| Control identifiers | ISO/IEC 27001:2022 A.5.15, A.5.18 · SOC 2 CC6.1 · OWASP ASI03 |
| Provider methodology reference | Open: the provider supplies it, recorded on #3663 when given |
| Period and moment | UTC calendar month · `OVER_WINDOW` |
| Unit | one `ExternalWriteJournal` row |
| Settle margin | 24 hours, fixed by this catalogue: the procedure runs no earlier than 24 hours after the period ends, so a grant ending in the period's last minute has been through the expiry sweep |

**Population.** Rows in `ExternalWriteJournal` for this tenant with
`advertisedToolName` in the keys of `GRANT_EXPIRY_ARGS`
(`src/app-layer/usecases/external-write-reconcile.ts`; today the one key
`grant_time_bounded_access`), `outcome` in (`APPLIED`, `ACCEPTED`,
`INDETERMINATE`), and an end date inside the period. The end date is the
argument `GRANT_EXPIRY_ARGS` names (`endDateTime`) inside `argumentsJson`. Rows
whose end date cannot be parsed, or lies more than `MAX_GRANT_DAYS` after
`attemptedAt`, belong to the period of their `attemptedAt` instead, so a grant
that breached its bound is still tested once.

`argumentsJson` is encrypted at rest, so the filter on it runs in memory, as it
does in `verifyGrantExpiry`. The handler reads the rows with `attemptedAt` from
`MAX_GRANT_DAYS` (90) days before the period start to the period end, which
holds every row either rule can place in the period.

- **Includes:**
  - `APPLIED` grants, delivered;
  - `ACCEPTED` grants: the far end took the request and delivery was never
    confirmed, so the grant may be live;
  - `INDETERMINATE` grants: the send did not report back, so the grant may be
    live;
  - grants proposed by any agent, or by none.
- **Excludes:**
  - `FAILED` rows: the far end proved it changed nothing;
  - `RECORDED_ONLY` rows: a dry run sent nothing;
  - `PENDING` rows: nothing was sent;
  - grants made outside Inflect, which have no journal row;
  - `LegacyAccount.expiresAt`, which is the observed state of a third-party
    application, not a grant Inflect made. No procedure in this version tests
    it; it is listed under gaps;
  - write tools absent from `GRANT_EXPIRY_ARGS`. The workpaper lists the keys
    the run used, so a new grant tool missing from the map is visible.

**Sample.** Keyed sample of journal rows, epoch
`iam.time_bounded_access_expiry@YYYY-MM`.

**Attributes tested.**

| Id | Attribute | Raw rows read | Outcome when not met |
|---|---|---|---|
| T1 | The grant was bounded: the end date parses and `endDateTime − attemptedAt ≤ MAX_GRANT_DAYS` | `argumentsJson`, `attemptedAt`; `MAX_GRANT_DAYS` from `src/app-layer/integrations/providers/entra-id/entitlement.ts` | EXCEPTION `END_DATE_UNREADABLE` or `GRANT_UNBOUNDED` |
| T2 | Delivery is known | `outcome = APPLIED` | UNTESTABLE `DELIVERY_UNCONFIRMED` for `ACCEPTED` and `INDETERMINATE`: `verifyGrantExpiry` reads `APPLIED` rows only, so nothing has checked these |
| T3 | The grant ended and nothing ever saw it live past its end date | `expiryVerifiedAt IS NOT NULL` and `expiryRaisedAt IS NULL` | EXCEPTION `GRANT_OUTLIVED_WINDOW` when `expiryRaisedAt` is set, whatever happened later; UNTESTABLE `EXPIRY_NOT_OBSERVED` when both are null |
| T4 | An outlived grant was followed up | for a row with `expiryRaisedAt` set: a `Task` with `source = GRANT_EXPIRY` whose `metadataJson.externalWriteJournalId` is the row id | EXCEPTION `OUTLIVED_GRANT_NOT_TASKED` |

**Re-performance.** Re-parses the end date from `argumentsJson` and recomputes
the bound against `MAX_GRANT_DAYS`. It never reads the `endDateTime` or
`overdueDays` copied into the task's `metadataJson`. It does not query the
directory again: it relies on the journal's expiry columns, which
`verifyGrantExpiry` stamps only on a positive read. `expiryVerifiedAt` is the
time the sweep saw the grant gone, not the time it ended, so this procedure
tests that the grant ended, not to the minute when.

**Exception.** A grant with no readable or acceptable bound; a grant the
directory reported as live after its end date; or such a grant with no
remediation task.

**INCONCLUSIVE when**, besides the common preconditions: the run is inside the
settle margin (`PERIOD_NOT_SETTLED`); or a sampled grant is UNTESTABLE. An
empty population is the common case for a tenant that makes no time-bounded
grants, and it is INCONCLUSIVE, never a PASS.

---

## 4. Privileged access: `iam.privileged_access` (library v1)

Is every privileged account attributable to a current person or a recorded
break-glass decision, protected by MFA where the signal exists, and recertified
within the interval?

| | |
|---|---|
| Control identifiers | ISO/IEC 27001:2022 A.5.18, A.8.2, A.8.5 · SOC 2 CC6.1 · NIS2 Art. 21(2)(i), Art. 21(2)(j) |
| Provider methodology reference | Open: the provider supplies it, recorded on #3663 when given |
| Period and moment | UTC calendar quarter · `AS_OF_GENERATION` (the mirror holds current state) |
| Unit | one `ConnectedIdentityAccount` row, or one `TenantMembership` row |

**Population.** Two sub-populations, each sampled on its own:

- **directory**: rows in `ConnectedIdentityAccount` for this tenant with
  `isAdmin = true` and `status = ACTIVE`, on a connection with
  `isEnabled = true`;
- **membership**: rows in `TenantMembership` for this tenant with `role` in
  (`OWNER`, `ADMIN`) and `status = ACTIVE`.

- **Includes:** break-glass accounts (`isProtected = true`); accounts of every
  identity provider; `OWNER` and `ADMIN` memberships provisioned by an
  organisation (`provisionedByOrgId` set).
- **Excludes:**
  - memberships whose privilege comes from a `TenantCustomRole` over a lower
    base role. A custom role is a set of permission flags, not a role, and v1
    does not classify it;
  - legacy accounts with `isPrivileged = true`. Privilege there is a finding on
    the legacy recertification campaign;
  - registered agents, whose authority procedure 5 tests;
  - service principals, which the mirror does not hold.

**A limit on the directory sub-population.**
`src/app-layer/usecases/identity-sync.ts` stores `isAdmin` and `mfaEnrolled` as
`a.isAdmin ?? false` and `a.mfaEnrolled ?? false`. A provider returns `null`
when it could not determine the signal: Okta and Entra when their enrichment
read fails; Okta also for every account beyond its 2,000-account enrichment cap
(`MAX_ENRICH` in `src/app-layer/integrations/providers/okta/index.ts`); and
Active Directory for MFA always. So a stored `false` means "no" or "not
determined", and in an Okta tenant of more than 2,000 accounts it means "not
determined" for every account past the cap. The directory sub-population is
therefore a lower bound, and a `false` MFA reading is evidence only where the
provider always determines it.

**Sample.** Keyed sample of each sub-population, epochs
`iam.privileged_access@YYYY-Qn/directory` and
`iam.privileged_access@YYYY-Qn/membership`.

**Attributes tested, directory.**

| Id | Attribute | Raw rows read | Outcome when not met |
|---|---|---|---|
| PD1 | Attributable: an `IdentityAccountLink` with `contradictedAt IS NULL` to an `Employee` whose `status` is not `TERMINATED` or `OFFBOARDING`; or `isProtected = true` with `protectionReason` set | `IdentityAccountLink`, `Employee`, `ConnectedIdentityAccount` | EXCEPTION `PRIVILEGED_UNATTRIBUTED`, or `PRIVILEGED_HOLDER_DEPARTING` when the linked employee is leaving or gone |
| PD2 | MFA enrolled | `ConnectedIdentityAccount.mfaEnrolled` | EXCEPTION `PRIVILEGED_WITHOUT_MFA` for `google-workspace`, whose provider always determines the signal; UNTESTABLE `MFA_SIGNAL_AMBIGUOUS` for a `false` reading on `okta` or `entra-id`; not applicable on `active-directory`, whose provider reports no MFA signal |
| PD3 | Recertified within 90 days before the period end | an `AccessReviewConnectedDecision` with `connectedAccountId` = the account and `decision IS NOT NULL`, in an `AccessReview` with `scope = CONNECTED_APP`, `status = CLOSED` | EXCEPTION `PRIVILEGE_NOT_RECERTIFIED` |

**Attributes tested, membership.**

| Id | Attribute | Raw rows read | Outcome when not met |
|---|---|---|---|
| PM1 | Recertified within 90 days before the period end | an `AccessReviewDecision` with `membershipId` = the membership and `decision IS NOT NULL`, in an `AccessReview` with `scope` in (`ALL_USERS`, `ADMIN_ONLY`), `status = CLOSED` | EXCEPTION `PRIVILEGE_NOT_RECERTIFIED` |
| PM2 | The holder is not leaving | an `Employee` whose `workEmail` equals the member's `User.email` ignoring case | EXCEPTION `PRIVILEGED_HOLDER_DEPARTING` when that employee is `TERMINATED` or `OFFBOARDING`; not applicable when no employee matches (auditors and contractors are often outside the HR roster), counted on the workpaper |

Inflect's own MFA enrolment (`UserMfaEnrollment`) is not an attribute in v1. It
does not see MFA performed by a federated identity provider, so its absence is
not evidence.

**Re-performance.** Reads the raw flags and joins. It does not read the
identity providers' `CheckResult` for their MFA or admin checks, or any
`IntegrationExecution.resultJson`.

**Exception.** A privileged account or membership that is unattributed, held by
someone leaving, without MFA on a provider that reports it, or not recertified
within 90 days.

**INCONCLUSIVE when**, besides the common preconditions (here: both
sub-populations empty):

- a connection in the directory sub-population fails the sync freshness rule of
  procedure 1 (`SYNC_NOT_FRESH`);
- an enabled identity connection holds `ACTIVE` accounts and no account with
  `isAdmin = true` (`ADMIN_SIGNAL_ABSENT`). A directory with users and no
  administrators is far more likely an undetermined reading stored as `false`
  than a fact;
- a sampled unit is UNTESTABLE.

---

## 5. Agent authority conformance: `agent.authority_conformance` (library v1)

Did every tool an agent used sit inside the authority approved for it at the
time: a grant, a policy card that permits the tool, and an active registration?

| | |
|---|---|
| Control identifiers | OWASP ASI02, ASI03 · ISO/IEC 27001:2022 A.5.15, A.8.2 · ISO/IEC 42001 A.9.4 · SOC 2 CC6.1 |
| Provider methodology reference | Open: the provider supplies it, recorded on #3663 when given |
| Period and moment | UTC calendar month · `OVER_WINDOW` |
| Unit | one `AgentBehaviourWindow` row: one agent, one hour, the authorised calls in it |

This is a test of conduct. The existing control test
`AGENTIC_POLICY_CARD_CONFORMANCE` (`src/app-layer/services/agent-control-tests.ts`)
tests state: whether each card's head version still sits inside its agent's
declaration. This procedure tests what the agents did.

**Population.** Rows in `AgentBehaviourWindow` for this tenant with
`windowStart` inside the period, whose `RegisteredAgent` has
`isLegacyPlaceholder = false`. A row is written by `observeToolCall`
(`src/lib/agentic/circuit-breaker-store.ts`) at the end of `authorizeToolCall`
(`src/lib/mcp/authorize.ts`), after every gate has passed, so each row records
authorised calls only.

- **Includes:**
  - windows of agents since suspended, retired or soft-deleted: the calls
    happened;
  - every capability class (`readCalls`, `proposeCalls`, `orchestrateCalls`);
  - calls from the workflow engine and from external MCP clients alike, since
    both pass `authorizeToolCall`.
- **Excludes:**
  - refused calls. They are `AuditLog` rows with `action = AUTHZ_DENIED` and
    `detailsJson.gate = 'mcp_tool_invocation'`: the boundary working, not
    authority exercised. Their count is reported;
  - calls by a credential bound to no registered agent, which write no window.
    The count of `MCP_TOOL_INVOKED` rows with `detailsJson.agentId` null in the
    period is reported;
  - the kill-switch drill's canary, which makes no tool call.

**How `main` reads this version.** Two readings of version 1, made by step
`3c` and confirmed by the repository owner on 2026-10-19, are not changes to
the catalogue and are recorded here for internal audit. The windows of agents
marked `isAuditor` are excluded and their count is reported (rule 8: the
auditor is not the auditee); the check on the auditor's own conduct is
internal audit's sampling of its workpapers, step `3d` (#3677). And A1 and A4
are asked at each per-call record in the hour, and over the whole hour only
when the hour has none.

**Sample.** Keyed sample of windows, epoch `agent.authority_conformance@YYYY-MM`.

**Attributes tested.** For every tool name in a sampled window's `toolNames`:

| Id | Attribute | Raw rows read | Outcome when not met |
|---|---|---|---|
| A1 | The agent held a grant for the tool for the whole hour | current `RegisteredAgentTool` rows, and `AuditLog` rows with `entity = 'RegisteredAgent'`, `entityId` = the agent and `action` in (`AGENT_TOOL_GRANTED`, `AGENT_TOOL_REVOKED`), whose `detailsJson.after.toolName` or `detailsJson.before.toolName` names the tool. `agent-tool-exposure.ts` is the only writer of grants | EXCEPTION `TOOL_NOT_GRANTED` |
| A2 | The card version in force permitted the tool | the per-call record of the version that allowed the call: for a read tool, `AuditLog` rows with `action = MCP_TOOL_INVOKED` for the agent and tool inside the hour (`detailsJson.policyCardVersion`); for a propose tool, the `AgentProposal` rows the agent created inside the hour with that tool's `kind` (`policyCardVersion`). The version resolves to the `AgentPolicyCardVersion` of the agent's `AgentPolicyCard`, and the tool must be in its `permittedTools` | EXCEPTION `TOOL_NOT_ON_CARD`; EXCEPTION `NO_CARD_IN_FORCE` when the version is null; UNTESTABLE `INVOCATION_UNRECORDED` when the tool has no per-call record in the hour |
| A3 | That card version could exercise the tool | `withholdingReasonForTool` (`src/lib/agentic/policy-card-evaluation.ts`) over the version's `maxDataScope` and `maxAutonomyLevel` returns null. It is evaluated against the tool catalogue the build carries at run time | EXCEPTION `TOOL_UNEXERCISABLE`; UNTESTABLE `TOOL_NOT_IN_CURRENT_CATALOGUE` when it returns `NOT_IN_CATALOGUE`, because a tool a later deploy removed was valid when it was called |
| A4 | The agent was `ACTIVE` for the hour | `AuditLog` rows with `entity = 'RegisteredAgent'` and `action` in (`AGENT_ACTIVATED`, `AGENT_SUSPENDED`, `AGENT_RETIRED`) | EXCEPTION `AGENT_NOT_ACTIVE` |
| A5 | The window is the complete record | `readCalls` is at least the number of `MCP_TOOL_INVOKED` rows for the agent in the hour | UNTESTABLE `WINDOW_UNDERCOUNTS` |

The window is written before the tool runs; the per-call records are written
after it. `MCP_TOOL_INVOKED` is written by the read-tool path in
`src/lib/mcp/tools/registry.ts`, after the tool runs and best-effort. A propose
call writes no `MCP_TOOL_INVOKED` row; its record is the proposal, which
`src/lib/mcp/tools/propose-tools.ts` pins with the card version the gate
authorised. So a call that was authorised and then threw, or whose audit write
failed, appears in the window and in no per-call record. That is why A2 can be
UNTESTABLE and why the window, not a per-call record, is the unit.

A window holds only Inflect's own MCP tools: `authorizeToolCall` is called from
`src/lib/mcp/tools/registry.ts` and `src/lib/mcp/tools/propose-tools.ts` and
nowhere else, so a tool an external MCP server supplies never reaches A3.
`withholdingReasonForTool` checks the name against the catalogue of the build
that runs the procedure, not the build that served the call. That is why a
`NOT_IN_CATALOGUE` answer is UNTESTABLE rather than an exception.

**Re-performance.** Rebuilds each agent's grant history and status history from
`AuditLog`, resolves the card version each call names, and re-applies
`withholdingReasonForTool`, the pure predicate the policy-card write path and
`AGENTIC_POLICY_CARD_CONFORMANCE` already use. It does not read
`AgentPolicyCard.actionsInWindow`, the circuit breaker's verdicts, or the
outcome of the `AGENTIC_POLICY_CARD_CONFORMANCE` control test.

**Exception.** A tool used without a grant, outside the card in force, under a
card that could not exercise it, with no card, or by an agent that was not
`ACTIVE`.

**INCONCLUSIVE when**, besides the common preconditions:

- the tenant's audit chain does not verify up to the period end
  (`verifyTenantChain` in `src/lib/audit/verify.ts`, `AUDIT_CHAIN_BROKEN`). The
  grant, status and invocation history are audit rows, and a broken chain means
  they cannot be relied on;
- a sampled window is UNTESTABLE.

---

## 6. Stop control: `agent.stop_control` (later)

Did the kill switch stop agents when it was engaged, and was it proven by drill
throughout the period?

**Why later.** The scheduled drill runs daily for every tenant with agents, and
the `AGENTIC_KILL_SWITCH_DRILL` control test already reads its outcome. The
re-performance of real kills needs a grace parameter (below) that has no agreed
value.

| | |
|---|---|
| Control identifiers | OWASP ASI08, ASI10 · ISO/IEC 27001:2022 A.5.26 · ISO/IEC 42001 A.6.2.6 |
| Provider methodology reference | Open: the provider supplies it, recorded on #3663 when given |
| Period and moment | UTC calendar month · `OVER_WINDOW` |
| Unit | one `AgentKillSwitchDrill` row, or one `AgentKillSwitch` row |
| Parameter | `killGraceSeconds`: how long after `engagedAt` a call authorised before the engagement may still complete. Set by the second line and recorded on the workpaper |

**Population.** Two sub-populations, each sampled on its own:

- **drills**: rows in `AgentKillSwitchDrill` for this tenant with `startedAt`
  inside the period;
- **kills**: rows in `AgentKillSwitch` for this tenant with `engagedAt` inside
  the period and `agentId` not equal to `KILL_SWITCH_DRILL_AGENT_ID`
  (`src/lib/agentic/kill-switch.ts`).

- **Includes:** drills of every outcome (`PASSED`, `FAILED`, `ERROR`); kills at
  agent scope and tenant scope (`agentId IS NULL`); kills since lifted.
- **Excludes:** `PlatformAgentKillSwitch` rows, which are global and have no
  tenant; the drill's canary kills, which are tested through their drill row;
  circuit-breaker trips (`AgentCircuitBreaker`), a separate stop control whose
  trip is re-derivable from `AgentBehaviourWindow` and is not catalogued here.

**Sample.** Keyed sample of each sub-population, epochs
`agent.stop_control@YYYY-MM/drills` and `agent.stop_control@YYYY-MM/kills`.

**Attributes tested.**

| Id | Attribute | Raw rows read | Outcome when not met |
|---|---|---|---|
| S1 | The drill's outcome recomputes: `PASSED` exactly when `scopesFailed` is empty, `scopesHonoured` holds every member of `KILL_SCOPES` (`PLATFORM`, `TENANT`, `AGENT`), `boundaryRefusalReason = 'agent_killed'` and `toolCallsAfterKill = 0` | `AgentKillSwitchDrill` | EXCEPTION `DRILL_FAILED`, or `DRILL_OUTCOME_MISRECORDED` when the stored outcome differs; UNTESTABLE `DRILL_ERRORED` for `ERROR`, which proves nothing |
| S2 | The drill lifted its canary | the `AgentKillSwitch` row with `agentId = KILL_SWITCH_DRILL_AGENT_ID` engaged between the drill's `startedAt` and `completedAt` has `liftedAt` set | EXCEPTION `CANARY_NOT_LIFTED` |
| S3 | A failed drill raised a finding | `AgentKillSwitchDrill.findingId` on a `FAILED` drill | EXCEPTION `DRILL_FAILURE_NOT_RAISED` |
| S4 | Nothing got through the kill | for the killed agent (any agent, for a tenant-wide kill), over the interval from `engagedAt + killGraceSeconds` to `liftedAt`, or to the run when unlifted: no `AuditLog` row with `action = MCP_TOOL_INVOKED`, no `AgentProposal` created, and no `AgentBehaviourWindow` whose whole hour lies inside the interval | EXCEPTION `TOOL_CALL_DURING_KILL` |
| S5 | The lift is attributed | a lifted kill has `liftedByUserId` and `liftReason` set | EXCEPTION `LIFT_UNATTRIBUTED` |

**Population-level check.** While the tenant has a `RegisteredAgent` with
`deletedAt IS NULL` and `isLegacyPlaceholder = false`, no gap between
consecutive drills in the period, or from the period start to the first drill,
exceeds 48 hours (`DEFAULT_DRILL_MAX_AGE_HOURS` in
`src/app-layer/services/agent-control-tests.ts`). A longer gap is an exception,
`DRILL_CADENCE_GAP`. A tenant with agents and no drill in the period therefore
FAILs; it is not an empty population.

**Re-performance.** Recomputes each drill's outcome from its component columns,
and each real kill's effect from the invocation audit rows, the proposals and
the behaviour windows. The count of `AUTHZ_DENIED` rows with
`detailsJson.reason = 'agent_killed'` inside a kill is reported as a fact. It
does not read the outcome of the `AGENTIC_KILL_SWITCH_DRILL` control test or the
`incidents.*` report figures.

**Exception.** A failed or misrecorded drill, an unlifted canary, an unraised
drill failure, a tool call during a kill, an unattributed lift, or a drill gap.

**INCONCLUSIVE when**, besides the common preconditions: the audit chain does
not verify (`AUDIT_CHAIN_BROKEN`); or a sampled unit is UNTESTABLE. Here the
population counts as empty only when both sub-populations are empty and the
tenant has no registered agent. With an agent registered and no drill, the
cadence check runs and the procedure FAILs.

---

## 7. Approval quality: `agent.approval_quality` (later)

Did every approval of an agent proposal meet its four-eyes requirement inside
its review window, by people independent of the proposing credential, and did
the retrospective sample concur?

**Why later.** ASI09 already has the retrospective sampler
(`src/app-layer/jobs/agent-proposal-sample-audit.ts`), the review-quality report
and the `AGENTIC_REVIEW_QUALITY` control test. This procedure re-performs across
them, and it is more useful once library v1 has run.

| | |
|---|---|
| Control identifiers | OWASP ASI09 · EU AI Act Art.14 · ISO/IEC 27001:2022 A.5.3 · ISO/IEC 42001 A.9.2 |
| Provider methodology reference | Open: the provider supplies it, recorded on #3663 when given |
| Period and moment | UTC calendar month · `OVER_WINDOW` |
| Unit | one `AgentProposal` row |

**Population.** Rows in `AgentProposal` for this tenant with `status` in
`APPROVED_STATUSES` (`ACCEPTED`, `EDITED`) and `reviewedAt` inside the period.

- **Includes:** `EDITED` approvals; every proposal kind, `EXTERNAL_WRITE`
  included; proposals with no agent (`agentId IS NULL`) and those adopted by the
  legacy placeholder.
- **Excludes:** `PENDING`, `REJECTED`, `EXPIRED` and `QUARANTINED` proposals,
  which nobody approved.

**Sample.** Keyed sample of proposals, epoch `agent.approval_quality@YYYY-MM`.

**Attributes tested.**

| Id | Attribute | Raw rows read | Outcome when not met |
|---|---|---|---|
| Q1 | Four eyes: distinct `approverUserId` over `AgentProposalApproval` rows with `outcome` in (`ACCEPTED`, `EDITED`) is at least `requiredApprovals`, a null read as `UNKNOWN_REQUIREMENT_APPROVALS` (2, `src/lib/agentic/approval-tiering.ts`) | `AgentProposal`, `AgentProposalApproval` | EXCEPTION `APPROVALS_BELOW_REQUIREMENT` |
| Q2 | Inside the window: `expiresAt IS NULL`, or `reviewedAt` and every counted approval's `createdAt` are at or before `expiresAt` | `AgentProposal`, `AgentProposalApproval` | EXCEPTION `APPROVED_AFTER_WINDOW` |
| Q3 | Not quarantined | `guardVerdict` is not `QUARANTINED` | EXCEPTION `QUARANTINED_PROPOSAL_APPROVED` |
| Q4 | The agent's owner did not sign where two signatures were required: when the requirement (a null read as 2) is at least 2, no counted approver is `RegisteredAgent.ownerUserId` | `AgentProposal`, `AgentProposalApproval`, `RegisteredAgent` | EXCEPTION `OWNER_APPROVED_OWN_AGENT` |
| Q5 | No approver is the human the proposing credential speaks for | `proposedViaKeyId` resolved to `TenantApiKey.createdById`; not applicable when `proposedViaKeyId` is null | EXCEPTION `APPROVER_IS_PRINCIPAL` |
| Q6 | The retrospective review, where one was drawn, concurred | `AgentProposalSampleAudit.outcome` | EXCEPTION `SAMPLE_AUDIT_DISSENTED`, carrying its `dissentCodes`; a `PENDING` or absent audit is a fact |

Q4 is also enforced in the database: the trigger
`agent_proposal_approval_four_eyes_trg`, running the function
`agent_proposal_approval_four_eyes()` (migration
`20260906120000_agent_proposal_approval`) refuses the owner as an approver when
two or more are required. The count in Q1 is checked by the approve usecase in
`src/app-layer/usecases/agent-proposals.ts`, which also refuses any approval
made through an API key. Neither compares an approver with the proposing
credential's creator; Q5 tests that as segregation of duties. The procedure
re-checks all three from the rows.

**Re-performance.** Recounts approvals from `AgentProposalApproval`. It does not
read the `approvals.*` report figures or the automation-bias engine's signals.

**Exception.** An approval short of its requirement, outside its window, of a
quarantined proposal, signed by the agent's owner where two signatures were
required, signed by the credential's own principal, or one a retrospective
reviewer dissented from.

**INCONCLUSIVE when** a common precondition fails or a sampled unit is
UNTESTABLE.

---

## 8. Evidence sufficiency: `assurance.evidence_sufficiency` (later)

Does the evidence filed against controls in the period show the control
operating, in the period, over a stated population, attributably and with
tamper evidence fit for its weight?

**Why later.** The first of the five tests, whether evidence shows the control
operating or only that it exists, is a judgement for evidence a person uploaded.
The `evidence_assessor` specialist (`src/lib/agentic/flue/subagents/index.ts`)
with the `evidence-sufficiency` skill holds read tools only: it can assess that
judgement and return it to the agent that delegated to it. Any proposal is
raised by that agent, or by the auditor through `propose_finding`, and a person
decides it. Library v1 is limited to procedures that re-perform from raw rows
alone.

| | |
|---|---|
| Control identifiers | ISO/IEC 27001:2022 A.5.35, A.5.36 · ISO/IEC 42001 7.5, 9.2 · SOC 2 CC4.1 |
| Provider methodology reference | Open: the provider supplies it, recorded on #3663 when given |
| Period and moment | UTC calendar quarter · `OVER_WINDOW` |
| Unit | one `EvidenceControlLink` row |

**Population.** Rows in `EvidenceControlLink` for this tenant whose `Evidence`
has `status = APPROVED`, `deletedAt IS NULL`, `isArchived = false` and
`dateCollected` inside the period.

- **Includes:** evidence of every type (`FILE`, `LINK`, `TEXT`); evidence the
  control-test runner wrote; evidence behind an `AgenticEvidenceArtefact`;
  evidence people uploaded.
- **Excludes:** `DRAFT`, `SUBMITTED`, `REJECTED` and `NEEDS_REVIEW` evidence;
  evidence linked only to risks or assets; evidence behind an
  `AgenticEvidenceArtefact` whose `status` is not `CURRENT` (withdrawn), counted
  on the workpaper.

**Sample.** Keyed sample of links, epoch
`assurance.evidence_sufficiency@YYYY-Qn`.

**Attributes tested.** The five tests in
`src/lib/agentic/flue/skills/evidence-sufficiency/SKILL.md`:

| Id | Test | Raw rows read | Outcome when not met |
|---|---|---|---|
| E1 | Operation: the evidence is a system record of an action | a `ControlTestEvidenceLink` to a `ControlTestRun` with `status = COMPLETED`; or an `AgenticEvidenceArtefact` naming the evidence; otherwise a judgement | UNTESTABLE `OPERATION_NEEDS_JUDGEMENT` until a person decides it; then EXCEPTION `SHOWS_EXISTENCE_ONLY` if they find against it |
| E2 | Period: the record it carries is inside the period | `ControlTestRun.executedAt`, or `AgenticEvidenceArtefact.periodStart` and `periodEnd` | EXCEPTION `OUT_OF_PERIOD` |
| E3 | Population: an artefact counted something, and its count recomputes | `AgenticEvidenceArtefact.recordCount > 0`; the source rows of the artefact's kind and period, recounted against `recordCount`; `sourceDigest` recomputed with `sourcePopulationDigest` (`src/lib/agentic/evidence-artefact.ts`) over the facts as they read at the run; not applicable to other evidence | EXCEPTION `ARTEFACT_EMPTY` or `RECORD_COUNT_MISMATCH`; a digest that differs is reported as a fact, `DIGEST_DRIFTED`, not as an exception |
| E4 | Attribution: an owner, and an approval by someone else | for evidence that is neither linked to a `ControlTestRun` nor named by an `AgenticEvidenceArtefact`: `Evidence.ownerUserId IS NOT NULL`, and an `EvidenceReview` with `action = APPROVED` whose `reviewerId` differs from `ownerUserId`. Not applicable to evidence the runner or the artefact emitter wrote: the run or the artefact is its attribution | EXCEPTION `EVIDENCE_UNATTRIBUTED`, `NO_APPROVAL_REVIEW` or `SELF_APPROVED_EVIDENCE` |
| E5 | Tamper evidence: a file carries its hash | for `type = FILE`: `fileRecordId` set and `FileRecord.sha256` present; `LINK` and `TEXT` evidence is reported as weaker, not as an exception | EXCEPTION `FILE_UNHASHED` |

Two facts behind E3 and E4. `sourcePopulationDigest` hashes the rendered facts,
including fields that change after a source row is written
(`AiDecisionLog.humanOutcome`, a receipt's `verified` and `auditLogId`), and an
artefact stops being refreshed when its month ends. A digest recomputed later
can therefore differ with no tampering, so only a count that differs is an
exception. And the control-test runner (`createScheduledRunEvidence` in
`src/app-layer/jobs/control-test-runner.ts`) and the artefact emitter
(`src/app-layer/usecases/agentic-evidence-emission.ts`) create `Evidence` with
`status = APPROVED` directly and write no `EvidenceReview`. Other writers that
do the same (`automation-runner.ts`, the cloud posture usecases,
`scanner-ingestion.ts`) are
not exempt from E4, and their evidence is `NO_APPROVAL_REVIEW`: nothing in the
rows says who or what vouched for it.

**Re-performance.** Recounts each artefact's source rows, recomputes its digest,
and reads the review history from `EvidenceReview`. It does not take
`Evidence.status = APPROVED` as proof of attribution.

**Exception.** Evidence that shows existence only, falls outside the period,
counts nothing, whose count does not recompute, is unattributed, unreviewed or
self-approved, or is an unhashed file.

**INCONCLUSIVE when** a common precondition fails or a sampled unit is
UNTESTABLE, which includes every uploaded item whose operation test no person
has decided.

---

## Gaps

What the catalogue depends on and the repository does not supply. Each row
names the step that builds it, or says that no step does.

| Gap | Affects | Built by |
|---|---|---|
| No handler runs any procedure | 6 to 8 | no step; adding one is a change to this catalogue and a new step issue |
| No agent subjects in access reviews: `AccessReviewScope` has no agent value | procedure 2 | step `3a` (#3674) |
| Internal audit's approval and the provider's agreement of version 1 are open; the repository owner's merge adopts the version and supplies neither | all | internal audit and the provider, each recorded on issue #3663 when given |
| The provider's methodology reference for each procedure is open | all | the provider, recorded on issue #3663 when given |
| The parameters `leaverWindowHours` and `remediationWindowDays` are agreed 2026-10-19 for the pilot: 24 h and 14 days, entered on each plan (`automationConfig.parameters`, written by `scripts/audit-pilot-setup.ts`); the library holds no default, so a value beyond the pilot is the second line's to enter on its plan. `killGraceSeconds` has no stored home | 1, 2, 6 | the second line sets the values beyond the pilot; procedure 6 has no step |
| An account disabled outside Inflect carries no disable time, so L2 is UNTESTABLE for it | procedure 1 | no step; named in the step `3c` pull request (#3676) |
| `src/app-layer/usecases/identity-sync.ts` stores an undetermined `isAdmin` or `mfaEnrolled` as `false`, including every Okta account past the enrichment cap | procedure 4 | no step; named in the step `3c` pull request (#3676) |
| No procedure tests a legacy account's `expiresAt` | none in this version | no step; adding one is a change to this catalogue |
| Privilege granted by a custom role is not classified | procedure 4 | no step |
