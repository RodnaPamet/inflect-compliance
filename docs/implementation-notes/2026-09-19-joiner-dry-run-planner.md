# 2026-09-19 — JML joiner Phase 1: a DRY_RUN planner, and one ceiling instead of two (#2638)

**Commit:** `<pending>` feat(identity): add the joiner DRY_RUN planner and give the route one ceiling

## Design

Issue #2638 is the tracker behind `docs/jml-joiner-design.md`, and it carries ten
owner decisions taken 2026-09-19. Phase 1 is the DRY_RUN rung: **decide
everything, write nothing.**

```
planJoinerPass(input)            pure. no prisma, no socket, no queue.
  1. ladder gate ────────────────  MODE_DISABLED / MODE_ABOVE_CLAMP, CARRYING the starter count
  2. NO_STARTERS
  3. per-candidate decide() ─────  the identity verdicts (computed BEFORE the config refusals)
  4. BATCH_OVER_CAP (decision 7)   whole batch, never trimmed
  5. NO_DEPARTMENT_MAP / NO_DEFAULT_GROUP (decisions 10, 5)
  → JoinerPlan { refusal, starters, wouldCreate, decisions, predictionLimits }
```

Assembly sits ABOVE the ladder gate, inverting the leaver. The leaver's ordering
argument is specifically about DIRECTORY traffic (*"a tenant in DISABLED mode
must not generate directory traffic to discover that it is in DISABLED mode"*);
joiner assembly generates none, and a `MODE_DISABLED` row carrying `starters: 3`
is the most actionable row on the page on the morning somebody is sitting at a
desk with no account.

The other half of the change is one line of the admin route. `honoured.joiner.maxMode`
was a hand-typed `'DISABLED' as const` while the leaver's came from its pass;
`write-ladder.ts` had already written down what that would cost — flip
`DIRECTION_IMPLEMENTED.joiner` and the gate stops refusing while the route still
reports a DISABLED ceiling, so `isAboveClamp` is true for every rung, the client
renders the aboveClamp banner permanently, and nothing clamps anything. The route
now imports `JOINER_MAX_MODE`, so the published ceiling and the enforced ceiling
are one value.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/identity-joiner-pass.ts` | New. `JOINER_MAX_MODE`, `MAX_CREATES_PER_RUN`, the one pure `deriveJoinerIdentity`, and `planJoinerPass`. |
| `src/lib/identity/email-key.ts` | New. The reconciler's normalisation rule, moved out of `identity-account-link.ts` so the collision read and the link matcher cannot disagree. Server-free, so the planner stays prisma-less. |
| `src/app-layer/usecases/identity-account-link.ts` | Imports `emailKey` instead of declaring it. |
| `src/app/api/t/[tenantSlug]/admin/identity-write-policy/route.ts` | `honoured.joiner.maxMode` is now the imported constant. |
| `src/lib/identity/write-ladder.ts` | `DIRECTION_IMPLEMENTED` docblock: the maxMode half of the trap is closed; the flag is still false and the two reasons are named. |
| `src/app-layer/usecases/identity-write-policy.ts` | The unimplemented-direction refusal no longer says "no job or directory writer reads this setting" — a planner does read it; nothing triggers it. |

## Decisions

- **`DIRECTION_IMPLEMENTED.joiner` stays FALSE.** The flag means a RUNTIME reads
  the setting *and* an operator can see what it did. Nothing dispatches the
  planner (decision 9 wants per-tenant-timezone dispatch and nothing stores a
  timezone; `dispatchJobId` floors on UTC buckets), and decision 10's
  department→group map had no column until #2713 gave it one, so a plan for a
  tenant that has not configured it still refuses
  `NO_DEPARTMENT_MAP` — a refusal an operator cannot clear. Flipping the flag now
  would enable the widen control over a direction that produces nothing: the same
  settable-and-inert defect the issue exists to close, one layer along. The
  acceptance mutation is proved WITH the flag flipped (the ladder module is
  mocked), which is strictly stronger than shipping the flip.
- **Decision 1 declines the collision token.** The settled 2026-08-20 decision
  appended `-4f2a` on collision; the owner replaced it with *refuse on
  divergence*. So `deriveJoinerIdentity` has no token arm, a collision is
  `ACCOUNT_OBSERVED`, and a derived address that is not the one the roster holds
  is `REFUSED_IDENTITY_DIVERGES` — because the link matcher joins on
  `Employee.workEmail`, and an account it never matches is one the LEAVER can
  never disable. In Phase 2 the HRIS write-back is what makes the two converge;
  Phase 1 has no write-back, so the only guarantee available is the address that
  already exists.
- **Decision 6 gets its own outcome, not the design's shared one.** The doc folds
  a MANUAL employee into `REFUSED_IDENTIFIER_UNSTABLE`. `REFUSED_SOURCE_MANUAL`
  is separate because the operator action differs: an unstable identifier is a
  data-quality problem somebody can fix, a MANUAL row has no HRIS to fix it in.
  It is checked ABOVE the identifier rail so the more specific answer wins.
- **`NOT_IN_WINDOW` is a new outcome.** The start-date window is applied inside
  the planner rather than in a caller's `where`, because a query filter makes
  "starts tomorrow" and "has no start date at all" the same absence — and the
  second is the live case (`deriveEmploymentStatus` returns ONBOARDING from the
  status string alone, with no date).
- **Config refusals are evaluated AFTER the per-candidate decisions.** Returning
  early on an unconfigured group map would throw away the identity verdicts, and
  those verdicts are the rung's whole value: they make a wrong derivation visible
  seven days before it could create a wrong account.
- **`nameSource` ships two values, not three.** `Employee` holds one `fullName`
  (`preferredName || legalName || workEmail` flattened at sync time), so
  PREFERRED vs LEGAL is not recoverable from a stored row. The design says
  plainly: do not record a field the pass cannot populate.
- **`predictionLimits` from the first run.** The HRIS write-back has never been
  attempted; the collision read covers the stored `email` column only, not the
  `userPrincipalName` / `mailNickname` / `proxyAddresses` / `sAMAccountName`
  namespaces a create is actually rejected in; and with no persisted reservation,
  `IDENTITY_DRIFTED` is not detectable yet. A number with no bound on it is how a
  dry run becomes a promise.
- **No job, no route, no reservation, no create verb.** Each needs a capability
  that does not exist (a timezone-aware dispatcher, a pre-hire model outside
  `Employee`, a `DirectoryProvisioner`). Phase 1 ships the refusal instead.
