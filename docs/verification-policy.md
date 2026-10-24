# Verification policy

A structural ratchet that passes is **not** proof a feature works.
The 2026-05-13 delivery audit (`docs/roadmap-audit-2026-05-13.md`) found the <!-- docs-accuracy-allow: "roadmap" only in the linked historical-audit filename -->
opposite assumption baked in — features shipped "green" while the
behaviour was broken in the browser. This policy makes the
difference explicit and CI-enforced.

## Three verification states

A feature / delivery item is in exactly one of these states. They are
NOT interchangeable — a higher state is not implied by a lower one.

| State | What it means | How it is achieved | How it is enforced |
|-------|---------------|--------------------|--------------------|
| **Structurally present** | The class / symbol / wiring exists in source. Says **nothing** about behaviour. | A structural ratchet (`tests/guards/`, `tests/guardrails/`) — a string/AST scan. | The ratchet itself. |
| **Functionally tested** | The behaviour is exercised — real inputs → asserted outputs, branches, error paths. For UI, the *rendered/computed* outcome is asserted, not just a className. | Unit / integration tests (`tests/unit/`, `tests/integration/`); rendered behavioural tests (`tests/rendered/`). | The test + the coverage ratchet (`docs/coverage-policy.md`). |
| **Browser verified** | The feature works in a real browser, full flow. | An E2E test (`tests/e2e/`), or a human confirming on the deployed site. | The E2E suite. |

**The rule:** a delivery item is "done" only at **functionally
tested** minimum. "Structurally present" is a building block, never
a completion claim. UI work that the audit would mark `Status: ?`
(structural ratchet only, never rendered/browser-checked) is *not*
done.

## Why a structural ratchet is not enough

A structural ratchet asserts `from-[var(--bg-page)]!` is in a
component's `className`. It cannot tell whether the rendered
`background-image` is actually `--bg-page` or still the brand ramp —
that exact gap shipped a broken nav active-band (audit case #455).
Structural ratchets are cheap and right for *pure presence* checks;
they are the wrong tool for any wiring whose rendered effect is
subtle.

## The four pillars (Roadmap-4) <!-- docs-accuracy-allow: shipped-epic codename, not future tense -->

This policy is the umbrella over four remediations, each with its
own doc + guardrail:

| Pillar | Doc | Guardrail |
|--------|-----|-----------|
| Frontend assurance model — structural vs rendered vs browser | `docs/frontend-assurance-model.md` | `tests/guards/behavioural-coverage-registry.test.ts` — high-risk UI primitives MUST have a rendered behavioural test |
| Rich-text sanitiser coverage — structural, not a numeric floor | (in `encrypted-fields.ts`) | `tests/guardrails/sanitize-rich-text-coverage.test.ts` — every encrypted-content model classified |
| Test-portfolio balance — guardrails support, not substitute for, functional tests | `docs/test-portfolio.md` | `scripts/test-portfolio-report.ts` (diagnostic) |
| Verification policy + its enforcement | this doc | `tests/guards/verification-integrity.test.ts` (the meta-ratchet) |

## Preventing silent accumulation

The failure mode the audit named — unverified items piling up while
CI stays green — is structurally blocked, not left to memory:

- **New high-risk UI primitive** → `behavioural-coverage-registry`
  requires a rendered behavioural test before it can be considered
  covered. A structural ratchet alone does not satisfy it.
- **New rich-text field** → `sanitize-rich-text-coverage` fails until
  the field's model is classified (covered / non-rich-text /
  known-gap). A new surface cannot land silently.
- **New behaviour-heavy module** → the per-folder coverage ratchet
  (`docs/coverage-policy.md`) holds the floor; `test-portfolio.md`
  states that a structural ratchet is never a substitute for a
  behavioural test of the same logic.
- **The verification population shrinking** →
  `rendered-coverage-floor.test.ts` is a *staged upward ratchet* —
  the count of rendered behavioural tests, E2E specs, and registered
  high-risk primitives must each stay at or above a floor that only
  ever rises. It is the inverse of the `as any` downward ratchet:
  deleting verification trips CI, and every release locks the surplus
  in: `scripts/raise-coverage-floors.mjs` runs as semantic-release's
  prepare step and raises each floor in `tests/guards/coverage-floors.json`
  to its live count, so a pull request never edits a floor. Roadmap-4's <!-- docs-accuracy-allow: shipped-epic codename, not future tense -->
  registry froze a *named* set; this keeps the whole rendered/E2E
  *population* from eroding.
- **The guardrails themselves** → `verification-integrity.test.ts`
  fails CI if any verification guardrail is deleted or gutted.

## For contributors

When you ship a feature, ask which state it is in — and be honest:

1. Does a structural ratchet pass? → structurally present. Not done.
2. Does a test exercise the *behaviour* (computed/rendered outcome,
   branches, errors)? → functionally tested. Minimum bar for "done".
3. Is the full flow covered by E2E or confirmed in-browser? →
   browser verified. The bar for high-visibility / high-risk flows.

A PR description that claims a UI feature works should name the
rendered or E2E test that proves it — not the structural ratchet.
