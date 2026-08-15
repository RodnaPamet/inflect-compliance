# 2026-08-16 — the report family disagreed in two more places

**Commit:** `<pending>` fix(reports): readiness and the SoA answer applicability from the same column

## Design

`docs`-worthy because this is the *third* pass over the same seam, and the
third one found the mechanism that produced the first two.

Three surfaces compute compliance numbers over the same tenant data:

| surface | entry point | consumed by |
|---|---|---|
| coverage | `computeCoverage` (`framework/coverage.ts`) | Frameworks list page, framework JSON + CSV export, MCP tools/resources |
| readiness | `generateReadinessReport` (same file) | readiness report + its export |
| SoA | `getSoA` (`soa.ts`) | Statement of Applicability |

A prior fix reconciled them on *soft-deleted controls* and left a comment
saying why: the two reports "gave DIFFERENT compliance numbers for the same
tenant at the same moment". This change closes two more instances of exactly
that, and deletes the thing that let a fix be applied to only one side.

### 1. Applicability was read from two different columns

`Control` has **two** relevant columns, backed by two enums:

- `status: ControlStatus` — includes a `NOT_APPLICABLE` member
- `applicability: Applicability` — `APPLICABLE | NOT_APPLICABLE`, default `APPLICABLE`

The SoA and the shared per-requirement rollup resolve **effective
applicability** as `link.applicability ?? control.applicability`, honouring the
per-framework override on `ControlRequirementLink`.

`generateReadinessReport`'s two control-level lists keyed on
`control.status === 'NOT_APPLICABLE'` instead — 20 lines below the same
function's own correct use of `applicability` for the rollup.

**`status = NOT_APPLICABLE` has no live write path.** Marking a control N/A is
an `applicability` write: `ControlRepository.setApplicability` writes
`applicability` + justification + decided-by + decided-at and never touches
`status`, and all three status-write schemas exclude `NOT_APPLICABLE` on
purpose, each with a comment naming the reason (`src/lib/schemas/index.ts`).

So the effect was not a near-miss, it was total and one-directional:

- `notApplicableControls` could only ever list rows left behind by a
  pre-hardening writer — never a current decision.
- every properly-decided N/A control fell through to
  `controlsMissingEvidence` and was billed as a gap.

Readiness was the **pessimistic** one here, which is why it went unreported:
an over-stated gap list reads as work to do, not as a bug.

### 2. Deprecated requirements were in one denominator and not the others

`generateReadinessReport` and `getSoA` both filter `deprecatedAt: null`.
`computeCoverage` did not — while returning a field with the *same name*
(`coveragePercent`) computed with the *same formula*.

Deprecation is a live, default-on write path: `library-importer` ships
`deprecateMissing: true` and stamps `deprecatedAt` on every requirement absent
from a re-imported library. A deprecated requirement can never be mapped, so it
sat in this denominator permanently — the Frameworks page reported a
permanently **lower** coverage percentage than the two reports beside it, for
any tenant that had ever re-imported a framework.

### 3. The mechanism: a dead fork

`framework/install.ts` carried a second, unreachable copy of `computeCoverage`
*and* `listTemplates`. The barrel (`framework/index.ts`) has always re-exported
both from `./coverage`, so nothing in `src/` could reach the twin.

It was not inert. It was a **fork**: the earlier soft-deleted-control fix was
applied to the live copy only, so the twin still computed the wrong number —
and `framework-install.test.ts` pinned that behaviour, so a reader who found
the dead copy first would have found the bug documented as correct.

`listTemplates` was byte-identical modulo blank lines; `computeCoverage` had
diverged. Both deleted, along with their two `describe` blocks (the live
implementations are covered by `framework-coverage.test.ts`).

## Files

| file | role |
|---|---|
| `src/app-layer/usecases/framework/coverage.ts` | effective-applicability resolution for both control lists; `deprecatedAt: null` on the coverage requirement read |
| `src/app-layer/usecases/framework/install.ts` | dead `computeCoverage` + `listTemplates` clones removed |
| `tests/unit/usecases/framework-coverage.test.ts` | fixtures moved to the reachable N/A state; override, legacy-row and mixed-link regressions; deprecation assertion |
| `tests/unit/usecases/framework-install.test.ts` | the two describes for the deleted clones removed |
| `tests/unit/report-family-soft-delete-agreement.test.ts` | SoA assertion de-vacuumed; deprecation agreement; one-implementation-per-report |

## Decisions

- **A control is N/A only when *every* link says so.** Applicability is
  per-link but these two lists are per-control. A control applicable against
  any requirement in the framework still owes evidence, so the conservative
  direction is the correct one.

- **A legacy `status`-only N/A row now counts as applicable.** Such a row has
  no recorded decision — no justification, no decider, no timestamp. The SoA
  already treats it as applicable; agreement is the goal, and "no decision
  recorded" is honestly read as "not decided". Pinned by a test so the
  direction cannot be flipped back silently.

- **The existing ratchet's SoA half was vacuous and is now pinned.**
  `expect(SOA).toMatch(/deletedAt/)` matched a type declaration, a `select`,
  and a comment; deleting the actual filter left it green. The readiness half
  of the same file had already been hardened against exactly this after a
  mutation proved it — the SoA half was not included. Verified by reverting
  the filter and watching it go red.

- **Forbid the duplicate rather than sync it.** The new
  one-implementation-per-report assertion scans the framework usecase
  directory for a second exported `computeCoverage` / `listTemplates`. A
  duplicate is *how* a one-sided fix happens; syncing the copies would have
  preserved the mechanism.

- **Every fix was falsified.** Each of the six assertions was confirmed to go
  red with its fix reverted, then restored — including the two that were added
  to a file whose comparable assertion had previously passed against broken
  code.
