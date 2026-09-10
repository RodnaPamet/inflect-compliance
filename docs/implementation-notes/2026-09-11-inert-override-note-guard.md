# 2026-09-11 — tying an inert override's prose to its real floor

**Branch:** `fix/2407-inert-override-note-guard` — `fix(deps): tie an inert
override's note to its real floor; raise hono past three new advisories`. No sha
is quoted: this note ships inside the commit it would name, so any value written
here would be the pre-amend one.

## Design

`tests/guards/override-registry.json` carries a `currentlyInert` field on the
three overrides that rewrite nothing today — `hono`, `@hono/node-server`, `tar`.
The field exists so an inert override is a DECLARED state rather than an
accident, and check C of `tests/guards/overrides-effective.test.ts` keeps the
declaration honest in both directions: inert-but-biting fails, biting-but-
undeclared fails.

What no check read was the note's PROSE, and the prose carries a load-bearing
number — the floor that re-applies if the package returns. `hono`'s note said
"the 4.12.27 floor" from the day it was written (#1779, `2604e5e14`,
2026-08-03). #1784 (`b0bbf610a`) raised the spec to `^4.12.34` the NEXT day and
left the sentence behind. It stayed wrong for 38 days — through a scheduled
freshness report naming hono as floor-vulnerable, and through an issue (#2407)
filed to DELETE the override on the strength of that report. Nothing was red,
because every existing check reads the spec or the registry facts, and the one
field describing the spec in words sat outside all of them. The note-goes-stale
decay `currentlyInert` was invented to prevent had happened to
`currentlyInert` itself.

Check E closes it. For every override carrying `currentlyInert`, it splits the
note into sentences, keeps the ones mentioning `floor`, collects the `X.Y.Z`
versions in those, and requires the override's real spec floor to be among
them.

## Files

| File | Role |
| --- | --- |
| `tests/guards/overrides-effective.test.ts` | new check E — inert note ⇄ actual spec floor, with both empty-selection populations pinned by exact equality |
| `tests/guards/override-registry.json` | `hono` advisory/`patchedFrom` → GHSA-gqvv-2mrq-wpjv / 4.13.5; `hono` + `tar` `currentlyInert` prose corrected |
| `package.json` | `overrides.hono` `^4.12.34` → `^4.13.5` |

## Decisions

- **The unit is the sentence, and `floor` is the only trigger word.** "Every
  version the note mentions must equal the floor" would be wrong, and `tar` is
  the counter-example: its note correctly states that npm's bundle carries a tar
  version BELOW the 7.5.21 floor — that is the whole reason the override cannot
  bite. A rule that reddened there would push someone to delete a real
  measurement to satisfy a schema. `pin` is deliberately NOT a trigger either:
  `tar`'s note says "bumping the `npm` pin to ^11.18.0", a sentence naming two
  versions, neither of them tar's floor.

- **History prose stays legal.** A note may narrate `4.12.27 -> 4.12.34 ->
  4.13.5` as long as the floor the override actually has is among the versions
  it claims. What fails is the case that bit us — the only floor the note names
  is one the override no longer has.

- **Both empty selections are pinned by exact-equality lists, not `>=` counts.**
  A count floor lets one entry go inert while another stops being inert and
  still reports green. Rewording the notes to avoid the word `floor` emits ZERO
  per-claim `it`s, so the subject list is asserted too — the mutation drops the
  suite from 84 tests to 82 and reddens that assertion rather than passing on an
  empty loop.

- **`patchedFrom` was set BEFORE the floor, exploiting check B.** Check B
  asserts the spec admits nothing below `patchedFrom`, so writing 4.13.5 there
  first turned it red and printed the floor it demanded — the number was read
  off a failure, not computed. The scheduled script had already printed the same
  number (`raise the floor to ^4.13.5`).

- **The floor bump changes no installed version.** `hono` has no lockfile key at
  all, so `npm install --package-lock-only` re-resolves to a zero-line diff. The
  override is a standing pin against the package's return, which is the reason
  #2407's deletion proposal was declined.
