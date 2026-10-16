# 2026-10-08 — Guard the directory tables against a second writer (Step 0a)

**Commit:** `91a276fa24` — "Guard the directory tables against a second writer
(Step 0a)" (#3247).

> **Written after the fact.** Reconstructed on 2026-10-16 from #3247's
> description, its diff and the guard's own docblock — not from doing the work.
> The step shipped without a note, which is part of what #3226 stayed open for.
> Everything below is drawn from those sources; nothing is recalled.

## What it did

Made it impossible to write `IdentityAccountLink` or `ConnectedIdentityAccount`
from anywhere but their existing seams — **before any legacy code existed** —
and put the subsystem's invariants where later sessions would read them.

Two files, 347 insertions, no production code:

| File | Role |
| --- | --- |
| `tests/guards/directory-identity-tables-single-write-seam.test.ts` | the guard (316 lines) |
| `CLAUDE.md` | a new "Legacy access recertification" section (31 lines) |

## Why this is not an ordinary write guard

`IdentityAccountLink` is what `findLeaverCandidates` consults to decide whether
a departing employee still holds access, and `ConnectedIdentityAccount.email` is
what the JML reconcile matches on byte for byte. In #3247's words, a row written
by a matcher that guessed **would not look wrong** — it would look like a
directory sync had found it.

That is why the guard lands before the code it constrains, "while the allowlist
is still three files and can be verified by reading them".

## The scan agreed with CLAUDE.md

The step's first instruction was to find every writer and **stop and report** if
reality differed from the seams `CLAUDE.md` names, rather than quietly allowlist
one. It did not differ:

| table | writers found | `CLAUDE.md` says |
| --- | --- | --- |
| `IdentityAccountLink` | `identity-account-link.ts` — `createMany` + two `updateMany` | same, nothing else |
| `ConnectedIdentityAccount` | `identity-sync.ts` (upsert + deprovision `updateMany`), `identity-account-protection.ts` (never-offboard flag) | same, nothing else |

1,771 files scanned under `src/`; no raw SQL touches either table.

## A guard rather than an ESLint rule, by the README's own criteria

`eslint-rules/README.md` puts syntax in a rule and notes an AST survives
reformatting where a regex does not. #3247 accepts that argument and gives two
reasons this falls the other side of the line:

- the population must come from **git**, not a config glob, so a file nobody
  added to a lint target cannot escape it;
- the assertion is a **cross-file registry** of seams that must stay in step
  with the tree, which the README assigns to `tests/guards/` explicitly.

The regex warning is answered rather than waved away: every detector runs over
`codeOf()`, and a test proves a docblock naming a banned call does not fail the
build — the precise failure the README cites for `detail-page-back-prop-ban`.

## Three detection paths, because one would be protection with two doors open

1. **Delegate call on any client.** The detector never anchors on the receiver,
   so `const c = prisma; c.identityAccountLink.update(…)` evades nothing.
2. **Transaction client.** Case 1 with a different receiver — covered by
   construction, and tested anyway, "because 'covered by construction' is a
   claim, not a test".
3. **Raw SQL.** `$executeRaw`, `$executeRawUnsafe`, and a `$queryRaw` carrying a
   mutating verb.

## The vacuity tests found two real bugs in the detector

This is the part worth reading, and it is why the step required feeding the
detector an in-memory second writer per path rather than trusting a green run
over a tree that already complied. Both holes were in paths the guard's *name*
promises to cover:

- **`$executeRaw` is a prefix of `$executeRawUnsafe`**, so scanning for each
  separately counted every `Unsafe` call twice. Replaced with one ordered
  alternation.
- **Tagged templates were invisible.** ``$queryRaw`DELETE FROM "IdentityAccountLink"` ``
  has no parentheses, and that is the *idiomatic* Prisma form — so the guard
  would have missed the commonest raw-SQL shape while claiming to cover raw SQL.

Both forms are now bounded on their own delimiters rather than a line count,
since a window is a budget the source can exceed just by being reformatted.

## What CLAUDE.md gained

Four binding invariants, kept short so later steps could extend them: legacy
code never writes a directory table; only a strong deterministic signal produces
`LINKED`; legacy data is untrusted input; and the design and phases documents
are the source of truth.

The first is what this guard enforces. The second became a type-level property
in Step 3b, where a `CandidateScorer` returns a `SupportingSignal` so an
extension cannot produce a strong signal however it scores.
