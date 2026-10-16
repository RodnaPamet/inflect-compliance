# 2026-10-08 — Persist structured HR names and real employee numbers (Step 0c)

**Commit:** `ea10b6658a` — "Persist structured HR names and real employee
numbers (Step 0c)" (#3277). Change class: **Significant** (schema migration).

> **Written after the fact.** Reconstructed on 2026-10-16 from #3277's
> description, its diff and the phases document — not from doing the work. The
> step shipped without a note, which is part of what #3228 stayed open for.

## Another discard, and one dangerous fallback avoided

Every HRIS already sent these and every provider already threw them away.
BambooHR's roster request asks for `firstName` and `lastName`; OrangeHRM's list
rows carry `firstName`, `middleName` and `lastName`; Workday's report template
carries `legalName` and `preferredName`. All were concatenated into `fullName`
and the parts dropped.

Keeping them makes name matching a comparison of **parts** rather than of one
flattened string. "Smith, John" and "John Smith" are the same person and
different strings, and a reconciler given only `fullName` has to guess which
half is the family name from word order that varies by locale and by HRIS.

| provider | given | middle | family | legal | preferred | `employeeNumber` from |
| --- | --- | --- | --- | --- | --- | --- |
| BambooHR | yes | — | yes | — | — | `employeeNumber` |
| OrangeHRM | yes | yes | yes | — | — | `employeeId` (the badge) |
| Workday | — | — | — | yes | yes | `employeeId` |

## `employeeNumber` has no fallback, and that is the most important line here

It is **NULL** whenever the HRIS has none, and it never reaches for `workEmail`.

`externalId` sits one line above it in every mapper and **does** fall back to
the work email. The asymmetry is deliberate: `externalId` is *provenance* —
nothing matches on it, so an email there is harmless. This is a **match
signal**, one of the few things CLAUDE.md invariant 2 permits to produce a
`LINKED` without a human confirming it. A fallback would let a work email
silently acquire the authority of a payroll identifier, and a legacy table full
of emails would begin auto-linking at LINK strength on something that is only
an address.

Two provider traps, both avoided and both tested:

- **OrangeHRM**: `empNumber` is the internal row id an update is *addressed
  by*; `employeeId` is the badge an HR administrator *types*. Confusing them
  would put an addressing handle into a matching column. `empNumber` stays in
  `hrisRecordId`.
- **Workday**: `externalId` may reach for `workerId`; `employeeNumber` may not.
  `workerId` is an internal surrogate, not a number HR issues to a person.

## Workday's given/family names stay null rather than splitting on whitespace

This is the decision worth carrying forward. A split would invent exactly the
guess these columns exist to remove, and the fixture contains "Grace Brewster
Hopper" against a `preferredName` of "Grace Hopper" **because that is the case
where the guess is wrong**.

> **Later note (2026-10-16).** The same reasoning is why
> `conventions.nameParts` derives a family name from a full name only at
> exactly two tokens. #3612 found that the family-name BLOCKER was indexing the
> roster with that strict rule while looking accounts up with a lenient one, so
> an account offering `Example` found nothing although the roster held a
> byte-identical name. The fix made the blocker lenient on both sides and left
> `nameParts` strict — because generating a username from a guess is a wrong
> link, while proposing one extra candidate is one extra comparison. The
> distinction this step drew between *provenance* and a *match signal* is the
> same distinction, one layer down.

## `fullName` did not move

The joiner pass builds mailbox addresses and display names from it, so a changed
derivation changes what gets created in a customer's directory. Each is pinned
against fixtures whose candidate fields all differ, for the reason Step 0b gives
about `email`.

## Files

Seven files, 429 insertions, two deletions: the schema and its migration, the
three roster mappers, `hris-sync.ts`, and `tests/unit/structured-hr-names.test.ts`
at 239 lines.
