# 2026-10-08 — Register TypeSafe AI as a proposed, inactive sub-processor (Step 6a)

**Commit:** `6764babb8` (#3246). Later corrected by `dd0496ade` (#3502).

> **Written after the fact.** Reconstructed on 2026-10-16 from the commit
> history, the phases document and the sub-processor register — not from doing
> the work. The step shipped without a note.

## What it did

Registered TypeSafe AI as a **proposed, inactive** sub-processor: the register
row, the customer notice, and the objection window — the paperwork that has to
exist *before* any tenant data could reach a third-party model, not after.

## Why two of its five criteria are still unticked, and should be

Both are annotated moot rather than outstanding:

- *"The row states the processor is inactive, and nothing in `src/` refers to
  TypeSafe."* The first half holds; the second is **deliberately false**. Six
  files under `src/` still name TypeSafe, so the register describes code that
  exists and the withdrawal stays one constant away from reversible. The
  criterion was written for the end of Step 6a, when both halves were true at
  once; that state has been left twice and returned to once.
- *"Legal approval is recorded on the pull request, including zero data
  retention in the signed DPA."* Moot since the 2026-10-14 withdrawal — no
  active processor, no processing to cover, no DPA to execute. **Dormant, not
  discharged**: it applies again unchanged if TypeSafe is ever reinstated, and
  the hard half comes back with it, namely whether SCCs plus a transfer impact
  assessment are an adequate basis for a vendor holding no DPF certification.

## The correction that followed

#3502 — "three places in `src/` still said TypeSafe was inactive, two days
after it was activated". The register and the code disagreed for two days, in
the direction that understates. That is the failure mode this whole subsystem's
documentation discipline exists to catch, and it was caught by reading rather
than by a test.

## Where it stands

`TYPESAFE_SUBPROCESSOR_ACTIVE` is `false`, and
`tenant-security-settings.ts` refuses `legacyMatchAiMode=EXTERNAL` while it is
— with a message saying the processor must appear in the sub-processor list
before any tenant's data may reach it, and that this is not a settings-page
decision. The adjudication path is intact at roughly 4,400 lines of `src/`
plus 6,700 of tests, held off by that one constant.
