# 2026-08-09 — Risks adopts `_form/` + `useZodForm`

**Commit:** `<pending>` feat(risks): adopt the shared _form/ + useZodForm shape

## Design

Risks was the last major surface with no `_form/` directory — assets, audits,
policies, tasks and vendors all had one. `NewRiskModal` hand-rolled a single
`useState` object, its own `submitting` / `error` slots, and a
`form.title.trim().length > 0` submit gate.

```
src/lib/risk/categories.ts        RISK_CATEGORIES (moved down a layer)
src/lib/schemas/risk-form.ts      NewRiskFormSchema + NEW_RISK_FORM_INITIAL
risks/_form/useNewRiskForm.ts     the hook — payload, POST, lifecycle
risks/NewRiskModal.tsx            mounts it; keeps template + control-link
```

## Decisions

- **`RISK_CATEGORIES` moved to `@/lib/risk/categories`.** The schema needs to
  validate against it, and `src/lib/schemas/` importing from
  `src/app/t/[tenantSlug]/(app)/risks/_shared/` is a layering inversion — it
  drags route-level modules (and a `ComboboxOption` type) into the schema's
  graph for eight strings. `_shared/risk-options.ts` re-exports it, so every
  UI import still resolves and `RISK_CATEGORY_OPTIONS` is still projected from
  it. One source, one layer down.

- **The enums are imported, never re-declared.** `category` validates against
  `RISK_CATEGORIES`, `treatment` against `TREATMENT_DECISION_VALUES`. A third
  copy would drift silently: the combobox would offer an option the schema
  rejects, and it would surface as an un-submittable form with no visible
  error on any field.

- **Optional fields are `''`, not `.optional()`.** These are controlled
  inputs; React needs a defined value. `''` means "not filled in", and the
  submit path converts it to an omitted key — in exactly one place. Modelling
  them as optional would make the initial-values object type-legal while
  still breaking the inputs at runtime.

- **`templateId` and `selectedControlIds` stay in the modal.** They look like
  form state and are not. `templateId` drives a *fetch* and rewrites several
  fields — folding it in would make "the user typed a title" and "a template
  overwrote the title" the same event. `selectedControlIds` is not sent with
  the risk at all: it drives a second phase after the risk exists, because
  the links need the new id, and that phase counts failures rather than
  throwing so a dropped link never presents as a failed create.

- **`submit()` deliberately does NOT rethrow**, unlike `useZodForm.submit`.
  The failure is already on `error` and the modal renders it as a banner, so
  a rethrow buys nothing and costs an unhandled rejection at every call site
  that forgets to catch — `void form.submit()` in a click handler rejects
  silently in the console. An optional `onError` preserves the
  `telemetry.trackError` call the old `catch` block made.

- **Three source-scans were deleted, not repointed.** `new-risk-modal.test.ts`
  asserted the payload shape by grepping `NewRiskModal.tsx` for `title:`,
  `payload.templateId = selectedTemplate.id` and a `.toISOString()` regex.
  Those prove text exists in a file — they would have passed against a
  payload sending `category: ''` to an endpoint expecting the key absent,
  which is the exact bug the new behavioural test catches by reading the
  fetch body. `tests/rendered/use-new-risk-form.test.tsx` covers the payload,
  the trim/omit rules, the ISO conversion, the templateId pass-through, the
  submit gate (including whitespace-only titles), the server-vs-fallback
  error message, `reset()` and `applyFields()`.

- **One assertion was made name-agnostic rather than re-pinned.** The
  control-link check matched `` apiUrl(`/risks/${risk.id}/controls`) ``; the
  extracted helper takes `riskId`. A rename is not a regression, so the
  pattern now matches any identifier.
