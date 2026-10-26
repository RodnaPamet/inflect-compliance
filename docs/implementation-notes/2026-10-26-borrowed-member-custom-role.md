# 2026-10-26 — A sweep that borrows a member reads that member's custom role

**Commit:** `fix(jobs): a sweep that borrows a member acts with that member's custom role`

## Design

Three scheduled jobs have no initiator, so each picks a member to act as. The
risk-appetite monitor and the SharePoint policy jobs take the oldest active
OWNER or ADMIN; the posture summary takes the most senior active member. Each
built the context from `getPermissionsForRole(membership.role)`, so a custom
role on that member was ignored (#4388). The owner decided on 2026-10-26 that
these jobs respect custom roles.

```
candidates (oldest / most senior first)
  └─ borrowedMemberAuthority(m, builtInCoarseFlags)
       custom role → initiatorAuthority(m)          (a request's authority)
       built-in    → role, its set, the job's own projection   (unchanged)
  └─ first one passing the job's predicate → the context
  └─ none → a named reason in the result, and a warn log
```

| Job | Predicate | Reasons |
| --- | --- | --- |
| `risk-appetite-monitor` | `mayMonitorRiskAppetite`: `canRead` and `risks.view` | `NO_ACTIVE_ADMIN`, `NO_ADMIN_WITH_RISK_VIEW` |
| `sharepoint-policy-pull`, `sharepoint-subscription-renew` | `mayRunPolicySync`: `canWrite` and `policies.edit` | `no_admin`, `no_admin_with_policy_edit` |
| `compliance-posture-summary` | `mayGeneratePostureSummary`: `canRead` and `frameworks.view` | `NO_ACTIVE_MEMBER`, `NO_MEMBER_WITH_POSTURE_READS` |

Each predicate is what the job's own path refuses without. The monitor's
usecases ask `assertCanRead` and read the risk register. A pull writes a policy
version through `assertCanWritePolicies`, which asks both the coarse write flag
and `policies.edit`, the key the link, unlink and manual-pull routes name. The
summary's reads ask `assertCanRead` and `assertCanViewFrameworks`. So the job
never acts as a member it would then refuse.

`buildDelegatedJobContext` keeps ADMIN. Each of its nine callers names a user
for a foreign key or attribution on a system act, and now says so in a comment.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/context-system.ts` | `borrowedMemberAuthority`; `buildDelegatedJobContext` docblock says when to use it |
| `src/app-layer/jobs/risk-appetite-jobs.ts` | actor choice, predicate, `RISK_APPETITE_UNROUTABLE` |
| `src/app-layer/jobs/sharepoint-policy-jobs.ts` | actor choice, predicate, `POLICY_SYNC_UNROUTABLE` |
| `src/app-layer/jobs/compliance-posture-summary.ts` | actor choice, predicate, `POSTURE_SUMMARY_UNROUTABLE` |
| `src/app-layer/jobs/executor-registry.ts` | the job results carry the reasons |
| nine `buildDelegatedJobContext` callers | a comment saying why each is a system act |

## Decisions

- **A built-in role keeps the job's own coarse flags.** The posture summary can
  pick any role, and its projection (`canAudit: audits.view`) gives EDITOR,
  READER and AI_ADMIN a `canAudit` that a request does not. #4375 aligned that
  for initiator jobs on an owner decision; nothing decided it for these, so a
  built-in role's context here is byte-for-byte what it was. For OWNER and
  ADMIN the projection already equals a request's flags. The tests pin all six
  roles against the old builders.
- **A custom role takes a request's coarse flags, not the projection.**
  Projecting from the custom role's set would let a READER-based role that
  grants `policies.edit` write a policy version, which `assertCanWritePolicies`
  refuses for that member's own request ("tighten, never loosen").
- **The posture predicate is the job's reads, not `controls.edit`.** The manual
  regenerate route asks `controls.edit`. Using it would stop the summary for a
  tenant whose only members are READER, AUDITOR or AI_ADMIN, which changes a
  built-in role's outcome. That choice is left to the owner.
- **The candidate reads are per tenant and uncapped.** A cap could leave out
  the member who qualifies and report the tenant as having nobody. Each read is
  bounded by one tenant's OWNER/ADMIN rows, or its active members for the daily
  summary.
- **No `buildDelegatedJobContext` caller changed.** Reminders, the drill, the
  emitted evidence and passports, and the orphan pass's transfer task are
  raised for a person, not by them. A scheduled control test and an identity
  pass somebody asked to run early are the platform's work too. Reading the
  named user's role in any of them could stop work a workspace relies on, and
  for a built-in role it would change today's authority. The control-test
  runner is the case closest to the line, and it is left to the owner.
