# 2026-11-24 — Mobile Phase 5: "flawless" defined and held

**Commit:** see the pull request for #5899.

## Design

Phase 5 of `docs/mobile-roadmap.md` turns the mobile work into things that keep
holding after the fixes land:

- **Key phone journeys** in the `mobile` E2E project. Six in
  `tests/e2e/mobile-journeys.spec.ts` (sign in with MFA, triage a task, approve
  an agent proposal, stop an agent, decide an access review, open a shared
  audit link) and the vendor questionnaire, extended in
  `mobile-vendor-questionnaire.spec.ts` to a successful submit. Each runs in an
  isolated tenant, builds what it starts from through the product's API, holds
  every screen it passes through to the phone invariants (`holdScreen`), and
  holds the action it exists to take to 44 px (`expectThumbSized`), in
  `tests/e2e/mobile-journey-support.ts`.
- **The whole-product harness on a schedule**: `.github/workflows/mobile-audit.yml`,
  nightly and on dispatch. It compares against the previous successful run's
  `metrics.json`, fails when a count of failing pages rose, and opens or
  comments on a `mobile-audit` issue with `comparison.md`
  (`renderComparison` in `scripts/mobile-audit/report.ts`).
- **The English-leak detector** catches a whole templated English message
  inside a Bulgarian sentence (`embedded` patterns in `leaks.ts`), and a test
  holds the #5883 case against the real catalog and the diagnostic workflow's
  own synthesis step.
- **A real-device checklist** in `docs/mobile-audit.md`.

## Files

| File | Role |
|---|---|
| `tests/e2e/mobile-journeys.spec.ts` | Six key phone journeys |
| `tests/e2e/mobile-journey-support.ts` | `onPhone`, `holdScreen`, `expectThumbSized`, `addMember`, TOTP |
| `tests/e2e/mobile-vendor-questionnaire.spec.ts` | Now ends in a 200 and the confirmation |
| `.github/workflows/mobile-audit.yml` | Nightly harness, comparison, issue |
| `scripts/mobile-audit/report.ts`, `run.ts` | `comparison.md` / `comparison.json` |
| `scripts/mobile-audit/leaks.ts` | Templated messages embedded in Bulgarian sentences |
| `src/app-layer/usecases/audit-readiness/sharing.ts` | The shared link reads the pack as its tenant's |
| `src/app/t/[tenantSlug]/(app)/agents/proposals/AgentProposalsClient.tsx` | The proposal card's header row wraps |
| `tests/guards/mobile-audit-schedule.test.ts` | The workflow's schedule, reference and notifier |
| `docs/mobile-audit.md` | Journeys, nightly run, real-device pass |

## Decisions

- **Two product bugs the journeys found were fixed here, both small.**
  - The shared audit link served every item with `snapshotJson: null`.
    `getPackByShareToken` read the pack in the global context, and the
    encryption extension decrypts the tenant-encrypted snapshot only with an
    ambient tenant, answering `null` without one by design. The auditor saw a
    control's database id and a Statement of Applicability with no content.
    The share row is still resolved globally (the token is the authority);
    the pack and its items are then read through `withTenantDb` with the
    share's tenant, which also puts RLS in front of them.
  - The proposal queue's card header did not wrap, so on a phone Reject sat
    past the right edge, where the shell's clip hid it.
- **Journeys find controls by id, role or test id, and pick options by the
  Bulgarian catalog value** (`messages/bg.json`), never by an English label.
- **Each journey runs in one configuration**, not both: together they cover
  both widths and both themes, at half the CI time. The questionnaire keeps
  both, as before.
- **The proposal journey has a second member own the agent.** The agent's
  owner may not approve its proposals (four eyes), and an agent with no policy
  card needs two approvers, so the phone's part is the first signature, shown
  as signed. A second member is invited and redeems through the product's own
  invite path.
- **The workflow's reference is the last SUCCESSFUL run on `main`.** A run that
  rose fails, so it never becomes the reference: a regression is reported every
  night until fixed. "Rose" and "could not run" are told apart by
  `comparison.json`, because the harness exits 1 for both, and they get
  different issue titles because they need opposite responses.
- **Actions are pinned by version tag**, as every workflow in the repository
  is; no workflow here pins by SHA.
- **The detector stays catalog-based.** A product sentence in no catalog cannot
  be told from tenant data (an agent's own English summary is data). The #5883
  sentence is caught because its template is now a catalog message; the new
  `embedded` patterns catch it, or any templated message, behind a Bulgarian
  label in one text node.
