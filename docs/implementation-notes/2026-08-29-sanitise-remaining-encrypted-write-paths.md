# 2026-08-29 — Epic D.2 tail: the last two unsanitised encrypted write paths

**Commit:** `<sha> fix(security): sanitise the last two encrypted free-text write paths`

## Design

`tests/guardrails/sanitize-rich-text-coverage.test.ts` classifies every
`ENCRYPTED_FIELDS` model into one of three buckets. `KNOWN_UNCOVERED` — the
"real, named gap" bucket that is meant to ratchet to zero — still held two
entries. Both are now closed, and the cap is `0`.

Encryption is confidentiality *at rest*. Every one of these columns is
decrypted and re-rendered by surfaces that are not the originating form —
the list/detail UI, an owner notification, PDF export, the audit-pack share
link, and any SDK consumer reading the row verbatim. Render-time escaping in
one of those is not a property of the row, so the sanitiser belongs at the
write seam.

**`EvidenceReview.comment`** — written only by `evidence.ts::reviewEvidence`
(the bulk-approve path writes the source constant `'Bulk approved'`, so no
user input reaches it). Routed through a local `sanitizeOptional` wrapper,
matching `vulnerability.ts` and `dsar-register.ts`, because `addReview` and
`notifyEvidenceOwner` both take `string | null | undefined` and
`sanitizePlainText` collapses `undefined` and `null` to `''`.

The sanitiser runs **before** the mandatory-rejection-reason check, not
after. A reason consisting only of markup would otherwise pass the
`!comment?.trim()` test and then land as an empty string — the check would
be satisfied by something that stores as nothing.

**`Nis2SelfAssessmentAnswer.note`** — has **two** write seams, not one.
`onboarding-nis2.ts::saveNis2Answer` (wizard autosave) was already
sanitising; `gap-assessment-assignment.ts::submitAssignmentAnswers` (the
delegated multi-respondent submit) was not. Both are now listed in
`RICH_TEXT_COVERAGE`, so dropping the sanitiser from *either* fails the
guard.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/evidence.ts` | `sanitizeOptional` helper; `reviewEvidence` sanitises the comment before the reason check |
| `src/app-layer/usecases/gap-assessment-assignment.ts` | `submitAssignmentAnswers` sanitises `note` per answer, matching the sibling NIS2 seam |
| `tests/guardrails/sanitize-rich-text-coverage.test.ts` | both models moved `KNOWN_UNCOVERED` → `RICH_TEXT_COVERAGE`; cap lowered `2` → `0` |
| `tests/unit/security/sanitize-write-paths.test.ts` | six behavioural assertions across the two new call sites |

## Decisions

- **The stale reason was the actual finding.** `Nis2SelfAssessmentAnswer`
  carried "has NO write usecase yet — shipped as a DATA LAYER only". By the
  time it was read, two write usecases existed. Nothing checks that a
  ratchet entry's prose is still true, so the entry kept describing a
  world where there was no gap to close while a real one sat behind it.
  That is the argument for taking the cap to `0` rather than leaving a
  standing allowance: an empty bucket cannot hold a stale excuse.

- **The structural guard cannot prove this fix.** It asserts the usecase
  file imports and calls `sanitizePlainText`. With the `sanitizeOptional`
  wrapper the helper still calls it, so reverting `reviewEvidence` to
  `const comment = data.comment` leaves the guard green — verified by
  mutation. The behavioural assertions in `sanitize-write-paths.test.ts`
  are what actually hold the wiring; the guard holds the classification.

- **Sanitise-then-validate, not validate-then-sanitise**, for the rejection
  reason. The alternative ordering accepts markup as a reason and stores
  the empty string, which is the failure the check exists to prevent.

- **Blank notes normalise to `null`** on the delegated NIS2 path, matching
  `saveNis2Answer`, so the two seams cannot disagree about whether an
  unanswered note is `''` or `null`.
