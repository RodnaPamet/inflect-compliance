# Reliance on the auditor agent's workpapers: memo to the external auditor

Version **1**, for audit procedure catalogue version **1** (library v1). Step
`4d` of [the agentic IAM plan](agentic-iam-roadmap.md), issue #3681.

**Addressed to:** the certification body that holds Inflect's ISO/IEC 27001
certification, for the extension of its work to ISO/IEC 42001. The memo names
the body once the engagement is confirmed; until then it is addressed to the
role.

**From:** Inflect's second line of defence, which owns and operates the auditor
agent, with internal audit, which samples its work.

**Status.** The repository owner's merge of the pull request that adds or
changes this file is the owner's sign-off of that version. The external
auditor's conclusion on reliance is that auditor's act: it is recorded on issue
#3681 when given, and as Evidence against each control it covers. None is
recorded for version 1.

## What we ask you to rely on

The auditor agent is a registered agent of Inflect's tenant that runs the five
procedures of audit procedure library v1 (`docs/agentic-audit-procedures.md`)
each period and writes one **workpaper** per run. We ask the external auditor to
rely on those workpapers, for the controls listed below and the period of one
audit cycle, as audit evidence of the operation of those controls.

| Procedure | What it tests | Control identifiers the catalogue cites |
|---|---|---|
| `iam.leaver_timeliness` | Leavers' directory access ends within the set window | ISO/IEC 27001:2022 A.5.16, A.5.18, A.6.5 · SOC 2 CC6.1 · NIS2 Art. 21(2)(i) |
| `iam.recertification_completeness` | Every access recertification in the period closed over a non-empty population | ISO/IEC 27001:2022 A.5.18 · SOC 2 CC6.1 · NIS2 Art. 21(2)(i) |
| `iam.time_bounded_access_expiry` | Time-bounded access ended when it was due to | ISO/IEC 27001:2022 A.5.15, A.5.18 · SOC 2 CC6.1 · OWASP ASI03 |
| `iam.privileged_access` | Privileged access is held only by approved holders | ISO/IEC 27001:2022 A.5.18, A.8.2, A.8.5 · SOC 2 CC6.1 · NIS2 Art. 21(2)(i), (j) |
| `agent.authority_conformance` | Each agent acts only within the authority it was granted | OWASP ASI02, ASI03 · ISO/IEC 27001:2022 A.5.15, A.8.2 · **ISO/IEC 42001 A.9.4** · SOC 2 CC6.1 |

**The controls in scope** are the tenant controls each procedure's control-test
plan is on, as listed per procedure in the pack's summary item. They are the
controls this memo concerns, for ISO/IEC 42001 as the framework of the audit
cycle the pack is assembled for.

## The basis for reliance

Reliance rests on **internal audit's re-performance of the auditor agent's
work**, not on the agent's own account of it.

- **Who re-performs.** A daily sweep draws workpapers for review with a keyed
  sample at the tenant's rate, which is **100% in the pilot**: every workpaper is
  drawn. Each is assigned, by a keyed draw from the same epoch, to an ACTIVE
  member whose line of defence is THIRD (internal audit) and who does not own the
  auditor agent. The database refuses any other assignee and any other answerer.
  When nobody is eligible the review is recorded UNASSIGNED with its reason and
  assigned the day somebody is.
- **What they answer.** The assigned reviewer re-performs the workpaper and
  answers once: CONCURRED, DISSENTED (with stable dissent codes) or
  INDETERMINATE. The answer cannot be changed. A dissent raises a finding
  proposal, which a person other than the dissenter decides.
- **The figure.** The re-performance agreement rate is CONCURRED over CONCURRED
  plus DISSENTED. Drawn but unanswered, INDETERMINATE and UNASSIGNED reviews are
  in neither side and are reported beside it. With no concluded review there is
  no rate, never 100%. The pack cites the definition by its stable id,
  `assurance.reliance_reperformance_agreement_rate`, with its population and
  exclusions written out.
- **Independence.** The auditor agent's owner is an ACTIVE second-line member
  who owns none of the agents its procedures examine. An auditor that is not
  independent records no workpaper. The second line owns the agent; internal
  audit samples its work; neither reviews itself.

## What the reliance pack holds

The pack is an ordinary Inflect audit pack, assembled and frozen in one step
from an audit cycle (`POST /api/t/:slug/audits/cycles/:cycleId/reliance-pack`,
or **Reliance pack** on the cycle page). Its period is the cycle's: a month or
quarter is in it only if it lies wholly inside the cycle.

- **One item per control in scope.** It carries the control's code, name, status
  and mapped requirements, and:
  - the procedures run on it;
  - every workpaper of the period, with its period, catalogue version, population
    count and digest, sample size, exceptions and conclusion;
  - internal audit's record of each: drawn or not, the rate in force, the
    sampling epoch and seed fingerprint, and the answer with its dissent codes;
  - the agreement figures over that control's workpapers;
  - every limit that applies (below).

  A control in scope with no workpaper in the period is listed with that limit;
  it is never left out.
- **One summary item.** It carries the framework, the period, each procedure with
  the controls it is on and the procedures on none, the catalogue version and its
  standing, the agreement rate over the whole pack with both definitions, and the
  pack's limits.

**What you can verify yourself.** A workpaper's population digest is the SHA-256
over the procedure id, the period label and the sorted unit ids. Its sample
re-derives from its epoch (`<procedure>@<period>`) and the seed that produced
the fingerprint it records. A review's draw re-derives from its epoch
(`audit-workpaper-review@<period>`), the workpaper id and the rate. The workpaper
and review rows are append-only apart from one-way stamps, and the database
enforces that.

**Access.** The pack is shared with a share link scoped to this one pack. The
link carries a 256-bit token stored only as a hash, can carry an expiry, can be
revoked, and never serves a draft. The auditor's account grant names the pack
too. The pack exposes no personal identifiers: reviewers are described by their
role in the rule, not by name.

## The limits of reliance

The pack states every limit that applies; it does not decide whether to rely.

- **Library v1 is not an approved or agreed definition.** Internal audit's
  approval of catalogue version 1 and PwC's agreement of it are open on #3663,
  and each procedure's PwC methodology reference is open there too. The pack
  says so as `CATALOGUE_NOT_APPROVED_BY_INTERNAL_AUDIT` and
  `CATALOGUE_NOT_AGREED_BY_PWC` until both are recorded.
- **ISO/IEC 42001 coverage is narrow.** Only `agent.authority_conformance` cites
  an ISO/IEC 42001 Annex A identifier (A.9.4). The other four procedures evidence
  access controls under ISO/IEC 27001:2022 Annex A and SOC 2 CC6.1, which the AI
  management system depends on but which are not ISO/IEC 42001 controls in their
  own right.
- **The figure is only as wide as its denominator.** A control's rate counts only
  concluded reviews. The pack lists `NO_CONCLUDED_REVIEW`, `WORKPAPERS_NOT_DRAWN`,
  `REVIEWS_AWAITING`, `REVIEWS_UNASSIGNED` and `REVIEWS_INDETERMINATE` wherever
  they apply.
- **Disagreement and failure are shown, not netted.** `DISSENT_RECORDED`,
  `CONCLUSION_FAIL` and `CONCLUSION_INCONCLUSIVE` are listed per control.
- **A purged test run.** A workpaper whose control-test run is gone is attributed
  through its procedure's one live plan and marked `ATTRIBUTED_BY_CURRENT_PLAN`.
  When that is ambiguous the pack is refused rather than guessed.
- **What the pack refuses.** It is not assembled for a cycle with no period, a
  period with no whole month or quarter, no workpaper in the period, more than
  2,000 workpapers, or a workpaper it cannot attribute to a control. Each refusal
  names its reason and leaves an audit row.

## Recording the conclusion

The external auditor states, per control in scope, whether they rely on the
workpapers and on what basis, in their own terms. The conclusion is recorded on
issue #3681 and attached as Evidence to each control it covers, and the
version of this memo and the pack it concerns are named beside it.
