# 2026-10-24 — A framework's coverage from the tenant's other frameworks

**Commit:** _(stamped post-commit)_ `feat(frameworks): show coverage inherited from the tenant's other frameworks`

## Design

About 1,500 curated mapping entries are imported into every database. Until
this change, one product surface read them: per-agent OWASP risk coverage,
which only reads the edges that target an ASI risk.

- **The gap-analysis usecase is not a tenant view.** `performGapAnalysis`
  compares two framework catalogues, with no tenant in it, and no route calls
  it.
- **It could not run anyway.** Its default path filtered on an `assessable`
  column that `FrameworkRequirement` does not have, so it was a Prisma
  validation error.
- **The `/mapping` route reads a hardcoded guidance table** instead of the
  mappings.

So a tenant holding ISO 42001 controls opened AIUC-1 and saw fifty blanks.

This change answers the tenant question on the framework's Coverage tab:

```
framework page ─ Coverage tab
   ├─ direct coverage            computeCoverage            (unchanged)
   └─ "Coverage from your other frameworks"
        GET /frameworks/:key?action=inherited-coverage
        computeInheritedCoverage  (usecases/framework/inherited-coverage.ts)
           ├─ resolveFamilyRequirementAliases   target: both representations
           ├─ loadControlsByRequirement         direct links → DIRECT
           └─ loadInheritedCoverage             routes in, source families expanded
                 (services/inherited-requirement-coverage.ts — shared with agent-coverage.ts)
```

Each requirement gets one of four statuses:

| Status | Meaning |
|---|---|
| `DIRECT` | The tenant has a control linked to this requirement itself |
| `PARTIALLY_COVERED` | Reached by an `INTERSECT`-or-stronger route the tenant holds a control on |
| `REVIEW_NEEDED` | Reached only by `RELATED` routes the tenant holds |
| `NOT_COVERED` | No control of its own and no held route |

The panel lists the requirements that are not `DIRECT`, each with its routes
(framework, requirement, strength) and the tenant's controls behind them,
linked.

## Files

| File | Role |
|---|---|
| `src/app-layer/services/inherited-requirement-coverage.ts` | The shared loader, moved out of `agent-coverage.ts`; it now holds `CoveringControl` / `InheritedCoverage`, and reports truncation |
| `src/app-layer/usecases/agent-coverage.ts` | Calls the shared loader; no behaviour change |
| `src/app-layer/services/agent-risk-coverage.ts` | Re-exports the two moved types, so every existing import keeps working |
| `src/app-layer/usecases/framework/inherited-coverage.ts` | `computeInheritedCoverage` |
| `src/app/api/t/[tenantSlug]/frameworks/[frameworkKey]/route.ts` | `?action=inherited-coverage` |
| `src/components/frameworks/InheritedCoveragePanel.tsx` | The panel, mounted at the end of the Coverage tab |
| `messages/en.json`, `messages/bg.json` | `frameworks.detail.inherited.*` |
| `src/app-layer/usecases/gap-analysis.ts` | Drops the filter on the nonexistent `assessable` column, filters `deprecatedAt: null`, removes the `includeNonAssessable` option |
| `tests/integration/framework-inherited-coverage.test.ts` | Three tenants against the shipped ISO 42001 ⇄ AIUC-1 data |
| `tests/integration/framework-representation-coverage.test.ts` | Its gap-analysis case now runs the default path, which it used to opt out of |
| `tests/rendered/inherited-coverage-panel.test.tsx` | The panel's listing, omissions, both empty states and the truncation notice |
| `docs/requirement-mapping-sets.md` | "Where Tenants See the Mappings", and the file map |

## Decisions

### Tenant-scoped, not catalogue-level

The ask was to wire up gap analysis. Its usecase answers "how much of B is
mapped from A" for any two frameworks, regardless of what a tenant has done,
so it cannot tell an ISO 42001 holder what their controls give them. The
tenant question is the one per-agent coverage already answers, for ASI
risks. So this change reuses that machinery for any framework and fixes the
gap-analysis usecase as a separate change, without giving it a route.

### One loader, extracted rather than copied

The family expansion — two representations, two code spellings — is the part
that has broken before on this codebase, in both directions. A second copy in
the framework usecase would have been a second place to break, and the first
place two compliance surfaces could disagree about one tenant. The extraction
is a move. The one behavioural addition is `truncated`: the edge read takes
one past its cap, so a capped read is a fact the report states. The agent
integration suite passing unchanged is what shows the move kept behaviour.

### Inherited coverage is never coverage

The agent surface caps inherited status at `PARTIALLY_COVERED`, and so does
this one, for the reason the agent module gives: a mapping is Inflect's
judgement, not the tenant asserting that a control governs the requirement.
The panel also sits apart from the direct figures and says, in its
description, that it never counts toward them. The integration test pins
both: the direct `mapped` count is unchanged by inherited routes.

### Only held routes count

A route whose source requirement the tenant holds no control on reaches
nothing, so it is neither listed nor counted. Listing such routes ("you could
get coverage by implementing X") is a different feature, and a useful one,
but it would bury this panel's answer.

### Two empty states

"No other framework reaches this one" and "everything reached already has its
own control" are different facts, and rendering the first for the second
would tell a tenant their mappings do nothing when they have simply done the
work. The panel distinguishes them.

### No own-family filter

A filter dropping routes from the framework's own family was written and then
removed. No mapping set links two representations of one framework, so the
filter guarded a path that cannot occur, and could not be tested.
