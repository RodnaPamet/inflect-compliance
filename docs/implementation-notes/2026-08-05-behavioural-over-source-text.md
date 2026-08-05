# 2026-08-05 — One behavioural test replaces a source-text guard

**Commit:** `<pending> test(assets): assert the create-modal deep link behaviourally`

`tests/guardrails/assets-audits-modal-form.test.ts` asserted that
"navigating to /assets/new opens the create modal" by regexing three files
for string fragments:

- `new/page.tsx` contains `redirect(...)`
- `AssetsClient.tsx` contains `searchParams?.get('create') === '1'`
- `AssetsClient.tsx` contains `setIsCreateOpen(true)`

Every one of those can hold while the flow is broken. Rename the state
setter, change the query key on one side only, or let the redirect land on a
page that throws during render — the assertions still pass and the user
still cannot create an asset. It also asserted the *absence* of a `showForm`
identifier, which is a linter's job, and the existence of four files, which
the type system already enforces at their import sites.

Replaced by `tests/e2e/assets-create-modal.spec.ts`: open the URL, assert
the form is visible and editable. Plus the negative half — the list page
*without* `?create=1` must not show the modal — because otherwise a modal
stuck permanently open would satisfy the positive test.

## Scope of P3.3, honestly

Four of the five files this roadmap item named were already retired by the
epic-ratchet sweep (`pr-asset-control-codes`, `item-27-32-34-asset-ux`,
`b6-assets-cia-and-table-height` and their Tailwind-class-order and
styling assertions). This closes the fifth.

The item also cites "28 meta-tests repo-wide". After the sweep, 24 test
files still reference another test file by path — but auditing them shows
they are **not one class**:

- **Existence checks** (`provider-fail-closed-coverage`,
  `tenant-isolation-forward-lock`, `new-feature-isolation-coverage`,
  `auth-server-gate-coverage`) assert that a behavioural test *exists* for a
  feature. That is how CLAUDE.md's "every new tenant-scoped model gets a
  two-tenant behavioural test" rule is enforced. Deleting them would remove
  the enforcement, not brittleness.
- **Source-text checks** — e.g. `codebase-hygiene-integrity.test.ts` does
  `expect(src).toContain(anchor)` against another guard's source. These are
  the brittle kind and are the real follow-up.

The distinction is per-file and needs judgement, so it is not swept here.
The 22 tests that regex `.github/workflows/*.yml` are likewise a mixed bag:
this session edited CI heavily and they behaved correctly — one needed a
legitimate update when a job was renamed, which is a guard doing its job,
not a false positive.

## Decisions

- **E2E, not a jsdom render.** The behaviour is a *navigation*. A mocked
  render of `AssetsClient` would prove the component opens a modal when a
  prop says so — not that the URL reaches it.
- **Read-only, so shared seed.** The spec never submits, so per the E2E
  isolation convention it uses the shared seeded tenant and is allowlisted
  in `e2e-isolation.test.ts` with that reason.
- **No new `data-testid`.** `#new-asset-form` and `#asset-name-input`
  already existed.
